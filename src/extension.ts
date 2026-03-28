import * as vscode from "vscode";
import { classifyComplexity, Tier, ClassifierMetadata } from "./classifier";
import { selectModelForTier, tierLabel, warmModelCache, getAnyCopilotModel } from "./models";
import { ensureCopilotPatched, restoreCopilotBackup } from "./patcher";

const VENDOR = "smart";

// ── Language Model Provider (transparent proxy) ──────────────────────

class SmartRouterProvider implements vscode.LanguageModelChatProvider {
  private readonly _log: vscode.LogOutputChannel;
  private _infoCallCount = 0;
  private _tokenModel: vscode.LanguageModelChat | null = null;
  private _lastConversationEntries: string[] = [];
  private _lastConversationTier: Tier = "simple";

  constructor(log: vscode.LogOutputChannel) {
    this._log = log;
  }

  // Return one virtual model that appears in the model picker
  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    this._infoCallCount++;
    if (this._infoCallCount <= 3) {
      this._log.info(
        `provideLanguageModelChatInformation CALLED (#${this._infoCallCount})`,
      );
    }
    const info = [
      {
        id: "smart-router-auto",
        name: "Smart Router",
        family: "smart-router",
        tooltip:
          "Auto-selects the best Copilot model based on prompt complexity",
        detail: "Auto-routes to the best model for your prompt",
        version: "1.0.0",
        maxInputTokens: 1000000,
        maxOutputTokens: 128000,
        isUserSelectable: true,
        isDefault: false,
        capabilities: { imageInput: true, toolCalling: true },
      } as vscode.LanguageModelChatInformation,
    ];
    return info;
  }

  // Classify → pick real model → proxy the entire request
  async provideLanguageModelChatResponse(
    _model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    this._log.info("provideLanguageModelChatResponse CALLED — routing request");

    // Extract last user text for complexity classification
    const prompt = extractPromptText(messages);

    // Build classifier metadata from available context
    const metadata: ClassifierMetadata = {
      messageCount: messages.length,
      hasTools: (options.tools?.length ?? 0) > 0,
      activeLanguageId: vscode.window.activeTextEditor?.document.languageId,
      referencedFileCount: extractReferencedFileCount(prompt),
    };

    const { tier, score, reasons } = classifyComplexity(prompt, [], metadata);

    // Never downgrade while the message history is extending the same conversation.
    const conversationEntries = normalizeConversationEntries(messages);
    const priorTier = isConversationContinuation(
      this._lastConversationEntries,
      conversationEntries,
    )
      ? this._lastConversationTier
      : "simple";
    const effectiveTier = clampTier(tier, priorTier);
    if (effectiveTier !== tier) {
      this._log.info(
        `Tier clamped: ${tier} → ${effectiveTier} (conversation continuity)`,
      );
    }
    this._lastConversationEntries = conversationEntries;
    this._lastConversationTier = effectiveTier;

    // Select the real Copilot model for this tier
    const selection = await selectModelForTier(effectiveTier);
    if (!selection) {
      progress.report(
        new vscode.LanguageModelTextPart(
          "No language models available. Is Copilot signed in?",
        ),
      );
      return;
    }

    const { model, family } = selection;
    this._log.info(
      `[${tierLabel(effectiveTier)}] score=${score} → ${family}` +
        (reasons.length ? ` (${reasons.join(", ")})` : ""),
    );

    // Convert provider-side messages → consumer-side messages
    const chatMessages = convertMessages(messages, this._log);
    const requestOptions = convertOptions(options);

    // Forward to the real model and stream everything back
    try {
      const response = await model.sendRequest(
        chatMessages,
        requestOptions,
        token,
      );
      for await (const part of response.stream) {
        if (token.isCancellationRequested) break;
        progress.report(part as vscode.LanguageModelResponsePart);
      }
    } catch (err) {
      // On error, attempt one escalation retry with next tier up
      const escalatedTier = escalateTier(effectiveTier);
      if (escalatedTier !== effectiveTier) {
        this._log.warn(
          `Model ${family} failed: ${err} — escalating to ${tierLabel(escalatedTier)}`,
        );
        const fallback = await selectModelForTier(escalatedTier);
        if (fallback && fallback.model.id !== model.id) {
          try {
            const retryResponse = await fallback.model.sendRequest(
              chatMessages,
              requestOptions,
              token,
            );
            for await (const part of retryResponse.stream) {
              if (token.isCancellationRequested) break;
              progress.report(part as vscode.LanguageModelResponsePart);
            }
            return;
          } catch (retryErr) {
            this._log.error(
              `Escalated model ${fallback.family} also failed: ${retryErr}`,
            );
            throw retryErr;
          }
        }
        if (fallback && fallback.model.id === model.id) {
          this._log.warn(
            `Escalation skipped because ${fallback.family} resolves to the same model`,
          );
        }
      }
      // Re-throw if escalation also failed or wasn't possible
      throw err;
    }
  }

  // Delegate token counting to a cached Copilot model (avoids repeated selectChatModels)
  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ): Promise<number> {
    if (!this._tokenModel) {
      this._tokenModel = (await getAnyCopilotModel()) ?? null;
    }
    if (this._tokenModel) {
      const str = stringifyTokenInput(text);
      return this._tokenModel.countTokens(str, token);
    }
    return Math.ceil(stringifyTokenInput(text).length / 4);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

const TIER_ORDER: Tier[] = ["simple", "medium", "complex"];

function clampTier(current: Tier, minimum: Tier): Tier {
  const currentIdx = TIER_ORDER.indexOf(current);
  const minIdx = TIER_ORDER.indexOf(minimum);
  return currentIdx >= minIdx ? current : minimum;
}

function escalateTier(tier: Tier): Tier {
  const idx = TIER_ORDER.indexOf(tier);
  return idx < TIER_ORDER.length - 1 ? TIER_ORDER[idx + 1] : tier;
}

/** Find the last user message that contains actual text (not just tool results). */
function extractPromptText(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== vscode.LanguageModelChatMessageRole.User) continue;
    const texts = msg.content
      .map((part) => getTextPartValue(part))
      .filter((value): value is string => value !== undefined);
    if (texts.length > 0) return texts.join("");
  }
  return "";
}

