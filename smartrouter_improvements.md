# Smart Router — Improvement Tasks

> Each task is scoped, atomic, and designed to make the router best-in-class
> at one job: picking the right Copilot model for every user request.
> 
> **Current architecture reference:**
> - `src/classifier.ts` — scores prompts via 5 signal functions, outputs a tier (`simple` / `medium` / `complex`) based on a numeric score (0–3 = simple, 4–6 = medium, 7+ = complex)
> - `src/models.ts` — maps each tier to an ordered fallback chain of Copilot model families, picks the first available one. Caches the model list for 30s.
> - `src/extension.ts` — `SmartRouterProvider` implements `LanguageModelChatProvider`. On each request it calls `classifyComplexity()` → `selectModelForTier()` → `model.sendRequest()` and streams the response back.
> - `src/patcher.ts` — patches Copilot Chat's minified bundle to inject Smart Router into the model picker and intercept endpoint resolution so requests actually flow through our provider.

---

## Classifier — Smarter Routing Logic

- [ ] **1. Detect Copilot Chat mode (Ask / Edit / Agent)**

  **Problem:** Copilot Chat has three distinct modes — Ask (conversational Q&A), Edit (inline code modifications), and Agent (autonomous tool-calling with file edits, terminal, search). The current classifier ignores which mode the user is in. Agent mode needs models with strong tool-calling and planning ability (Claude Opus, GPT-5.4). Edit mode needs precise, low-hallucination code generation. Ask mode can use lighter models for explanations.

  **Implementation:** The `provideLanguageModelChatResponse` method in `extension.ts` receives `options: ProvideLanguageModelChatResponseOptions`. Check `options.tools?.length` — if tools are present, this is Agent mode. If no tools and the prompt looks like an edit instruction with code context, it's Edit mode. Otherwise Ask mode. Add a `mode: "ask" | "edit" | "agent"` field to the metadata passed to the classifier. Agent mode should add +2 points minimum, Edit mode +1.

  **Files:** `src/extension.ts` (extract mode), `src/classifier.ts` (accept mode in metadata, add signal)

---

- [ ] **2. Detect intent category**

  **Problem:** The current classifier scores complexity signals but doesn't identify *what the user is trying to do*. A "fix this error" prompt and a "design a database schema" prompt might score similarly on length, but they have very different model requirements. Fixing a known error with a stack trace is straightforward. Designing a schema requires reasoning.

  **Implementation:** Add a `scoreIntent()` signal function in `classifier.ts`. Use keyword/phrase matching to classify into categories:
  - `fix` / `debug`: "fix", "error", "bug", "broken", "doesn't work", "TypeError", "stacktrace" → 0 pts (usually straightforward)
  - `explain` / `document`: "explain", "what does", "how does", "document", "add comments" → 0 pts (lightweight)
  - `generate`: "create", "write", "implement", "build", "add a new" → +1 pt
  - `refactor`: "refactor", "clean up", "restructure", "simplify" → +1 pt
  - `test`: "test", "spec", "coverage", "assert" → +1 pt
  - `review` / `audit`: "review", "find bugs", "security audit", "code review" → +2 pts
  - `plan` / `architect`: "design", "architect", "plan", "strategy", "roadmap" → +2 pts
  - `investigate`: "why", "investigate", "root cause", "diagnose" → +1 pt

  Return the highest-scoring category match. The intent category should also be logged alongside the tier for observability.

  **Files:** `src/classifier.ts` (new `scoreIntent()` function, add to signal array)

---

- [ ] **3. Score ambiguity**

  **Problem:** The current system treats short prompts as simple. But "fix this" with no other context is actually *harder* than "change the button color from blue to red" because the model needs to figure out what "this" refers to, scan for errors, and reason about the fix. Short ≠ simple. Vague = hard.

  **Implementation:** Add a `scoreAmbiguity()` signal in `classifier.ts`. Detect:
  - Pronouns without clear referents: "this", "it", "that", "the issue", "the problem" — when the prompt is under 20 words → +2 pts
  - Questions without specifics: "why doesn't it work?", "what's wrong?", "can you help?" → +1 pt
  - No code, no file references, no error messages, and under 30 words → +1 pt (the model will have to gather all context itself)
  - Contrast: if the prompt contains a specific file path, line number, error message, or variable name, it's NOT ambiguous → 0 pts

  The key insight: ambiguity is the inverse of specificity. A prompt with high ambiguity and low length should escalate, not downgrade.

  **Files:** `src/classifier.ts` (new `scoreAmbiguity()` function)

---

