import type * as vscode from "vscode";

export type Tier = "simple" | "medium" | "complex";

export interface ClassificationResult {
  tier: Tier;
  score: number;
  reasons: string[];
}

/** Optional metadata from the extension for richer classification. */
export interface ClassifierMetadata {
  /** Number of messages in the conversation so far. */
  messageCount?: number;
  /** Whether tools are present (Agent mode). */
  hasTools?: boolean;
  /** Language ID of the active editor file. */
  activeLanguageId?: string;
  /** Estimated number of referenced files inferred from the prompt context. */
  referencedFileCount?: number;
}

interface Signal {
  points: number;
  reason: string;
}

// ── Word-count complexity ────────────────────────────────────────────
function scoreLength(prompt: string): Signal {
  const words = prompt.split(/\s+/).filter(Boolean).length;
  if (words > 300) return { points: 3, reason: `long message (${words} words)` };
  if (words > 120) return { points: 2, reason: `moderate length (${words} words)` };
  if (words > 40) return { points: 1, reason: `some length (${words} words)` };
  return { points: 0, reason: "" };
}

// ── Code presence ────────────────────────────────────────────────────
function scoreCode(prompt: string): Signal {
  const codeBlocks = prompt.match(/```[\s\S]*?```/g) ?? [];
  if (codeBlocks.length === 0) return { points: 0, reason: "" };

  const totalCodeLines = codeBlocks.reduce(
    (sum, block) => sum + block.split("\n").length,
    0,
  );

  if (totalCodeLines > 40 || codeBlocks.length >= 3)
    return { points: 2, reason: `${codeBlocks.length} code block(s), ~${totalCodeLines} lines` };
  return { points: 1, reason: `${codeBlocks.length} code block(s)` };
}

// ── Complexity keywords ──────────────────────────────────────────────
const COMPLEXITY_KEYWORDS: readonly string[] = [
  // architecture & design
  "architect", "architecture", "design pattern", "microservice", "system design",
  "trade-off", "tradeoff", "scalab", "distributed",
  // deep reasoning
  "prove", "proof", "theorem", "formal", "correctness",
  "algorithm", "complexity", "big-o", "dynamic programming",
  "optimize", "optimization", "performance", "benchmark",
  // security & reliability
  "security", "vulnerabilit", "exploit", "authentication", "authorization",
  "encrypt", "cipher",
  // refactoring & migration
  "refactor", "migrate", "migration", "rewrite", "redesign",
  // multi-step & planning
  "step by step", "step-by-step", "plan", "roadmap", "strategy",
  "compare and contrast", "pros and cons", "advantages and disadvantages",
  // advanced topics
  "concurren", "parallel", "deadlock", "race condition",
  "compiler", "parser", "abstract syntax", "type system",
  "machine learning", "neural", "training", "fine-tun",
];

/** Strip code blocks and inline code so keywords in pasted code don't inflate the score. */
function stripCode(prompt: string): string {
  return prompt
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "");
}

function scoreKeywords(prompt: string): Signal {
  const lower = stripCode(prompt).toLowerCase();
  const matched = COMPLEXITY_KEYWORDS.filter((kw) => lower.includes(kw));
  if (matched.length === 0) return { points: 0, reason: "" };
  const pts = Math.min(matched.length, 3);
  const display = matched.slice(0, 3).join(", ");
  return {
    points: pts,
    reason: `complexity keywords: ${display}${matched.length > 3 ? ` (+${matched.length - 3} more)` : ""}`,
  };
}

// ── Multi-step / multi-question detection ────────────────────────────
const MULTI_STEP_PATTERNS: readonly RegExp[] = [
  /\b(?:first|then|next|after that|finally|also|additionally)\b/i,
  /\b(?:step\s*\d|part\s*\d|\d\)\s|\d\.\s)/i,
  /\?\s*\n\s*\S/,                              // multiple questions
  /(?:and\s+(?:then|also|how|what|why|can))\b/i,
  /\b(?:phase|stage|before that|after this|once that's done|when complete)\b/i,
  /\b(?:in addition|as well as)\b/i,
];