function normalizeConversationEntries(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): string[] {
  return messages.map((msg) => `${msg.role}:${stringifyTokenInput(msg)}`);
}

function isConversationContinuation(
  previousEntries: readonly string[],
  currentEntries: readonly string[],
): boolean {
  if (previousEntries.length === 0) return false;
  if (currentEntries.length < previousEntries.length) return false;
  for (let index = 0; index < previousEntries.length; index++) {
    if (previousEntries[index] !== currentEntries[index]) {
      return false;
    }
  }
  return true;
}

const FILE_REFERENCE_PATTERNS: readonly RegExp[] = [
  /#file:([^\s`"')]+)/gi,
  /(?:^|[\s("'`])((?:[a-zA-Z]:)?(?:[./\\][^\s"'`)]+|[\w.-]+(?:[\\/][\w.-]+)+)\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|cpp|c|cs|json|md|ya?ml))/gi,
];

function extractReferencedFileCount(prompt: string): number {
  const matches = new Set<string>();
  for (const pattern of FILE_REFERENCE_PATTERNS) {
    for (const match of prompt.matchAll(pattern)) {
      const candidate = (match[1] ?? match[0]).trim();
      if (candidate) {
        matches.add(candidate.toLowerCase());
      }
    }
  }
  return matches.size;
}

function stringifyTokenInput(
  text: string | vscode.LanguageModelChatRequestMessage,
): string {
  if (typeof text === "string") {
    return text;
  }

  return text.content
    .map((part) => {
      const textValue = getTextPartValue(part);
      if (textValue !== undefined) return textValue;

      const toolCall = getToolCallInfo(part);
      if (toolCall) return `[tool-call:${toolCall.name}]`;

      const toolResult = getToolResultInfo(part);
      if (toolResult) return `[tool-result:${toolResult.callId}]`;

      const dataPart = getDataPartInfo(part);
      if (dataPart) return `[data:${dataPart.mimeType}]`;

      return "[unknown-part]";
    })
    .join("");
}

type AssistantProxyPart =
  | vscode.LanguageModelTextPart
  | vscode.LanguageModelDataPart
  | vscode.LanguageModelToolCallPart;

type UserProxyPart =
  | vscode.LanguageModelTextPart
  | vscode.LanguageModelDataPart
  | vscode.LanguageModelToolResultPart;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getTextPartValue(part: unknown): string | undefined {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }

  if (isObjectRecord(part) && typeof part.value === "string") {
    return part.value;
  }

  return undefined;
}

function getToolCallInfo(
  part: unknown,
): { callId: string; name: string; input: object } | undefined {
  if (part instanceof vscode.LanguageModelToolCallPart) {
    return { callId: part.callId, name: part.name, input: part.input };
  }

  if (
    isObjectRecord(part) &&
    typeof part.callId === "string" &&
    typeof part.name === "string" &&
    isObjectRecord(part.input)
  ) {
    return {
      callId: part.callId,
      name: part.name,
      input: part.input,
    };
  }

  return undefined;
}

function getToolResultInfo(
  part: unknown,
): { callId: string; content: unknown[] } | undefined {
  if (part instanceof vscode.LanguageModelToolResultPart) {
    return { callId: part.callId, content: [...part.content] };
  }

  if (
    isObjectRecord(part) &&
    typeof part.callId === "string" &&
    Array.isArray(part.content) &&
    typeof part.name !== "string"
  ) {
    return {
      callId: part.callId,
      content: [...part.content],
    };
  }

  return undefined;
}

function getDataPartInfo(
  part: unknown,
): { data: Uint8Array; mimeType: string } | undefined {
  if (part instanceof vscode.LanguageModelDataPart) {
    return { data: part.data, mimeType: part.mimeType };
  }

  if (
    isObjectRecord(part) &&
    part.data instanceof Uint8Array &&
    typeof part.mimeType === "string"
  ) {
    return {
      data: part.data,
      mimeType: part.mimeType,
    };
  }

  return undefined;
}

function normalizeAssistantPart(part: unknown): AssistantProxyPart | undefined {
  const textValue = getTextPartValue(part);
  if (textValue !== undefined) {
    return new vscode.LanguageModelTextPart(textValue);
  }

  const dataPart = getDataPartInfo(part);
  if (dataPart) {
    return new vscode.LanguageModelDataPart(dataPart.data, dataPart.mimeType);
  }

  const toolCall = getToolCallInfo(part);
  if (toolCall) {
    return new vscode.LanguageModelToolCallPart(
      toolCall.callId,
      toolCall.name,
      toolCall.input,
    );
  }

  return undefined;
}

function normalizeUserPart(part: unknown): UserProxyPart | undefined {
  const textValue = getTextPartValue(part);
  if (textValue !== undefined) {
    return new vscode.LanguageModelTextPart(textValue);
  }

  const dataPart = getDataPartInfo(part);
  if (dataPart) {
    return new vscode.LanguageModelDataPart(dataPart.data, dataPart.mimeType);
  }

  const toolResult = getToolResultInfo(part);
  if (toolResult) {
    return new vscode.LanguageModelToolResultPart(
      toolResult.callId,
      toolResult.content,
    );
  }

  return undefined;
}

/** Convert provider-side request messages to consumer-side LanguageModelChatMessage[]. */
function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  log: vscode.LogOutputChannel,
): vscode.LanguageModelChatMessage[] {
  const sanitizedMessages = sanitizeMessagesForProxy(messages, log);
  return sanitizedMessages.map((msg) => {
    const content = [...msg.content];
    if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
      return vscode.LanguageModelChatMessage.Assistant(
        content as AssistantProxyPart[],
        msg.name ?? undefined,
      );
    }

    return vscode.LanguageModelChatMessage.User(
      content as UserProxyPart[],
      msg.name ?? undefined,
    );
  });
}