- [ ] **4. Detect error/stacktrace presence**

  **Problem:** Currently, pasting a 50-line stack trace scores high on `scoreLength` and `scoreCode` (it's inside a code block), pushing it to medium/complex tier. But a clear stack trace with a known error type (e.g., `TypeError: Cannot read properties of undefined`) is often a simple fix — the model just needs to read the trace and fix the null reference. Meanwhile, a vague "I'm getting an error sometimes" with no trace is much harder.

  **Implementation:** Add a `scoreErrorContext()` signal in `classifier.ts`:
  - Detect stack trace patterns: `at Function.` / `at Object.` / `File "..."`, line numbers, `Error:`, `Exception:`, `Traceback` → the error is *clear*
  - If a clear stack trace is present AND the prompt says "fix" → -1 pt (offset the length/code score, this is likely straightforward)
  - If the prompt mentions an error but has NO stack trace and NO code → +1 pt (ambiguous debugging, model needs to investigate)
  - If the error mentions multiple different exceptions or "intermittent" / "sometimes" / "random" → +1 pt (non-deterministic bugs are hard)

  **Files:** `src/classifier.ts` (new `scoreErrorContext()` function)

---

- [ ] **5. Count referenced files from Copilot context**

  **Problem:** The current `scoreReferences()` only fires when ≥3 `ChatPromptReference` objects are attached, giving +1 point. But file references are one of the strongest signals for task scope. A task touching 1 file is fundamentally different from a task touching 8 files. The current system also doesn't count `#file` references embedded in the message text by Copilot Chat.

  **Implementation:** Enhance `scoreReferences()`:
  - 0 files: 0 pts (local / conversational)
  - 1–2 files: 0 pts (focused task)
  - 3–4 files: +1 pt (cross-file)
  - 5–7 files: +2 pts (multi-module)
  - 8+ files: +3 pts (architectural / large refactor)

  Also scan the prompt text for patterns like `#file:path/to/file` or embedded file paths that Copilot Chat injects. These count as additional file references even if they're not in the `references` array.

  **Files:** `src/classifier.ts` (rewrite `scoreReferences()`)

---

- [ ] **6. Detect language complexity**

  **Problem:** Not all programming languages are equally hard to work with. Generating correct Rust code with lifetimes and borrowing is significantly harder than generating HTML. The current classifier ignores the programming language entirely. A model that's "good enough" for CSS changes may produce incorrect Rust or Haskell.

  **Implementation:** Add a `scoreLanguageComplexity()` signal. Extract the language from:
  1. Code block language tags in the prompt (` ```rust `)
  2. File extensions in references (`.rs`, `.hs`, `.cpp`)
  3. The active editor file type (passed as metadata)

  Scoring:
  - Tier 0 (trivial): HTML, CSS, JSON, YAML, Markdown, plain text → 0 pts
  - Tier 1 (standard): JavaScript, TypeScript, Python, Go, Java, C# → 0 pts
  - Tier 2 (harder): Rust, C++, Scala, Kotlin (when generics-heavy) → +1 pt
  - Tier 3 (specialist): Haskell, OCaml, Coq, Lean, assembly, CUDA → +2 pts

  Also detect complexity markers within code: TypeScript with `extends infer`, Rust with `where` clauses, C++ with template metaprogramming → additional +1 pt.

  **Files:** `src/classifier.ts` (new `scoreLanguageComplexity()` function), `src/extension.ts` (pass active file language as metadata)

---

- [ ] **7. Detect test-writing intent**

  **Problem:** Test generation is a specific task category that doesn't fit neatly into the current scoring. Writing tests requires understanding the code under test, choosing appropriate assertions, handling edge cases, and mocking dependencies. It's structured enough that a medium model handles it well, but important enough that a weak model produces superficial tests.

  **Implementation:** Inside the `scoreIntent()` function (task #2), detect test-writing patterns: "write tests for", "add unit tests", "test coverage", "add specs", "create a test file", "mock this", "test this function". When detected, ensure the minimum tier is `medium` by adding +1 pt. Don't escalate to `complex` unless other signals (many files, complex language) push it there.

  **Files:** `src/classifier.ts` (within `scoreIntent()`)

---

- [ ] **8. Detect documentation intent**

  **Problem:** Documentation tasks (explain code, add JSDoc, write README sections) are low-reasoning tasks that any model can handle well. Currently, a long piece of code with "add comments to this" gets scored as complex due to `scoreLength` and `scoreCode`, wasting a strong model on a simple task.

  **Implementation:** Inside `scoreIntent()` (task #2), detect documentation patterns: "explain", "what does this do", "add comments", "add JSDoc", "add docstrings", "document this", "write a README for". When documentation intent is detected, apply a negative adjustment: -2 pts (pull toward simple tier). This offsets the length/code signals that would otherwise inflate the score.

  **Files:** `src/classifier.ts` (within `scoreIntent()`, apply negative adjustment)

---

- [ ] **9. Weight conversation depth**

  **Problem:** The classifier currently only looks at the last user message. It ignores how deep into the conversation the user is. If a user is on their 8th message in the same thread, it likely means:
  - The task is harder than it initially appeared
  - Previous model responses weren't sufficient
  - The user is iterating on a complex problem

  Sending message #8 to `gpt-5.4-mini` when messages #1–7 already failed to resolve the issue is wasteful.

  **Implementation:** In `provideLanguageModelChatResponse` in `extension.ts`, count the number of messages in the `messages` array. Pass `messageCount` as metadata to the classifier. In `classifier.ts`, add a `scoreConversationDepth()` signal:
  - Messages 1–2: 0 pts (normal start)
  - Messages 3–5: +1 pt (extended conversation)
  - Messages 6–10: +2 pts (deep session, likely struggling)
  - Messages 11+: +3 pts (complex ongoing work)

  **Files:** `src/extension.ts` (pass message count), `src/classifier.ts` (new `scoreConversationDepth()`)

---

- [ ] **10. Detect "do everything" scope**

  **Problem:** Some prompts are short but massive in scope: "rewrite this module", "build me a REST API", "redesign the authentication system", "create a full test suite". These are categorically complex regardless of prompt length. The current system might route "build me a REST API" (7 words, score=0) to `gpt-5.4-mini`.

  **Implementation:** Add scope-escalation patterns to the keyword/intent detection. When the prompt contains any of: "rewrite", "rebuild", "from scratch", "entire", "whole", "complete", "full", "build me a", "create a", "implement a" followed by a system/module noun — immediately add +3 pts. This ensures these prompts land in `medium` or `complex` tier regardless of length.

  The key distinction: "fix this function" (scoped) vs. "rewrite this module" (unbounded).

  **Files:** `src/classifier.ts` (add scope-escalation patterns to `scoreIntent()` or new `scoreScopeSize()`)

---

- [ ] **11. Detect code review intent**

  **Problem:** Code review is one of the highest-value tasks for AI. Finding subtle bugs, security issues, performance problems, and logic errors requires the strongest reasoning available. The current system has no way to detect review intent. "Review this PR" (3 words) would route to `gpt-5.4-mini`.

  **Implementation:** Detect review patterns: "review", "code review", "PR review", "find bugs", "spot issues", "security audit", "check for", "any problems with", "is this correct", "what's wrong with". When detected, add +3 pts to ensure at minimum `medium` tier, usually `complex`. Code review should almost always use the strongest available model — the cost of missing a bug far exceeds the model cost difference.

  **Files:** `src/classifier.ts` (within `scoreIntent()`)

---

- [ ] **12. Score prompt specificity**

  **Problem:** Specificity is the inverse of ambiguity (task #3) but deserves its own signal because it can *reduce* the tier. A highly specific prompt ("in `src/auth/login.ts` line 42, change `===` to `!==`") needs almost no reasoning — even the cheapest model will get it right. Currently, specificity isn't rewarded.

  **Implementation:** Add a `scoreSpecificity()` signal that detects precision markers:
  - Contains a file path: -1 pt
  - Contains a line number: -1 pt
  - Contains a specific variable/function name: -1 pt
  - Contains exact "change X to Y" language: -1 pt
  - Cap the reduction at -2 pts total (don't let it override genuine complexity signals)

  This helps the router save money on tasks that any model can handle, even if the prompt happens to be long or contain code.

  **Files:** `src/classifier.ts` (new `scoreSpecificity()` function)

---

- [ ] **13. Detect planning/multi-step language**

  **Problem:** The current `scoreMultiStep()` function only gives +1 pt and only when ≥2 patterns match. It needs 2 of 4 regex hits to trigger. This is too conservative. A user asking "first do X, then do Y, then do Z" is clearly asking for a multi-step task that needs planning ability, but the current signal is weak.

  **Implementation:** Enhance `scoreMultiStep()`:
  - 1 multi-step pattern: +1 pt
  - 2+ multi-step patterns: +2 pts
  - Add more patterns: "step 1", "phase", "stage", "before that", "after this", "once that's done", "when complete"
  - Detect numbered lists: if the prompt contains `1.` and `2.` (or `1)` and `2)`), that's clearly multi-step → +2 pts
  - Detect enumeration: "and also", "as well as", "in addition" → +1 pt

  **Files:** `src/classifier.ts` (enhance `scoreMultiStep()`)

---

- [ ] **14. Remove false-positive keywords**

  **Problem:** The current `COMPLEXITY_KEYWORDS` list includes "async", "parallel", "optimization", "performance" and similar terms. But these frequently appear in *code syntax* rather than *task descriptions*. A user pasting `async function fetchData()` and asking "why does this throw?" gets +1 pt for "async" even though the task isn't about concurrency. Similarly, "optimize" in a comment inside pasted code isn't the user asking for optimization.

  **Implementation:**
  1. Strip code blocks from the prompt before keyword scanning. Only scan the natural-language portion.
  2. Remove or downweight keywords that commonly appear in code: "async", "parallel" (in import paths), "type system" (in code comments).
  3. Only match keywords when they appear in the user's *instruction*, not in pasted code/output.
  4. Consider requiring keyword context: "optimize" alone in code → ignore. "optimize this for performance" in instruction text → count it.

  Concretely in `scoreKeywords()`: before scanning, create a `promptWithoutCode` variable by stripping ` ```...``` ` blocks and inline `` `code` `` spans. Scan only that.

  **Files:** `src/classifier.ts` (modify `scoreKeywords()` to strip code before scanning)

---

## Model Selection — Better Chains & Fallbacks

- [ ] **15. Model strength profiles**

  **Problem:** The current `DEFAULT_CHAINS` is a flat `Record<Tier, string[]>` — just family names in order. There's no notion of *why* a model is preferred. When a new model becomes available (e.g., GPT-5.5), you have to manually decide where it goes in every chain. There's no data structure encoding what each model is good at.

  **Implementation:** Create a `ModelProfile` interface:
  ```ts
  interface ModelProfile {
    family: string;
    tier: "fast" | "balanced" | "strong" | "max";
    reasoning: 1 | 2 | 3 | 4 | 5;
    codeGen: 1 | 2 | 3 | 4 | 5;
    toolUse: 1 | 2 | 3 | 4 | 5;
    speed: 1 | 2 | 3 | 4 | 5;     // 5 = fastest
    costMultiplier: number;         // relative to cheapest
    contextWindow: number;          // max tokens
  }
  ```

  Define profiles for all known models. Then `selectModelForTier()` can query: "give me the best model for this tier that scores ≥4 on toolUse" instead of walking a hardcoded list.

  **Files:** `src/models.ts` (add `ModelProfile` and profile data, refactor `selectModelForTier()`)

---

- [ ] **16. Per-language model preference**

  **Problem:** Different models have different strengths per language. Claude models tend to be stronger at Rust and TypeScript. GPT models may be better at Python data science tasks. The current router ignores the programming language entirely when choosing a model.

  **Implementation:** In the `ModelProfile` (task #15), add optional language affinities:
  ```ts
  languageBoost?: Record<string, number>; // e.g., { "rust": +1, "python": +1 }
  ```
  When choosing a model, if the active file or code block language is known, apply the boost to the model's ranking. This is a soft hint, not a hard override — it just breaks ties in favor of the model with a language affinity.

  **Files:** `src/models.ts` (add language boost to selection logic), `src/extension.ts` (pass detected language)

---

- [ ] **17. Context window awareness**

  **Problem:** If a user has 10 files referenced and a long conversation history, the total token count may exceed a smaller model's context window. Currently, the router picks the model first and only discovers the overflow when the API call fails. This wastes time and gives the user an error.

  **Implementation:** Before selecting a model, estimate the total token count of the conversation (use the cached token counting from `provideTokenCount`). Compare against each candidate model's `maxInputTokens` from the `ModelProfile`. Skip models whose context window is too small. If the cheapest model in the chain can't fit the context, automatically escalate to a model with a larger window.

  This prevents context-overflow errors and avoids sending a 200k-token conversation to a 32k model.

  **Files:** `src/models.ts` (add context window check in `selectModelForTier()`), `src/extension.ts` (estimate and pass total token count)

---

- [ ] **18. Tool-use capability check**

  **Problem:** In Agent mode, Copilot Chat sends tool definitions and expects the model to make tool calls (file edits, terminal commands, search). Some models are much better at tool calling than others. Routing an Agent mode request to a weak tool-calling model results in broken tool calls, missed tools, or infinite loops.

  **Implementation:** Check `options.tools?.length > 0` in `provideLanguageModelChatResponse`. If tools are present, filter the model chain to only include models with `toolUse >= 4` from the `ModelProfile` (task #15). If no models in the current tier qualify, escalate to the next tier. Never send a tool-heavy request to a model known to struggle with tool calling.

  **Files:** `src/extension.ts` (detect tools), `src/models.ts` (filter by tool-use capability)

---

- [ ] **19. Streaming speed preference**

  **Problem:** For simple questions, users perceive quality partly through responsiveness. A model that starts streaming in 200ms feels better than one that takes 2s, even if the final answer is similar. The current router doesn't consider latency.

  **Implementation:** In the `ModelProfile` (task #15), the `speed` field captures time-to-first-token characteristics. For `simple` tier tasks, prefer models with `speed >= 4`. Only apply this when the task is clearly simple (score ≤ 2) — don't sacrifice quality for speed on ambiguous tasks.

  **Files:** `src/models.ts` (when tier is simple and score is very low, sort candidates by speed)

---

- [ ] **20. Cost multiplier display**

  **Problem:** Users currently have no visibility into the cost implications of their routing. They don't know if Smart Router sent their prompt to a 1x or 10x model. In an enterprise environment, cost transparency builds trust and helps teams budget.

  **Implementation:** After model selection in `provideLanguageModelChatResponse`, update the status bar item with the cost multiplier: `$(hubot) Smart → 1x` or `$(hubot) Smart → 10x`. Use the `costMultiplier` from `ModelProfile`. Color-code: green for 1x, yellow for 2–5x, orange for 10x+. Reset after 5 seconds to the default text.

  **Files:** `src/extension.ts` (update status bar after model selection)

---

## Escalation & Retry

- [ ] **21. Automatic escalation on empty response**

  **Problem:** Sometimes a model returns an empty response, a single word, or clearly incomplete output. The user has to re-send the prompt or switch models manually. Smart Router should handle this automatically.

  **Implementation:** In `provideLanguageModelChatResponse`, after streaming completes, track the total number of response parts received. If the response has fewer than 10 characters of text content (excluding tool calls), and the prompt was non-trivial (score > 0), automatically retry with the next model in the chain one tier up. Log the escalation: `"Empty response from gpt-5.4-mini, escalating to claude-sonnet-4.6"`. Limit to 1 retry to avoid infinite loops.

  Important: buffer the response parts so you can detect emptiness before the response is finalized. Report the escalated model's response to the user.

  **Files:** `src/extension.ts` (buffer response, detect empty, retry with escalated tier)

---

- [ ] **22. Escalation on error response**

  **Problem:** Models can fail with rate limits (429), context overflow, or internal errors. The current implementation lets the error propagate to the user. Smart Router should catch these and silently try the next model.

  **Implementation:** Wrap the `model.sendRequest()` call in a try/catch. On error:
  - Log the error: `"gpt-5.4-mini failed: [error message]"`
  - If it's a rate limit (429/quota) or context overflow, try the next model in the same tier
  - If all models in the current tier fail, try the first model in the next tier up
  - If all tiers fail, report a clear error to the user: "All models are currently unavailable"
  - Limit retries to 3 total to avoid hammering the API

  **Files:** `src/extension.ts` (add retry loop with error handling in `provideLanguageModelChatResponse`)

---

- [ ] **23. Confidence threshold**

  **Problem:** When the classifier score is exactly at a tier boundary (e.g., score=3 is the top of `simple`, score=4 is the bottom of `medium`), the current system makes a hard cutoff. A score of 3 gets `gpt-5.4-mini`, a score of 4 gets `claude-sonnet-4.6`. In an enterprise environment where quality matters more than cost, borderline cases should favor the stronger model.

  **Implementation:** Add a configurable `smart-router.bias` setting (see task #43). When bias is `"quality"`, shift tier boundaries down by 1 (simple ≤ 2, medium ≤ 5, complex 6+). When bias is `"economy"`, shift up by 1 (simple ≤ 4, medium ≤ 7). When `"balanced"`, keep current defaults (3/6). Apply this in `classifyComplexity()`.

  **Files:** `src/classifier.ts` (read bias setting, adjust thresholds)

---

- [ ] **24. Never downgrade mid-conversation**

  **Problem:** Consider this scenario: User sends a complex architecture question (score=8, Opus). Then sends a follow-up: "ok do it" (score=0, Haiku). The follow-up is simple in isolation, but it refers to the complex task just discussed. Routing "ok do it" to Haiku loses all the context quality.

  **Implementation:** Track the maximum tier used within the current conversation. Store it as a `Map<conversationId, Tier>` in the provider class. On each new message, compute the classifier tier as normal, but clamp it to be at least as high as the conversation's previous maximum. This means a conversation that escalated to `complex` will stay at `complex` or higher.

  The conversation ID can be inferred from the message array signature or from the request context.

  **Files:** `src/extension.ts` (add conversation tier tracking, clamp tier in `provideLanguageModelChatResponse`)

---

- [ ] **25. Respect user override**

  **Problem:** If a user manually selects Claude Opus 4.6 in Copilot Chat, uses it for a while, then switches to Smart Router, they likely want high-quality routing. The router should notice this pattern and bias toward stronger models.

  **Implementation:** This is a soft signal, not a hard override. Track the user's last manually-selected model family in a workspace-scoped memento (`context.workspaceState`). If the last manual selection was a strong model, add +1 to the classifier score for the next N requests (where N could be 5 or 10). This gradually decays back to normal routing.

  **Files:** `src/extension.ts` (track last manual model via workspace state, pass bias to classifier)

---

## Context Awareness

- [ ] **26. Read workspace size**

  **Problem:** A monorepo with 500+ files requires more context gathering and cross-file reasoning than a single-file script. The current classifier ignores workspace size entirely. A prompt in a monorepo is more likely to involve multiple modules, complex dependencies, and architectural decisions.

  **Implementation:** On activation, count files in the workspace (use `vscode.workspace.findFiles('**/*', '**/node_modules/**')` with a limit). Store the count. In the classifier, add a `scoreWorkspaceComplexity()` signal:
  - < 10 files: 0 pts (simple project)
  - 10–50 files: 0 pts (normal project)
  - 50–200 files: +1 pt (medium project, cross-file tasks more likely)
  - 200+ files: +1 pt (large project, discovery is harder)

  This is a baseline boost — it shifts the router toward slightly stronger models when working in large codebases. Cap at +1 to avoid over-influencing.

  **Files:** `src/extension.ts` (count workspace files on activation), `src/classifier.ts` (new `scoreWorkspaceComplexity()` accepting file count as metadata)

---

- [ ] **27. Detect active file language**

  **Problem:** The currently open file's language strongly hints at what the task involves. If the user has a `.rs` file open and asks "help me with this", the task involves Rust — which is harder than if they had a `.md` file open. This signal is free and currently ignored.

  **Implementation:** In `provideLanguageModelChatResponse`, read `vscode.window.activeTextEditor?.document.languageId`. Pass it as metadata to the classifier. This feeds into the language complexity scoring (task #6) and per-language model preference (task #16) without any additional user action.

  **Files:** `src/extension.ts` (read active language, pass to classifier)

---

- [ ] **28. Detect git diff size**

  **Problem:** If the user has 500 lines of uncommitted changes across 12 files, they're in the middle of a significant refactoring session. Tasks in this context are more likely to be complex (integrating changes, fixing broken tests, resolving conflicts). The current classifier has no awareness of the working tree state.

  **Implementation:** On each request (or cached with a 60s TTL), run a lightweight check: count the number of changed files using `vscode.workspace.fs` or the Git extension API. Add a `scoreGitContext()` signal:
  - 0–2 changed files: 0 pts
  - 3–8 changed files: +1 pt
  - 9+ changed files: +2 pts

  Keep this lightweight — don't invoke `git diff` on every request. Cache the result.

  **Files:** `src/classifier.ts` (new `scoreGitContext()`), `src/extension.ts` (gather git state, pass as metadata)

---

- [ ] **29. Use selection length**

  **Problem:** If the user selects 200 lines of code and asks "refactor this", that's a significantly larger task than selecting 5 lines. The current classifier only sees the prompt text, not the selected code that Copilot Chat may include as context. The selection size is a direct measure of task scope.

  **Implementation:** The `messages` array in `provideLanguageModelChatResponse` includes the selected code as part of the user message content (Copilot Chat embeds it). Estimate the code volume by scanning the message content for large code blocks. Alternatively, read `vscode.window.activeTextEditor?.selection` to get the selection range. Add to classifier metadata:
  - < 20 lines selected: 0 pts
  - 20–100 lines: +1 pt
  - 100+ lines: +2 pts

  **Files:** `src/extension.ts` (extract selection/code size from messages), `src/classifier.ts` (new signal)

---

- [ ] **30. Terminal error detection**

  **Problem:** A common workflow: user runs a command, gets an error in the terminal, then asks Copilot "fix this". The terminal error provides critical context about what went wrong. If the terminal has a recent error, the task is likely debugging → should route to a model good at error analysis.

  **Implementation:** This is harder to access directly (Copilot Chat may or may not include terminal context). If terminal content is included in the messages, scan for error patterns: non-zero exit codes, "Error:", "FAILED", "Exception", red ANSI codes. If detected, add +1 pt and mark the intent as `debug`.

  If terminal context isn't available in the messages, this task depends on task #1 (mode detection) — in Agent mode, the model has terminal access and will gather this automatically.

  **Files:** `src/classifier.ts` (scan messages for terminal error patterns)

---

## Performance & Efficiency

- [ ] **31. Pre-classify during typing (debounced)**

  **Problem:** Currently, classification happens after the user sends the message. Even though classification is fast (< 1ms), the model selection that follows includes an async `selectChatModels` call. If we could start classification earlier, the perceived latency would be lower.

  **Implementation:** This is an aspirational task — the `LanguageModelChatProvider` API doesn't provide access to the input before `provideLanguageModelChatResponse` is called. However, prewarming the model cache (task #32) achieves most of the same benefit. Mark this as "design research" — investigate if there's a way to hook into the chat input lifecycle via the patcher.

  **Files:** Research only. Possibly `src/patcher.ts` if a hook point exists.

---

- [ ] **32. Model cache warming on VS Code startup**

  **Problem:** The first request after startup has to call `selectChatModels()` which is an async operation adding ~200–700ms of latency. Every subsequent request uses the cached list (30s TTL). The first request should be just as fast.

  **Status:** Already implemented in the latest version. `warmModelCache()` is called on activation. Verify it works and that the cache is populated before the first user request arrives.

  **Files:** `src/extension.ts` (verify), `src/models.ts` (verify cache logic)

---

- [ ] **33. Batch token counting**

  **Problem:** Copilot Chat calls `provideTokenCount` many times during a single request — once per message segment, for truncation decisions, for context window fitting. Each call currently goes through our `provideTokenCount` method. While we cache the model, the individual calls still accumulate overhead.

  **Implementation:** Add a simple LRU cache for token counts keyed by content hash. Since the same strings are often counted multiple times (conversation history doesn't change between counts), this avoids redundant work:
  ```ts
  private _tokenCache = new Map<string, number>();
  ```
  Evict when the cache exceeds 100 entries. Hash the input string (first 100 chars + length as key for speed).

  **Files:** `src/extension.ts` (add LRU cache to `provideTokenCount`)

---

- [ ] **34. Zero-allocation classifier**

  **Problem:** The classifier creates arrays, strings, and objects on every call. For a hot path that runs on every message, minimizing allocations improves GC pressure and keeps p99 latency low.

  **Implementation:** Audit `classifier.ts` for unnecessary allocations:
  - `prompt.split(/\s+/).filter(Boolean).length` creates an array just to count words → use a loop with `indexOf` instead
  - `COMPLEXITY_KEYWORDS.filter(...)` creates an array → use a `for` loop with early exit
  - `signals.map(...).filter(Boolean)` creates two intermediate arrays → accumulate in a single loop
  - Pre-compile all regex patterns as module-level constants (already done for `MULTI_STEP_PATTERNS`, do the same for any new patterns)

  Target: the classifier should allocate zero intermediate arrays for a typical 100-word prompt. Measure with `performance.now()` before and after.

  **Files:** `src/classifier.ts` (refactor hot path to minimize allocations)

---

- [ ] **35. Cache classifier results per conversation**

  **Problem:** When a user sends message #5 in a conversation, the classifier re-processes the entire conversation's worth of signals. But messages #1–4 haven't changed — only message #5 is new. Re-classifying the unchanged prefix is wasted work.

  **Implementation:** Cache the previous classification result keyed by a hash of the message array (excluding the last message). On a new request, if the prefix hash matches the cache, only classify the *new* message and combine its signals with the cached ones. This is most beneficial for long conversations (10+ messages).

  Given the classifier runs in <1ms, this is a low-priority optimization. Implement only after tasks #1–14 are done and the classifier is doing more work.

  **Files:** `src/extension.ts` (cache previous classification), `src/classifier.ts` (support incremental classification)

---

## User Experience

- [ ] **36. Status bar shows selected model**

  **Problem:** After Smart Router picks a model, the user has no visibility into which model was actually used. The status bar just says "Smart ✓". Users want to know: did it use Haiku or Opus? This is especially important for trust and debugging.

  **Implementation:** After `selectModelForTier()` returns, update the status bar text:
  ```ts
  statusBar.text = `$(hubot) Smart → ${family}`;
  ```
  Show the model family name (e.g., "Smart → claude-sonnet-4.6"). After 10 seconds, revert to "Smart ✓". Use the tier to color the text: green for simple, yellow for medium, red for complex.

  **Files:** `src/extension.ts` (pass status bar to provider, update after model selection)

---

- [ ] **37. Output channel shows routing decision**

  **Problem:** Currently the output channel logs `[Simple] score=2 → gpt-5.4-mini (moderate length)`. This is good but could be more detailed and structured for enterprise users who want to audit every routing decision.

  **Implementation:** Log a structured line for every request:
  ```
  [ROUTE] tier=simple score=2 model=gpt-5.4-mini mode=ask intent=fix reasons=[moderate length (160 words)] tokens=~4200 conversation_depth=1
  ```
  Include: tier, score, selected model, detected mode, detected intent, all classified reasons, estimated token count, conversation message count. This gives enterprise teams a complete audit trail in the output channel.

  **Files:** `src/extension.ts` (enhance logging in `provideLanguageModelChatResponse`)

---

- [ ] **38. "Why this model?" command**

  **Problem:** Users sometimes wonder why Smart Router picked a particular model. There's no way to inspect the routing decision after the fact. A diagnostic command would help users understand and trust the system.

  **Implementation:** Register a command `smart-router.whyThisModel` that shows the last routing decision as a notification or quick pick:
  ```
  Last request routed to: claude-sonnet-4.6 (Medium tier)
  Score: 5
  Reasons:
    - moderate length (180 words)
    - 2 code blocks, ~35 lines
    - complexity keywords: refactor
  Mode: Agent (tools detected)
  Conversation depth: 3 messages
  ```
  Store the last `ClassificationResult` + selected model in the provider.

  **Files:** `src/extension.ts` (store last result, register command, show quick pick)

---

- [ ] **39. Manual tier override**

  **Problem:** Sometimes the user knows better than the router. They're about to ask something simple but want the strongest model anyway, or they're doing rapid iterations and want to force the cheapest model. There's no way to manually override the tier.

  **Implementation:** Register three commands:
  - `smart-router.forceSimple` — force next request to `simple` tier
  - `smart-router.forceMedium` — force next request to `medium` tier
  - `smart-router.forceStrong` — force next request to `complex` tier

  After one request, the override expires and Smart Router returns to automatic mode. Show the override in the status bar: `$(hubot) Smart [FORCED: Strong]`. This gives power users control without requiring them to switch away from Smart Router entirely.

  **Files:** `src/extension.ts` (register commands, store override, apply in routing, expire after use)

---

- [ ] **40. Quick re-send with stronger model**

  **Problem:** The user gets a response from Smart Router and it's not good enough. Currently they have to retype or re-send and hope for a better model. A "retry with stronger model" command would let them escalate with one click.

  **Implementation:** Register a command `smart-router.retryStronger`. Store the last request's messages and options. When triggered, re-invoke `provideLanguageModelChatResponse` with the same input but force the tier to one level above the last-used tier. This requires cooperation with Copilot Chat's UI — investigate whether we can trigger a re-send programmatically or if this needs to be a chat participant command.

  **Files:** `src/extension.ts` (store last request, register command). May require patcher changes if Copilot Chat doesn't expose re-send.

---

- [ ] **41. Routing notification (subtle)**

  **Problem:** Users want to see the routing decision without it being intrusive. A notification is too noisy. A dedicated status bar item that briefly shows the routing is ideal.

  **Implementation:** When a model is selected, flash the status bar with the routing: `$(hubot) → Opus 4.6 (complex)`. Use `setTimeout` to revert after 5 seconds. Add a subtle animations using the status bar's background color API (if available) — green flash for simple, yellow for medium, brief pulse for complex. Keep it minimal — no toast notifications, no modals.

  **Files:** `src/extension.ts` (status bar animation logic after model selection)

---

- [ ] **42. Model usage summary**

  **Problem:** Over time, users and teams want to see the aggregate impact of Smart Router. How many requests were simple vs. complex? How much money did smart routing save compared to always using the strongest model?

  **Implementation:** Register a command `smart-router.usageSummary`. Track per-session counters:
  ```ts
  { simple: 0, medium: 0, complex: 0, totalRequests: 0, escalations: 0 }
  ```
  Display as a quick pick:
  ```
  Session usage:
    Simple:  12 requests  (48%)  → ~$0.02 estimated
    Medium:   8 requests  (32%)  → ~$0.40 estimated
    Complex:  5 requests  (20%)  → ~$2.50 estimated
    
    Estimated savings vs. always-Opus: ~62%
    Escalations: 2 (auto-retry after weak response)
  ```
  Cost estimates use the `costMultiplier` from `ModelProfile` (task #15).

  **Files:** `src/extension.ts` (track counters, register command, display summary)

---

## Configuration & Customization

- [ ] **43. Quality vs. cost slider**

  **Problem:** Different users and teams have different priorities. A solo developer may want to minimize cost. An enterprise security team may want maximum quality on every request. Currently there's no single knob to tune this trade-off.

  **Implementation:** Add a VS Code setting `smart-router.bias` with three options:
  - `"quality"` — shift tier boundaries down: simple ≤ 2, medium ≤ 5, complex 6+. More requests go to stronger models. For enterprise teams where getting it right the first time matters.
  - `"balanced"` — default (simple ≤ 3, medium ≤ 6, complex 7+)
  - `"economy"` — shift tier boundaries up: simple ≤ 4, medium ≤ 7, complex 8+. Fewer requests go to strong models. For cost-conscious usage.

  In `classifyComplexity()`, read the setting and adjust the threshold comparison. One setting, global effect, no per-signal tuning needed.

  **Files:** `src/classifier.ts` (read setting, adjust thresholds), `package.json` (declare setting in contributes.configuration)

---

- [ ] **44. Per-workspace model overrides**

  **Problem:** A team working on a security-critical service may want all requests to use the strongest model. A team working on documentation may be fine with the cheapest. The current settings are user-global.

  **Implementation:** The existing model chain settings (`smart-router.models.simple`, etc.) already support workspace-level overrides via `.vscode/settings.json`. Document this clearly and add support for a `.smartrouter.json` at repo root (task #58) for team-wide configuration that lives in version control.

  Verify that `vscode.workspace.getConfiguration()` correctly reads workspace-level settings. Add documentation showing how to override per-workspace.

  **Files:** `src/models.ts` (verify), documentation updates

---

- [ ] **45. Blocklist models**

  **Problem:** Some organizations or users may want to exclude specific models — they don't trust GPT-4o-mini, or their policy prohibits using a particular provider. Currently there's no way to say "never use this model".

  **Implementation:** Add a setting `smart-router.blocklist`: an array of model family strings to exclude. In `selectModelForTier()`, after fetching the cached model list, filter out any models whose family appears in the blocklist. This ensures the blocked model is never selected, even as a last-resort fallback.

  ```json
  "smart-router.blocklist": ["gpt-4o-mini", "gpt-4o"]
  ```

  **Files:** `src/models.ts` (read blocklist setting, filter in `selectModelForTier()`), `package.json` (declare setting)

---

- [ ] **46. Pin model for file types**

  **Problem:** Some users know from experience that Claude is better for Rust and GPT is better for Python. They want to express this without switching away from Smart Router.

  **Implementation:** Add a setting `smart-router.languageOverrides`:
  ```json
  "smart-router.languageOverrides": {
    "rust": "claude-opus-4.6",
    "python": "gpt-5.4"
  }
  ```
  When the active file matches a configured language, bypass the classifier and go directly to that model family. If the specified model isn't available, fall back to normal routing.

  **Files:** `src/models.ts` (add language override lookup), `src/extension.ts` (pass active language), `package.json` (declare setting)

---

- [ ] **47. Tier threshold configuration**

  **Problem:** Power users may want to fine-tune exactly where the tier boundaries are, beyond the three presets in task #43. Maybe they want simple ≤ 2 and medium ≤ 4 for a very aggressive quality stance.

  **Implementation:** Add settings:
  ```json
  "smart-router.thresholds.simple": 3,
  "smart-router.thresholds.medium": 6
  ```
  The classifier reads these instead of hardcoded values. Anything above the medium threshold is complex. This gives full control to advanced users.

  **Files:** `src/classifier.ts` (read threshold settings), `package.json` (declare settings)

---

## Robustness

- [ ] **48. Graceful degradation if no models available**

  **Problem:** If Copilot isn't signed in, the token has expired, or all models are rate-limited, the current code returns a text message "No language models available. Is Copilot signed in?" This is acceptable but could be better.

  **Implementation:** Enhance the error path:
  1. Check if ANY models are available (not just copilot vendor). If other vendors work, suggest the user check their Copilot subscription.
  2. Check if the Copilot extension is installed and active.
  3. Provide an actionable message: "Copilot Chat models are not available. [Check your subscription](https://github.com/settings/copilot) or try reloading VS Code."
  4. Update the status bar to show a warning icon: `$(hubot) Smart ⚠ No models`

  **Files:** `src/extension.ts` (enhance error path in `provideLanguageModelChatResponse`)

---

- [ ] **49. Handle Copilot Chat extension updates**

  **Problem:** When Copilot Chat auto-updates, the patched `extension.js` gets replaced with a fresh version. Smart Router already watches `extensions.onDidChange` and re-patches after a 3-second delay. But this can fail if the new version has different internal structure.

  **Implementation:** Enhance the update handler:
  1. On `extensions.onDidChange`, check if Copilot Chat's version changed (store the version on first patch).
  2. If version changed, log a warning: "Copilot Chat updated to v0.42.0 — attempting re-patch"
  3. Attempt the patch. If it fails (patterns don't match), show a notification: "Smart Router needs an update to work with Copilot Chat v0.42.0"
  4. Keep the backup of the last working patched version for diagnostics.

  **Files:** `src/extension.ts` (enhance version tracking), `src/patcher.ts` (store/compare version)

---

- [ ] **50. Validate patch integrity on startup**

  **Problem:** The current check is `content.includes(PATCH_MARKER)`. This only confirms the marker string is present, not that the injected code is functional. A corrupted patch (partial write, encoding issue) could pass the marker check but fail at runtime.

  **Implementation:** After detecting the marker, also verify:
  1. Both patch injection points are present (search for unique strings from each patch)
  2. The backup file exists and is valid (has a reasonable file size)
  3. The patched file's byte size is larger than the backup (injection adds ~2KB)

  If any check fails, log a warning and offer to re-patch from backup.

  **Files:** `src/patcher.ts` (add validation in `ensureCopilotPatched`)

---

- [ ] **51. Self-healing unpatch**

  **Problem:** If a patch causes Copilot Chat to crash on startup, the user is stuck — Copilot Chat won't load, and Smart Router's unpatch command requires Copilot Chat to be available to find its extension path.

  **Implementation:** Store the patched file path and backup path in the extension's `globalState` during patching. On Smart Router activation, if Copilot Chat is not present (extension missing or failed to activate), check the stored paths and restore the backup automatically. Log: "Copilot Chat appears to have failed — restored backup. Please reload."

  This makes the system self-healing: even if a bad patch breaks Copilot Chat, the next reload fixes it.

  **Files:** `src/extension.ts` (store paths in globalState), `src/patcher.ts` (self-heal on activation if Copilot Chat is missing)

---

- [ ] **52. Rate limit awareness**

  **Problem:** When a model starts returning 429 (rate limit) errors, the current system either errors out or (with task #22) retries with another model. But it doesn't learn from the rate limit — the next request will try the same rate-limited model again.

  **Implementation:** Track rate-limit failures per model family with a cooldown:
  ```ts
  const _rateLimited: Map<string, number> = new Map(); // family → expiry timestamp
  ```
  When a 429 is detected, add the model to the cooldown map for 60 seconds. In `selectModelForTier()`, skip models that are currently rate-limited. This avoids repeatedly hitting a rate-limited model and reduces user-facing errors.

  **Files:** `src/models.ts` (add rate limit tracking, filter in `selectModelForTier()`)

---

## Telemetry & Learning

- [ ] **53. Local routing log**

  **Problem:** There's no persistent record of routing decisions. The output channel is ephemeral — it's lost when VS Code closes. For enterprise users who want to analyze routing patterns over time, a persistent local log is essential.

  **Implementation:** On each routing decision, append a JSON line to `~/.smart-router/routing.jsonl`:
  ```json
  {"ts":"2026-03-27T19:02:34Z","tier":"simple","score":2,"model":"gpt-5.4-mini","mode":"ask","intent":"fix","reasons":["moderate length"],"tokens":4200,"responseMs":1873,"success":true}
  ```
  Use JSONL format (one JSON object per line) for easy parsing. Rotate the file when it exceeds 10MB. Never include prompt content — only metadata. This data stays local and is never transmitted.

  **Files:** `src/extension.ts` (append log after each request), new `src/logger.ts` (file append + rotation logic)

---

- [ ] **54. Response quality signal**

  **Problem:** If the user re-sends the same prompt immediately after getting a response, it likely means the first response was unsatisfactory. This is a valuable signal that the router chose the wrong model.

  **Implementation:** Track the last N prompt hashes (hash of the first 200 chars). If a new prompt matches a recent one (within 2 minutes), it's a "retry" signal. Log it: `"User re-sent similar prompt — previous model (gpt-5.4-mini) may have been insufficient"`. Use this signal to add +1 pt to the next routing decision for similar prompts (within the session). Over time, this teaches the router to be slightly more aggressive for this user.

  **Files:** `src/extension.ts` (track prompt hashes, detect re-sends, apply bias)

---

- [ ] **55. Response time tracking**

  **Problem:** Different models have different latency profiles, and these profiles change over time (server load, model updates). The current router has no empirical data on how fast each model actually responds for this user.

  **Implementation:** Track per-model response times in a running average:
  ```ts
  const _modelLatency: Map<string, { avg: number, count: number }> = new Map();
  ```
  Record `Date.now()` before `sendRequest()` and after the first `progress.report()` (time-to-first-token). If the `speed` preference (task #19) is active, use empirical latency data instead of static profiles to choose the fastest model for simple tasks.

  **Files:** `src/extension.ts` (track timing around sendRequest), `src/models.ts` (optionally use empirical latency)

---

- [ ] **56. Conversation length tracking**

  **Problem:** If Smart Router is working well, users should resolve their tasks in fewer back-and-forth messages. Tracking average conversation length per tier gives insight into whether the routing is effective.

  **Implementation:** Track the number of messages per conversation. When a conversation ends (user starts a new thread or closes the chat), log: `"Conversation ended: 4 messages, max tier: medium, models used: [gpt-5.4, claude-sonnet-4.6]"`. Store in the local routing log (task #53). Over time, compare: do conversations using Smart Router have fewer messages than the average?

  **Files:** `src/extension.ts` (track conversation length), `src/logger.ts` (log conversation summary)

---

- [ ] **57. Export routing analytics**

  **Problem:** Enterprise teams need to analyze routing data in spreadsheets, dashboards, or BI tools. A JSONL log file is machine-readable but not everyone can parse it.

  **Implementation:** Register a command `smart-router.exportAnalytics` that reads `~/.smart-router/routing.jsonl` and exports it as a CSV file. Columns: timestamp, tier, score, model, mode, intent, reasons, tokens, response_ms, success. Open a save dialog so the user can choose where to save. Also show a summary in a webview: total requests, tier breakdown, model breakdown, average response time, estimated cost savings.

  **Files:** `src/extension.ts` (register command), new `src/analytics.ts` (JSONL → CSV conversion, summary generation)

---

## Enterprise Features

- [ ] **58. Team-shared routing config**

  **Problem:** In a team setting, every developer configures Smart Router independently. This leads to inconsistent routing, different model preferences, and no ability for a tech lead to set a baseline configuration for the whole team.

  **Implementation:** Support a `.smartrouter.json` file at the repository root. This file is committed to git and applies to all team members. Format:
  ```json
  {
    "bias": "quality",
    "thresholds": { "simple": 2, "medium": 5 },
    "chains": {
      "simple": ["gpt-5.4-mini"],
      "medium": ["claude-sonnet-4.6", "gpt-5.4"],
      "complex": ["claude-opus-4.6"]
    },
    "blocklist": ["gpt-4o-mini"],
    "languageOverrides": { "rust": "claude-opus-4.6" }
  }
  ```
  On activation, check for this file. Settings cascade: `.smartrouter.json` < `.vscode/settings.json` < user settings. Team config provides the baseline, individual devs can still override.

  **Files:** `src/extension.ts` (load `.smartrouter.json` on activation), `src/models.ts` (merge config), `src/classifier.ts` (merge thresholds)

---

- [ ] **59. Cost budget alerts**

  **Problem:** Enterprise teams often have Copilot licensing with cost implications for premium models. Without budget tracking, a team can unknowingly burn through their allocation sending low-value prompts to Opus.

  **Implementation:** Add a setting `smart-router.dailyBudget` as a cost multiplier total (e.g., `"100x"` means 100 equivalent simple-model requests). Track cumulative cost per day using `costMultiplier` from `ModelProfile` (task #15). Warn at 80% and 95% of budget. At 100%, auto-switch to economy mode (task #43) and notify: "Daily budget reached — routing in economy mode until tomorrow."

  Store the daily counter in `globalState` with a date key so it resets each day.

  **Files:** `src/extension.ts` (budget tracking, warnings), `package.json` (declare setting)

---

- [ ] **60. Audit log compliance**

  **Problem:** Some enterprises require structured audit logs for all AI interactions. The routing log (task #53) is a good start but needs to meet compliance standards: structured JSON, timestamps in ISO 8601, no PII, deterministic fields.

  **Implementation:** Extend the routing log format with compliance fields:
  ```json
  {
    "version": "1.0",
    "timestamp": "2026-03-27T19:02:34.886Z",
    "event": "model_routing",
    "tier": "medium",
    "score": 5,
    "model_family": "claude-sonnet-4.6",
    "model_id": "claude-sonnet-4.6-2026-03-17",
    "mode": "agent",
    "intent": "refactor",
    "token_estimate": 4200,
    "response_time_ms": 1873,
    "success": true,
    "escalated": false,
    "workspace_hash": "a1b2c3d4",
    "session_id": "uuid-v4"
  }
  ```
  Never include prompt content, file paths, or user-identifiable information. The `workspace_hash` is a one-way hash of the workspace path for correlation without identification.

  **Files:** `src/logger.ts` (extend log format with compliance fields)

---

- [ ] **61. Admin lockdown**

  **Problem:** An org admin may want to force all team members to use economy mode, or block specific expensive models. There's no mechanism for org-level policy enforcement.

  **Implementation:** Support an environment variable `SMART_ROUTER_POLICY` pointing to a JSON policy file, or read from a well-known path (`~/.smart-router/policy.json`). Policy format:
  ```json
  {
    "maxTier": "medium",
    "blocklist": ["claude-opus-4.6", "gpt-5.3-codex"],
    "forceBias": "economy"
  }
  ```
  When a policy is active, it overrides all user and workspace settings. Show a lock icon in the status bar: `$(lock) Smart (policy)`. Policy settings cannot be overridden by the user.

  **Files:** `src/extension.ts` (load policy on activation), `src/models.ts` (enforce policy constraints), `src/classifier.ts` (enforce maxTier)

---

## Code Quality & Architecture

- [ ] **62. Classifier as pure function**

  **Problem:** The classifier currently takes `(prompt, references)` and returns `(tier, score, reasons)`. This is already close to pure, but the new signals (tasks #1–14) need additional metadata: mode, language, message count, selection size, git diff size. The function signature needs to accept a structured metadata object.

  **Implementation:** Define a `ClassifierInput` interface:
  ```ts
  interface ClassifierInput {
    prompt: string;
    references: readonly ChatPromptReference[];
    mode?: "ask" | "edit" | "agent";
    language?: string;
    messageCount?: number;
    selectionLines?: number;
    changedFiles?: number;
    workspaceFileCount?: number;
  }
  ```
  Refactor `classifyComplexity()` to accept `ClassifierInput` instead of separate params. The function remains pure — no side effects, no async, no VS Code API calls. All VS Code data gathering happens in `extension.ts` and is passed in as metadata.

  **Files:** `src/classifier.ts` (define interface, refactor function signature)

---

- [ ] **63. Unit tests for classifier**

  **Problem:** The classifier has zero tests. Every signal function, every keyword, every threshold could break silently. For an enterprise-grade routing system, the classifier must be thoroughly tested.

  **Implementation:** Create `src/test/classifier.test.ts` with tests for:
  - `scoreLength`: short (0 pts), medium (1 pt), moderate (2 pts), long (3 pts)
  - `scoreCode`: no code (0), small block (1), large/multiple blocks (2)
  - `scoreKeywords`: no keywords (0), one keyword (1), cap at 3 pts
  - `scoreKeywords` with code stripping (task #14): keyword in code block → 0 pts
  - `scoreMultiStep`: single pattern (0 pts with current, 1 pt after task #13), multiple patterns (2 pts)
  - `scoreReferences`: 0, 2, 3, 5, 8+ references
  - Full `classifyComplexity`: integration tests with representative prompts mapping to expected tiers
  - Edge cases: empty prompt, extremely long prompt (10k chars), prompt that is only code, prompt that is only numbers

  Use VS Code's built-in test runner or a standalone Mocha setup since classifier is pure TypeScript with no VS Code runtime dependency (only type imports).

  **Files:** new `src/test/classifier.test.ts`, `package.json` (add test script)

---

- [ ] **64. Integration test: end-to-end routing**

  **Problem:** The full routing flow (classify → select model → send request → stream response) can only be tested with mocks for the VS Code API. Without integration tests, changes to any file could silently break the flow.

  **Implementation:** Create `src/test/routing.test.ts`. Mock `vscode.lm.selectChatModels` to return a known set of fake models. Mock `model.sendRequest` to return a fake stream. Then call the provider's `provideLanguageModelChatResponse` and verify:
  - Correct model was selected for the given prompt
  - Response parts were streamed through
  - Correct tier and reasons were logged

  Test scenarios:
  - "hi" → simple tier → cheapest model
  - "refactor this entire module for better performance across all services" → complex tier → strongest model
  - Long code block + "review this" → complex tier
  - Agent mode (tools present) → tool-capable model

  **Files:** new `src/test/routing.test.ts`

---

- [ ] **65. Benchmark classifier performance**

  **Problem:** The classifier runs on every user message. If it ever exceeds 5ms, users will feel the delay. We need a performance regression test to catch accidental slowdowns.

  **Implementation:** Create `src/test/bench.ts` that:
  1. Generates 100 representative prompts of varying lengths (10 words to 10,000 chars)
  2. Runs `classifyComplexity()` on each one 1000 times
  3. Reports p50, p90, p99 latency
  4. Fails if p99 exceeds 1ms

  Run as part of the test suite. This ensures new signals don't accidentally add expensive operations to the hot path.

  **Files:** new `src/test/bench.ts`

---

- [ ] **66. Snapshot tests for routing decisions**

  **Problem:** As the classifier evolves, routing behavior changes in subtle ways. A keyword change or threshold tweak could affect hundreds of real prompts. Snapshot tests catch unintended regressions.

  **Implementation:** Create a file `src/test/snapshots.json` with 30+ representative prompts and their expected routing output:
  ```json
  [
    { "prompt": "hi", "expectedTier": "simple" },
    { "prompt": "refactor this microservice architecture for better scalability", "expectedTier": "complex" },
    { "prompt": "fix the typo on line 42", "expectedTier": "simple" },
    { "prompt": "review this PR for security vulnerabilities", "expectedTier": "complex" }
  ]
  ```
  The test loads the snapshots, runs the classifier on each, and asserts the tier matches. When a routing change is intentional, update the snapshot. When it's unintentional, the test catches it.

  **Files:** new `src/test/snapshots.json`, new `src/test/snapshot.test.ts`

---

## Patcher Improvements

- [ ] **67. Version-agnostic pattern matching**

  **Problem:** The current patcher uses exact regex patterns against minified variable names (`/return this\._currentModels=(\w+),this\._chatEndpoints=(\w+),\1/`). Even minor Copilot Chat updates can change variable names (e.g., `a` → `b`), breaking the patterns. The patcher already extracts variable names dynamically, but the anchor patterns themselves are brittle.

  **Implementation:** Make patterns more resilient:
  - Use `\w+` for ALL variable names (already done for extracted names)
  - Allow optional whitespace: `\s*` between operators
  - Use property names (stable across minification) as primary anchors: `_currentModels`, `_chatEndpoints`, `_modelFetcher`, `getChatModelFromApiModel`, `getOrCreateChatEndpointInstance`
  - Test patterns against 3 different Copilot Chat versions to ensure they generalize

  **Files:** `src/patcher.ts` (make regex patterns more flexible)

---

- [ ] **68. Multi-version support**

  **Problem:** When Copilot Chat releases a new version, the patcher may break. Users are stuck until Smart Router is updated. Supporting multiple versions provides a grace period.

  **Implementation:** Store patch patterns per Copilot Chat version range:
  ```ts
  const PATCH_SETS: { versionRange: string; patterns: PatchPatterns }[] = [
    { versionRange: ">=0.41.0 <0.42.0", patterns: { /* current patterns */ } },
    { versionRange: ">=0.42.0 <0.43.0", patterns: { /* future patterns */ } },
  ];
  ```
  On activation, read Copilot Chat's `package.json` version and select the matching patch set. If no patch set matches, warn the user that Smart Router needs an update. This buys time between Copilot Chat updates and Smart Router releases.

  **Files:** `src/patcher.ts` (version detection, patch set selection)

---

- [ ] **69. Patch verification test**

  **Problem:** `content.includes(PATCH_MARKER)` confirms the marker was written but doesn't confirm the injected code is syntactically valid or functionally correct. A malformed patch could silently break Copilot Chat.

  **Implementation:** After writing the patched file, perform a lightweight syntax check:
  1. Attempt to parse the first 1000 chars around each injection point using a simple bracket-matching checker (not a full JS parser — the file is 19MB)
  2. Verify the injection contains the expected function calls: `selectChatModels`, `createInstance`, `smart-router-auto`
  3. Verify the total file size increased by the expected amount (within ±100 bytes)

  If verification fails, restore the backup and log the error.

  **Files:** `src/patcher.ts` (add post-patch verification)

---

- [ ] **70. Atomic patch application**

  **Problem:** Currently, Patch 1 and Patch 2 are applied sequentially. If Patch 1 succeeds but Patch 2 fails, the file is left half-patched — Smart Router appears in the model list but doesn't work when selected. This is worse than not patching at all.

  **Implementation:** Apply both patches to a temporary string. Only if BOTH patches succeed, write the result to disk. If either fails, write nothing and return "failed". This is a simple change:
  ```ts
  let patched = content;
  patched = applyModelListPatch(patched, names, log);
  patched = applyEndpointPatch(patched, names, log);
  if (patched === content) {
    // Neither patch applied
    return "failed";
  }
  // Both succeeded → only now write to disk
  fs.writeFileSync(extensionJs, patched, "utf-8");
  ```
  Also verify that `patched` contains both injection markers before writing.

  **Files:** `src/patcher.ts` (restructure to apply-then-validate-then-write)

---

## Documentation & Onboarding

- [ ] **71. README routing explanation**

  **Problem:** The README doesn't explain how routing works internally. Users and contributors don't know what signals are used, how tiers are defined, or how to customize the chains. For an open-source/enterprise tool, this transparency is essential for adoption.

  **Implementation:** Add a "How Routing Works" section to `README.md`:
  - Diagram: Prompt → Classifier (signals) → Tier → Model Chain → Selected Model
  - List all signal functions with examples
  - Show the tier thresholds
  - Show the default model chains
  - Explain the bias setting
  - Show an example log line from the output channel

  **Files:** `README.md`

---

- [ ] **72. Animated GIF in README**

  **Problem:** A picture is worth a thousand words. Showing Smart Router in action — the model selection, the status bar update, the response streaming — immediately communicates the value proposition.

  **Implementation:** Record a short (10-second) GIF showing:
  1. User opens Copilot Chat, Smart Router is selected in the model picker
  2. User types a simple question → status bar shows "→ gpt-5.4-mini (simple)"
  3. Response streams quickly
  4. User types a complex question → status bar shows "→ claude-opus-4.6 (complex)"
  5. Embed in README with alt text

  **Files:** `README.md` (embed GIF), create/record GIF asset

---

- [ ] **73. Troubleshooting guide**

  **Problem:** When Smart Router doesn't work, users don't know how to diagnose the issue. Common problems include: model not appearing in picker, patch not applying, no response when selected, extension not activating. Each has a different fix.

  **Implementation:** Add a "Troubleshooting" section to README or a separate `TROUBLESHOOTING.md`:
  - "Smart Router doesn't appear in the model picker" → Check proposed API is enabled in argv.json, check patcher logs in output channel
  - "Smart Router appears but no response" → Check output channel for routing logs, verify `provideLanguageModelChatResponse CALLED` appears
  - "Patch failed" → Check Copilot Chat version, run `smart-router.diagnose` command
  - "Getting error after Copilot Chat update" → Run `smart-router.unpatch` then `smart-router.patch`, or reload
  - Include: how to open the output channel, how to run diagnostic commands

  **Files:** `README.md` or new `TROUBLESHOOTING.md`

---

- [ ] **74. Changelog**

  **Problem:** Users and enterprise teams need to know what changed in each version — especially changes to routing logic that affect which models are selected. Without a changelog, teams can't assess whether to update.

  **Implementation:** Create `CHANGELOG.md` with semver-formatted entries:
  ```
  ## [0.3.0] - 2026-03-28
  ### Changed
  - Updated default model chains: simple → gpt-5.4-mini, medium → claude-sonnet-4.6, complex → claude-opus-4.6
  - Added ambiguity scoring to classifier
  - Cached model list and token counting model for faster routing
  ### Fixed
  - Infinite loop during model list building
  - Endpoint resolution falling back to gpt-4o-mini instead of routing through Smart Router provider
  ```
  Update on every release.

  **Files:** new `CHANGELOG.md`

---

## Future-Proofing

- [ ] **75. Model discovery**

  **Problem:** The current system hardcodes model family names in `DEFAULT_CHAINS`. When new models appear (GPT-5.5, Claude Sonnet 5, etc.), the chains must be manually updated. In a fast-moving environment, new models can appear monthly.

  **Implementation:** On activation, enumerate all available models via `selectChatModels({ vendor: "copilot" })`. Match each model against known profiles (task #15). For unknown models, infer tier from naming conventions:
  - "mini" in name → fast tier
  - "codex" in name → code-specialized, balanced tier
  - "opus" / "max" / "pro" in name → strong tier
  - Others → balanced tier

  Dynamically build the fallback chains from discovered models ranked by their profile scores. Fall back to `DEFAULT_CHAINS` only if discovery finds zero models.

  **Files:** `src/models.ts` (dynamic chain building from discovered models)

---

- [ ] **76. Plugin architecture for signals**

  **Problem:** Custom routing signals will always be needed for specific teams and workflows. A Jira integration team might want to route based on ticket priority. A security team might want to always use Opus for files in `/src/auth/`. Building all these into the core classifier doesn't scale.

  **Implementation:** Define a `RoutingSignal` interface that custom extensions can implement:
  ```ts
  interface RoutingSignal {
    name: string;
    evaluate(input: ClassifierInput): { points: number; reason: string };
  }
  ```
  Expose a registration API: `smartRouter.registerSignal(signal)`. The classifier collects all registered signals and includes them in scoring. Third-party extensions can add signals without modifying Smart Router's code.

  This is a later-stage feature — implement after the core classifier (tasks #1–14) is stable.

  **Files:** `src/classifier.ts` (signal registry), `src/extension.ts` (expose API)

---

- [ ] **77. A/B routing mode**

  **Problem:** Users sometimes wonder: "would the other model have been better?" There's no way to compare without switching models and re-sending. An A/B mode would let users see both responses and learn which model is better for their tasks.

  **Implementation:** Register a command `smart-router.abTest`. When active, Smart Router sends the same prompt to two models (the selected tier + one tier up) in parallel. Display both responses in a side-by-side diff or sequential format. At the bottom, ask: "Which response was better? [A] [B]". Log the choice. Over time, this data could refine the routing logic.

  This is an advanced/experimental feature. The main challenge is displaying two responses in Copilot Chat's single-stream UI — this may require a webview or a creative use of progress streaming with labeled sections.

  **Files:** `src/extension.ts` (A/B command, parallel requests), possibly webview for display