function scoreMultiStep(prompt: string): Signal {
  const hits = MULTI_STEP_PATTERNS.filter((rx) => rx.test(prompt)).length;
  if (hits >= 3) return { points: 2, reason: "complex multi-step / multi-question" };
  if (hits >= 1) return { points: 1, reason: "multi-step / multi-question" };
  return { points: 0, reason: "" };
}

// ── Attached references ──────────────────────────────────────────────
function scoreReferences(
  references: readonly vscode.ChatPromptReference[],
  referencedFileCount = 0,
): Signal {
  const count = Math.max(references.length, referencedFileCount);
  if (count >= 8) return { points: 3, reason: `${count} file references (large refactor)` };
  if (count >= 5) return { points: 2, reason: `${count} file references (multi-module)` };
  if (count >= 3) return { points: 1, reason: `${count} file references (cross-file)` };
  return { points: 0, reason: "" };
}

// ── Active language context ─────────────────────────────────────────
const HIGH_COMPLEXITY_LANGUAGES = new Set([
  "rust",
  "cpp",
  "c",
  "cuda-cpp",
  "cuda",
  "zig",
  "haskell",
  "ocaml",
  "scala",
]);

function scoreLanguageContext(languageId?: string): Signal {
  if (!languageId) return { points: 0, reason: "" };
  if (HIGH_COMPLEXITY_LANGUAGES.has(languageId)) {
    return { points: 1, reason: `complex language context (${languageId})` };
  }
  return { points: 0, reason: "" };
}