function sanitizeMessagesForProxy(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  log: vscode.LogOutputChannel,
): vscode.LanguageModelChatRequestMessage[] {
  const normalizedMessages: vscode.LanguageModelChatRequestMessage[] = [];
  let strippedInvalidParts = 0;

  for (const message of messages) {
    if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
      const nextContent: AssistantProxyPart[] = [];

      for (const part of message.content) {
        const normalized = normalizeAssistantPart(part);
        if (!normalized) {
          strippedInvalidParts++;
          continue;
        }

        nextContent.push(normalized);
      }

      if (nextContent.length === 0) {
        continue;
      }

      normalizedMessages.push({
        role: message.role,
        name: message.name,
        content: nextContent,
      });
      continue;
    }

    const nextContent: UserProxyPart[] = [];
    for (const part of message.content) {
      const normalized = normalizeUserPart(part);
      if (!normalized) {
        strippedInvalidParts++;
        continue;
      }

      nextContent.push(normalized);
    }

    if (nextContent.length === 0) {
      continue;
    }

    normalizedMessages.push({
      role: vscode.LanguageModelChatMessageRole.User,
      name: message.name,
      content: nextContent,
    });
  }

  const {
    messages: sanitized,
    strippedToolCalls,
    strippedToolResults,
  } = stripOrphanedToolParts(normalizedMessages);

  if (strippedToolCalls > 0) {
    log.warn(
      `Removed ${strippedToolCalls} orphaned tool call part(s) before proxying request`,
    );
  }

  if (strippedToolResults > 0) {
    log.warn(
      `Removed ${strippedToolResults} orphaned tool result part(s) before proxying request`,
    );
  }

  if (strippedInvalidParts > 0) {
    log.warn(
      `Removed ${strippedInvalidParts} invalid or unsupported request part(s) before proxying request`,
    );
  }

  return sanitized;
}

