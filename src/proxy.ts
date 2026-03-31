import * as vscode from "vscode";

// ── Part type aliases ─────────────────────────────────────────────────

type AssistantProxyPart =
  | vscode.LanguageModelTextPart
  | vscode.LanguageModelDataPart
  | vscode.LanguageModelToolCallPart;

type UserProxyPart =
  | vscode.LanguageModelTextPart
  | vscode.LanguageModelDataPart
  | vscode.LanguageModelToolResultPart;

// ── Duck-typing helpers (VS Code API types can vary at runtime) ───────

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

// ── Stringify helper (used for token counting and conversation fingerprinting) ──

export function stringifyTokenInput(
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

// ── Orphan debug types ───────────────────────────────────────────────

/** Details about a single orphaned tool call that was stripped. */
interface OrphanedToolCallDetail {
  /** The call ID of the stripped tool call. */
  callId: string;
  /** The tool name that was invoked. */
  name: string;
  /** Reason the call was considered orphaned. */
  reason: "no-matching-result-in-next-messages";
  /** First 120 chars of serialised input for inspection. */
  inputSnippet: string;
  /** Zero-based index of the assistant message in the sanitized array. */
  messageIndex: number;
}

/** Details about a single orphaned tool result that was stripped. */
interface OrphanedToolResultDetail {
  /** The call ID of the stripped tool result. */
  callId: string;
  /** Reason the result was considered orphaned. */
  reason:
    | "no-matching-call-in-previous-assistant-message"
    | "result-in-user-message-without-preceding-assistant-call";
  /** First 120 chars of serialised content for inspection. */
  contentSnippet: string;
  /** Zero-based index of the user message in the sanitized array. */
  messageIndex: number;
}

/** Return value of `stripOrphanedToolParts`, now including per-item debug detail. */
interface StripOrphanedResult {
  messages: vscode.LanguageModelChatRequestMessage[];
  strippedToolCalls: number;
  strippedToolResults: number;
  /** Full detail for each stripped tool call — populated when debug logging is on. */
  orphanedCallDetails: OrphanedToolCallDetail[];
  /** Full detail for each stripped tool result — populated when debug logging is on. */
  orphanedResultDetails: OrphanedToolResultDetail[];
}

function snippetify(value: unknown, maxLen = 120): string {
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return s.length <= maxLen ? s : s.slice(0, maxLen) + "…";
  } catch {
    return String(value).slice(0, maxLen);
  }
}