// ── Intent detection ─────────────────────────────────────────────────
const INTENT_PATTERNS: {
  category: string;
  patterns: readonly RegExp[];
  points: number;
}[] = [
  {
    category: "fix/debug",
    patterns: [
      /\b(?:fix|debug|broken|doesn'?t work|bug|error|issue|crash)\b/i,
    ],
    points: 0,
  },
  {
    category: "explain/document",
    patterns: [
      /\b(?:explain|what does|how does|document|add comments|add jsdoc|add docstring|write a readme)\b/i,
    ],
    points: -1,
  },
  {
    category: "generate",
    patterns: [
      /\b(?:create|write|implement|build|add a new)\b/i,
    ],
    points: 1,
  },
  {
    category: "refactor",
    patterns: [
      /\b(?:refactor|clean up|restructure|simplify)\b/i,
    ],
    points: 1,
  },
  {
    category: "review/audit",
    patterns: [
      /\b(?:review|code review|find bugs|security audit|spot issues|any problems with|is this correct)\b/i,
    ],
    points: 2,
  },
  {
    category: "plan/architect",
    patterns: [
      /\b(?:design|architect|plan|strategy|roadmap)\b/i,
    ],
    points: 2,
  },
  {
    category: "large-scope",
    patterns: [
      /\b(?:rewrite|rebuild|from scratch|entire|whole module|complete)\b/i,
      /\b(?:build me a|create a full|implement a full|full test suite)\b/i,
    ],
    points: 3,
  },
];

function scoreIntent(prompt: string): Signal {
  const text = stripCode(prompt).toLowerCase();
  let best = { points: 0, category: "" };
  for (const intent of INTENT_PATTERNS) {
    if (intent.patterns.some((rx) => rx.test(text))) {
      if (intent.points > best.points || (intent.points < 0 && best.points === 0)) {
        best = { points: intent.points, category: intent.category };
      }
    }
  }
  if (best.points === 0 && best.category === "") return { points: 0, reason: "" };
  return {
    points: best.points,
    reason: `intent: ${best.category}`,
  };
}

// ── Error/stacktrace context ─────────────────────────────────────────
const STACK_TRACE_RX =
  /(?:at\s+\S+\s+\(|File\s+"[^"]+",\s*line|Traceback|Error:|Exception:|TypeError:|ReferenceError:|SyntaxError:)/i;

function scoreErrorContext(prompt: string): Signal {
  const hasStackTrace = STACK_TRACE_RX.test(prompt);
  const mentionsFix = /\b(?:fix|solve|resolve|debug)\b/i.test(prompt);
  const isIntermittent = /\b(?:intermittent|sometimes|random|flaky)\b/i.test(prompt);
  const mentionsError = /\b(?:error|bug|broken|crash|exception|fail)\b/i.test(prompt);

  if (hasStackTrace && mentionsFix) {
    return { points: -1, reason: "clear error with stack trace (likely straightforward)" };
  }
  if (mentionsError && !hasStackTrace && prompt.length < 200) {
    return { points: 1, reason: "error mentioned without stack trace (ambiguous)" };
  }
  if (isIntermittent) {
    return { points: 1, reason: "intermittent/non-deterministic bug" };
  }
  return { points: 0, reason: "" };
}

// ── Ambiguity detection ──────────────────────────────────────────────
function scoreAmbiguity(prompt: string): Signal {
  const words = prompt.split(/\s+/).filter(Boolean).length;
  const hasPronouns = /\b(?:this|it|that|the issue|the problem|the error)\b/i.test(prompt);
  const hasSpecifics = /(?:\.(?:ts|js|py|rs|go|java|cpp|c|rb|swift)|line\s*\d|:\d+|\bfunction\s+\w+|\bclass\s+\w+)/i.test(prompt);

  if (words < 20 && hasPronouns && !hasSpecifics) {
    return { points: 2, reason: "vague short prompt (ambiguous)" };
  }
  if (words < 30 && !hasSpecifics && !/```/.test(prompt)) {
    return { points: 1, reason: "short prompt without specifics" };
  }
  return { points: 0, reason: "" };
}

// ── Conversation depth ───────────────────────────────────────────────
function scoreConversationDepth(messageCount: number): Signal {
  if (messageCount >= 11) return { points: 2, reason: `deep conversation (${messageCount} messages)` };
  if (messageCount >= 6) return { points: 1, reason: `extended conversation (${messageCount} messages)` };
  if (messageCount >= 3) return { points: 1, reason: `multi-turn conversation (${messageCount} messages)` };
  return { points: 0, reason: "" };
}

// ── Agent mode detection ─────────────────────────────────────────────
function scoreToolCallingPresence(hasTools: boolean): Signal {
  if (hasTools) return { points: 1, reason: "agent mode (tools present)" };
  return { points: 0, reason: "" };
}

// ── Public API ───────────────────────────────────────────────────────
export function classifyComplexity(
  prompt: string,
  references: readonly vscode.ChatPromptReference[],
  metadata?: ClassifierMetadata,
): ClassificationResult {
  const signals: Signal[] = [
    scoreLength(prompt),
    scoreCode(prompt),
    scoreKeywords(prompt),
    scoreMultiStep(prompt),
    scoreReferences(references, metadata?.referencedFileCount),
    scoreIntent(prompt),
    scoreErrorContext(prompt),
    scoreAmbiguity(prompt),
  ];

  if (metadata?.messageCount) {
    signals.push(scoreConversationDepth(metadata.messageCount));
  }
  if (metadata?.hasTools) {
    signals.push(scoreToolCallingPresence(metadata.hasTools));
  }
  if (metadata?.activeLanguageId) {
    signals.push(scoreLanguageContext(metadata.activeLanguageId));
  }

  const score = signals.reduce((sum, s) => sum + s.points, 0);
  const reasons = signals.map((s) => s.reason).filter(Boolean);

  let tier: Tier;
  if (score <= 4) tier = "simple";
  else if (score <= 8) tier = "medium";
  else tier = "complex";

  return { tier, score, reasons };
}