function stripOrphanedToolParts(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): {
  messages: vscode.LanguageModelChatRequestMessage[];
  strippedToolCalls: number;
  strippedToolResults: number;
} {
  const sanitized: vscode.LanguageModelChatRequestMessage[] = [];
  let strippedToolCalls = 0;
  let strippedToolResults = 0;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];

    if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
      const toolCallIds = new Set<string>();
      for (const part of message.content as readonly AssistantProxyPart[]) {
        const toolCall = getToolCallInfo(part);
        if (toolCall) {
          toolCallIds.add(toolCall.callId);
        }
      }

      if (toolCallIds.size === 0) {
        sanitized.push(message);
        continue;
      }

      const nextMessage = messages[index + 1];
      const nextUserContent: UserProxyPart[] = [];
      const matchedToolResultIds = new Set<string>();

      if (nextMessage?.role === vscode.LanguageModelChatMessageRole.User) {
        for (const part of nextMessage.content as readonly UserProxyPart[]) {
          const toolResult = getToolResultInfo(part);
          if (!toolResult) {
            nextUserContent.push(part);
            continue;
          }

          if (toolCallIds.has(toolResult.callId)) {
            nextUserContent.push(part);
            matchedToolResultIds.add(toolResult.callId);
          } else {
            strippedToolResults++;
          }
        }
      }

      const nextAssistantContent: AssistantProxyPart[] = [];
      for (const part of message.content as readonly AssistantProxyPart[]) {
        const toolCall = getToolCallInfo(part);
        if (!toolCall) {
          nextAssistantContent.push(part);
          continue;
        }

        if (matchedToolResultIds.has(toolCall.callId)) {
          nextAssistantContent.push(part);
        } else {
          strippedToolCalls++;
        }
      }

      if (nextAssistantContent.length > 0) {
        sanitized.push({
          role: message.role,
          name: message.name,
          content: nextAssistantContent,
        });
      }

      if (nextMessage?.role === vscode.LanguageModelChatMessageRole.User) {
        if (nextUserContent.length > 0) {
          sanitized.push({
            role: nextMessage.role,
            name: nextMessage.name,
            content: nextUserContent,
          });
        }
        index++;
      }

      continue;
    }

    if (message.role === vscode.LanguageModelChatMessageRole.User) {
      const nextContent: UserProxyPart[] = [];

      for (const part of message.content as readonly UserProxyPart[]) {
        if (getToolResultInfo(part)) {
          strippedToolResults++;
          continue;
        }

        nextContent.push(part);
      }

      if (nextContent.length > 0) {
        sanitized.push({
          role: message.role,
          name: message.name,
          content: nextContent,
        });
      }

      continue;
    }

    sanitized.push(message);
  }

  return { messages: sanitized, strippedToolCalls, strippedToolResults };
}