function stripOrphanedToolParts(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): StripOrphanedResult {
  const sanitized: vscode.LanguageModelChatRequestMessage[] = [];
  let strippedToolCalls = 0;
  let strippedToolResults = 0;
  const orphanedCallDetails: OrphanedToolCallDetail[] = [];
  const orphanedResultDetails: OrphanedToolResultDetail[] = [];

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

      // ── Scan ALL consecutive user messages for matching tool results ──
      const matchedToolResultIds = new Set<string>();
      const collectedUserMessages: {
        original: vscode.LanguageModelChatRequestMessage;
        filteredContent: UserProxyPart[];
        originalIndex: number;
      }[] = [];

      let lookahead = index + 1;
      while (
        lookahead < messages.length &&
        messages[lookahead].role === vscode.LanguageModelChatMessageRole.User
      ) {
        const userMsg = messages[lookahead];
        const filteredContent: UserProxyPart[] = [];

        for (const part of userMsg.content as readonly UserProxyPart[]) {
          const toolResult = getToolResultInfo(part);
          if (!toolResult) {
            filteredContent.push(part);
            continue;
          }

          if (toolCallIds.has(toolResult.callId)) {
            filteredContent.push(part);
            matchedToolResultIds.add(toolResult.callId);
          } else {
            strippedToolResults++;
            orphanedResultDetails.push({
              callId: toolResult.callId,
              reason: "no-matching-call-in-previous-assistant-message",
              contentSnippet: snippetify(toolResult.content),
              messageIndex: lookahead,
            });
          }
        }

        collectedUserMessages.push({
          original: userMsg,
          filteredContent,
          originalIndex: lookahead,
        });
        lookahead++;
      }

      // ── Back-filter assistant tool calls to only keep matched ones ──
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
          orphanedCallDetails.push({
            callId: toolCall.callId,
            name: toolCall.name,
            reason: "no-matching-result-in-next-messages",
            inputSnippet: snippetify(toolCall.input),
            messageIndex: index,
          });
        }
      }

      if (nextAssistantContent.length > 0) {
        sanitized.push({
          role: message.role,
          name: message.name,
          content: nextAssistantContent,
        });
      }

      // ── Emit all consumed user messages (preserving non-tool-result parts) ──
      for (const entry of collectedUserMessages) {
        if (entry.filteredContent.length > 0) {
          sanitized.push({
            role: entry.original.role,
            name: entry.original.name,
            content: entry.filteredContent,
          });
        }
      }

      // Advance index past all the user messages we just consumed
      index = lookahead - 1;

      continue;
    }

    if (message.role === vscode.LanguageModelChatMessageRole.User) {
      const nextContent: UserProxyPart[] = [];

      for (const part of message.content as readonly UserProxyPart[]) {
        const toolResult = getToolResultInfo(part);
        if (toolResult) {
          strippedToolResults++;
          orphanedResultDetails.push({
            callId: toolResult.callId,
            reason:
              "result-in-user-message-without-preceding-assistant-call",
            contentSnippet: snippetify(toolResult.content),
            messageIndex: index,
          });
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

  return {
    messages: sanitized,
    strippedToolCalls,
    strippedToolResults,
    orphanedCallDetails,
    orphanedResultDetails,
  };
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
    orphanedCallDetails,
    orphanedResultDetails,
  } = stripOrphanedToolParts(normalizedMessages);

  if (strippedToolCalls > 0) {
    log.warn(
      `Removed ${strippedToolCalls} orphaned tool call part(s) before proxying request`,
    );
    // Debug-level detail — only visible when output channel log level is set to Debug/Trace.
    // Each line shows: msgIndex | callId | toolName | reason | inputSnippet
    for (const d of orphanedCallDetails) {
      log.debug(
        `  [orphaned-call]  msg#${d.messageIndex}  callId=${d.callId}  tool=${d.name}  reason=${d.reason}  input=${d.inputSnippet}`,
      );
    }
  }

  if (strippedToolResults > 0) {
    log.warn(
      `Removed ${strippedToolResults} orphaned tool result part(s) before proxying request`,
    );
    // Debug-level detail — only visible when output channel log level is set to Debug/Trace.
    // Each line shows: msgIndex | callId | reason | contentSnippet
    for (const d of orphanedResultDetails) {
      log.debug(
        `  [orphaned-result]  msg#${d.messageIndex}  callId=${d.callId}  reason=${d.reason}  content=${d.contentSnippet}`,
      );
    }
  }

  if (strippedInvalidParts > 0) {
    log.warn(
      `Removed ${strippedInvalidParts} invalid or unsupported request part(s) before proxying request`,
    );
  }

  // Always-on debug summary: count tool calls & results being proxied
  // so we can verify nothing is silently lost.
  let proxiedToolCalls = 0;
  let proxiedToolResults = 0;
  const toolCallNames: string[] = [];
  const toolResultCallIds: string[] = [];
  for (const msg of sanitized) {
    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelToolCallPart) {
        proxiedToolCalls++;
        toolCallNames.push(part.name);
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        proxiedToolResults++;
        toolResultCallIds.push(part.callId);
      }
    }
  }
  log.debug(
    `[proxy-summary] messages=${sanitized.length}  toolCalls=${proxiedToolCalls}  toolResults=${proxiedToolResults}  strippedCalls=${strippedToolCalls}  strippedResults=${strippedToolResults}`,
  );
  if (toolCallNames.length > 0) {
    log.debug(
      `[proxy-tools] ${toolCallNames.join(", ")}`,
    );
  }

  return sanitized;
}

/** Convert provider-side request messages to consumer-side LanguageModelChatMessage[]. */
export function convertMessages(
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

/** Convert provider-side options to consumer-side request options. */
export function convertOptions(
  options: vscode.ProvideLanguageModelChatResponseOptions,
): vscode.LanguageModelChatRequestOptions {
  const result: vscode.LanguageModelChatRequestOptions = {};
  if (options.tools?.length) result.tools = [...options.tools];
  if (options.toolMode != null) result.toolMode = options.toolMode;
  if (options.modelOptions) result.modelOptions = { ...options.modelOptions };
  return result;
}
