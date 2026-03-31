import * as vscode from "vscode";
import type { Tier } from "./classifier";

// ── Default fallback chains (overridden by user settings) ────────────
const DEFAULT_CHAINS: Record<Tier, string[]> = {
  simple: ["gpt-5.4-mini", "claude-haiku-4.5"],
  medium: ["claude-sonnet-4.6", "gpt-5.4"],
  complex: ["claude-opus-4.6"],
};

/** Read the user-configured chain for a tier, falling back to defaults. */
function getChain(tier: Tier): string[] {
  const cfg = vscode.workspace.getConfiguration("smart-router.models");
  const userChain = cfg.get<string[]>(tier);
  return userChain && userChain.length > 0 ? userChain : DEFAULT_CHAINS[tier];
}

/** Read the user-configured model blocklist. */
function getBlocklist(): string[] {
  return vscode.workspace.getConfiguration("smart-router").get<string[]>("blocklist") ?? [];
}

// ── Cached model list (avoids repeated selectChatModels calls) ───────
let _cachedModels: vscode.LanguageModelChat[] | null = null;
let _cacheTime = 0;
const CACHE_TTL = 30_000; // 30 seconds

async function getCopilotModels(): Promise<vscode.LanguageModelChat[]> {
  const now = Date.now();
  if (_cachedModels && now - _cacheTime < CACHE_TTL) return _cachedModels;
  _cachedModels = await vscode.lm.selectChatModels({ vendor: "copilot" });
  _cacheTime = now;
  return _cachedModels;
}

/** Pre-warm the model cache so the first request pays no cold-start penalty. */
export async function warmModelCache(): Promise<void> {
  await getCopilotModels();
}

/** Return any cached copilot model for token counting (no async penalty if warm). */
export async function getAnyCopilotModel(): Promise<vscode.LanguageModelChat | undefined> {
  const models = await getCopilotModels();
  return models[0];
}

export interface ModelSelection {
  model: vscode.LanguageModelChat;
  family: string;
}

function normalizeModelName(value: string): string {
  return value.trim().toLowerCase();
}

function tokenizeModelName(value: string): string[] {
  return normalizeModelName(value).match(/[a-z]+|\d+(?:\.\d+)?/g) ?? [];
}

function scoreModelMatch(
  requestedFamily: string,
  model: vscode.LanguageModelChat,
): number {
  const requestedTokens = tokenizeModelName(requestedFamily);
  const candidateTokens = new Set([
    ...tokenizeModelName(model.family),
    ...tokenizeModelName(model.id),
  ]);

  let score = 0;
  for (const token of requestedTokens) {
    if (candidateTokens.has(token)) {
      score++;
    }
  }

  const normalizedRequested = normalizeModelName(requestedFamily);
  const normalizedFamily = normalizeModelName(model.family);
  const normalizedId = normalizeModelName(model.id);
  if (normalizedFamily.startsWith(normalizedRequested) || normalizedId.startsWith(normalizedRequested)) {
    score += 2;
  }

  return score;
}

/**
 * Walk the (user-configurable) fallback chain for `tier` and return the
 * first model that is available. Uses cached model list — single async
 * call at most. Respects the user-configured blocklist.
 */
export async function selectModelForTier(
  tier: Tier,
): Promise<ModelSelection | undefined> {
  const chain = getChain(tier);
  const blocklist = getBlocklist();
  const allModels = await getCopilotModels();

  // Filter out blocklisted models
  const models = blocklist.length > 0
    ? allModels.filter((m) => !blocklist.includes(m.family))
    : allModels;

  for (const family of chain) {
    const normalizedFamily = normalizeModelName(family);
    const exact = models.find(
      (m) =>
        normalizeModelName(m.family) === normalizedFamily ||
        normalizeModelName(m.id) === normalizedFamily,
    );
    if (exact) return { model: exact, family };

    const ranked = models
      .map((model) => ({ model, score: scoreModelMatch(family, model) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);
    if (ranked.length > 0) {
      return { model: ranked[0].model, family: ranked[0].model.family };
    }
  }

  return models.length > 0 ? { model: models[0], family: models[0].family } : undefined;
}

/** Return the configured chains for display purposes. */
export function getConfiguredChains(): Record<Tier, string[]> {
  return {
    simple: getChain("simple"),
    medium: getChain("medium"),
    complex: getChain("complex"),
  };
}

/** Human-readable label for a tier. */
export function tierLabel(tier: Tier): string {
  switch (tier) {
    case "simple":
      return "Simple";
    case "medium":
      return "Medium";
    case "complex":
      return "Complex";
  }
}

/** List all models currently available from Copilot. */
export async function listAvailableModels(): Promise<string[]> {
  const models = await getCopilotModels();
  return [...new Set(models.map((m) => `${m.family} (${m.id})`))];
}