/** Convert provider-side options to consumer-side request options. */
function convertOptions(
  options: vscode.ProvideLanguageModelChatResponseOptions,
): vscode.LanguageModelChatRequestOptions {
  const result: vscode.LanguageModelChatRequestOptions = {};
  if (options.tools?.length) result.tools = [...options.tools];
  if (options.toolMode != null) result.toolMode = options.toolMode;
  if (options.modelOptions) result.modelOptions = { ...options.modelOptions };
  return result;
}

// ── Activation ───────────────────────────────────────────────────────

export function activate(ctx: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("Smart Router", { log: true });
  ctx.subscriptions.push(log);

  // Register as a language model provider — this is the entire extension
  const provider = new SmartRouterProvider(log);
  log.info("Registering language model provider for vendor: " + VENDOR);
  ctx.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
  );
  log.info("Provider registered successfully");

  // Pre-warm the model cache so first request is instant
  warmModelCache().catch(() => {});

  // Helper: enumerate all models visible to this extension
  async function enumerateModels(label: string): Promise<void> {
    try {
      const all = await vscode.lm.selectChatModels({});
      log.info(
        `[${label}] selectChatModels({}) returned ${all.length} model(s):`,
      );
      let foundSmart = false;
      for (const m of all) {
        const line = `  - ${m.vendor}/${m.id} (${m.name}, family=${m.family})`;
        log.info(line);
        if (m.vendor === VENDOR) foundSmart = true;
      }
      if (!foundSmart) {
        log.warn(`[${label}] ⚠ No models with vendor='${VENDOR}' found!`);
      } else {
        log.info(`[${label}] ✓ Smart Router model found in selectChatModels`);
      }
    } catch (err) {
      log.warn(`[${label}] selectChatModels({}) failed: ${err}`);
    }

    // Also try vendor-specific query
    try {
      const smart = await vscode.lm.selectChatModels({ vendor: VENDOR });
      log.info(
        `[${label}] selectChatModels({vendor:'${VENDOR}'}) returned ${smart.length} model(s)`,
      );
      for (const m of smart) {
        log.info(`  - ${m.vendor}/${m.id} (${m.name})`);
      }
    } catch (err) {
      log.warn(
        `[${label}] selectChatModels({vendor:'${VENDOR}'}) failed: ${err}`,
      );
    }
  }

  // Immediate resolution attempt
  enumerateModels("immediate");

  // Delayed retry — in case there's a startup race
  setTimeout(() => enumerateModels("delayed-5s"), 5000);
  setTimeout(() => enumerateModels("delayed-15s"), 15000);

  // Diagnostic command: show model state in a notification
  ctx.subscriptions.push(
    vscode.commands.registerCommand("smart-router.diagnose", async () => {
      log.info("=== DIAGNOSTIC START ===");
      const lines: string[] = [];

      try {
        const all = await vscode.lm.selectChatModels({});
        lines.push(`Total models from selectChatModels({}): ${all.length}`);
        const smartModels = all.filter((m) => m.vendor === VENDOR);
        lines.push(
          `Models with vendor='${VENDOR}': ${smartModels.length}`,
        );
        for (const m of smartModels) {
          lines.push(`  ${m.vendor}/${m.id} - ${m.name}`);
        }

        const allVendors = [...new Set(all.map((m) => m.vendor))];
        lines.push(`All vendors: ${allVendors.join(", ")}`);
      } catch (err) {
        lines.push(`selectChatModels failed: ${err}`);
      }

      const msg = lines.join("\n");
      log.info(msg);
      log.info("=== DIAGNOSTIC END ===");

      // Show as a quick pick so user can read it
      const items = lines.map((l) => ({ label: l }));
      await vscode.window.showQuickPick(items, {
        title: "Smart Router Diagnostics",
        canPickMany: false,
      });
    }),
  );

  // Quick-open command (Ctrl+Alt+S) → open Copilot Chat
  ctx.subscriptions.push(
    vscode.commands.registerCommand("smart-router.openChat", () =>
      vscode.commands.executeCommand("workbench.action.chat.open"),
    ),
  );

  // Status bar button
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.text = "$(hubot) Smart";
  statusBar.tooltip = "Open Copilot Chat (Ctrl+Alt+S)";
  statusBar.command = "smart-router.openChat";
  statusBar.show();
  ctx.subscriptions.push(statusBar);

  // ── Copilot Chat patching (model picker integration) ─────────────

  // Patch command
  ctx.subscriptions.push(
    vscode.commands.registerCommand("smart-router.patch", async () => {
      log.info("Manual patch requested");
      await patchCopilotChat(log, statusBar);
    }),
  );

  // Unpatch command
  ctx.subscriptions.push(
    vscode.commands.registerCommand("smart-router.unpatch", async () => {
      log.info("Unpatch requested");
      if (restoreCopilotBackup(log)) {
        const action = await vscode.window.showInformationMessage(
          "Smart Router patch removed. Reload to apply.",
          "Reload Window",
        );
        if (action === "Reload Window") {
          vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      } else {
        vscode.window.showWarningMessage("No backup found to restore.");
      }
    }),
  );

  // Auto-patch on activation
  patchCopilotChat(log, statusBar);

  // Watch for Copilot Chat extension updates and re-patch automatically
  ctx.subscriptions.push(
    vscode.extensions.onDidChange(() => {
      const copilot = vscode.extensions.getExtension("github.copilot-chat");
      if (copilot) {
        log.info("Extensions changed — checking if Copilot Chat needs re-patching");
        setTimeout(() => patchCopilotChat(log, statusBar), 3000);
      }
    }),
  );

  log.info(
    "Smart Router activated — select 'Smart Router' in the Copilot model picker",
  );
}

async function patchCopilotChat(
  log: vscode.LogOutputChannel,
  statusBar: vscode.StatusBarItem,
): Promise<void> {
  try {
    const result = await ensureCopilotPatched(log);
    switch (result) {
      case "already-patched":
        statusBar.text = "$(hubot) Smart ✓";
        statusBar.tooltip = "Smart Router active — model picker patched";
        break;
      case "patched":
        statusBar.text = "$(hubot) Smart ↻";
        statusBar.tooltip = "Smart Router patched — reload needed";
        const action = await vscode.window.showInformationMessage(
          "Smart Router has been added to the Copilot model picker. " +
            "Reload VS Code to see it.",
          "Reload Window",
          "Later",
        );
        if (action === "Reload Window") {
          vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
        break;
      case "failed":
        statusBar.text = "$(hubot) Smart ⚠";
        statusBar.tooltip =
          "Smart Router — could not patch Copilot Chat (check output log)";
        break;
    }
  } catch (err) {
    log.error("Patch error: " + err);
    statusBar.text = "$(hubot) Smart ⚠";
  }
}

export function deactivate() {}
