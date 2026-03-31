<img src="Smart router digital logo design.png" alt="Smart Router" width="480"/>

# Smart Router

A VS Code extension that automatically routes your Copilot Chat messages to the optimal model based on complexity analysis — zero config needed, fully customizable.

## Quick Start

### One-command install (recommended)

The intended flow is simple:

1. Open this repo in VS Code
2. Open the `smart-router` folder directly
3. Open the integrated terminal
4. Type:

**Windows:**
```bat
smartrouter
```

This workspace defaults the integrated terminal to **Command Prompt**, so the local `smartrouter.cmd` launcher works immediately for a brand new user.

**Mac / Linux:**
```bash
chmod +x smartrouter && ./smartrouter
```

The installer handles the rest: dependencies, build, packaging, extension install. When it finishes, reload VS Code and the extension is ready.

### Direct script fallback

If you prefer, you can still run the installer directly:

**Windows (PowerShell):**
```powershell
.\setup.ps1
```

**Mac / Linux:**
```bash
chmod +x setup.sh && ./setup.sh
```

### Manual install

1. Open the `smart-router` folder in a terminal
2. `npm install`
3. `npm run compile`
4. `npx vsce package --allow-missing-repository`
5. `code --install-extension smart-router-0.2.0.vsix`
6. Reload VS Code (`Ctrl+Shift+P` → "Reload Window")

Or press **Ctrl+Alt+S** / click the **🤖 Smart** button in the status bar.

## How It Works

Select **Smart Router** in the model picker, then just type your message. The extension scores it using multiple heuristic signals:

| Signal | Max Points | Description |
|---|---|---|
| Message length (word count) | 3 | Longer messages suggest more complex tasks |
| Code block presence & size | 2 | Large or multiple code blocks add complexity |
| Complexity keywords | 3 | Architecture, algorithm, refactor, security… |
| Multi-step / multi-question | 2 | Sequential instructions or multiple questions |
| Attached file references | 3 | 3–4 files = +1, 5–7 = +2, 8+ = +3 |
| Intent detection | −1 to +3 | Explain = −1, generate = +1, review/plan = +2, large-scope = +3 |
| Error/stacktrace context | −1 to +1 | Clear stack trace + "fix" = −1, vague error = +1 |
| Ambiguity | 0 to +2 | Short vague prompts like "fix this" score higher |
| Conversation depth | 0 to +2 | Longer conversations escalate the tier |
| Agent mode (tools present) | +1 | Tool-calling mode needs capable models |
| Language complexity | +1 | Rust, C++, Haskell, etc. add a point |

The routing follows a **20/60/20 split** — most prompts land in medium tier:

| Tier | Score | Default Models (first available wins) |
|---|---|---|
| **Simple** | ≤ 2 | `gpt-5.4-mini` → `claude-haiku-4.5` |
| **Medium** | 3–6 | `claude-sonnet-4.6` → `gpt-5.4` |
| **Complex** | ≥ 7 | `claude-opus-4.6` |

Each tier tries models left-to-right. The first one available from Copilot wins. If every model in the chain is unavailable it falls back to any available Copilot model — routing never fails.

## How Routing Works

The classifier in `src/classifier.ts` runs 11 signal functions against each prompt. Keywords inside code blocks are stripped before scoring so pasted code doesn't inflate the result. The extension also passes metadata from the conversation context:

- **Message count** — longer conversations escalate automatically
- **Tool presence** — agent mode (tool-calling) nudges toward more capable models
- **Active editor language** — complex languages like Rust or C++ add weight
- **File reference count** — inferred from both `#file:` tags and path patterns in the prompt

The tier never downgrades mid-conversation — if a complex discussion started, follow-up messages like "ok do it" stay at the complex tier. On model failure, the router auto-escalates one tier up with a single retry.

### Model Blocklist

Add model families to `smart-router.blocklist` to exclude them from routing:

```jsonc
{
  "smart-router.blocklist": ["gpt-4o-mini"]
}
```

## Configuring Models

Open **Settings → Extensions → Smart Router** (or edit `settings.json` directly):

```jsonc
{
  // Simple tasks — fast & cheap
  "smart-router.models.simple": [
    "gpt-5.4-mini",
    "claude-haiku-4.5"
  ],

  // Medium tasks — balanced
  "smart-router.models.medium": [
    "claude-sonnet-4.6",
    "gpt-5.4"
  ],

  // Complex tasks — deep reasoning
  "smart-router.models.complex": [
    "claude-opus-4.6"
  ]
}
```

Each array is a **fallback chain** — put your preferred model first. You can use any model family that Copilot exposes.

## How to Use

1. Open Copilot Chat
2. Click the **model picker** dropdown at the bottom of the chat pane
3. Select **Smart Router**
4. Just chat — the right model is picked automatically based on prompt complexity

| Prompt complexity | Routes to |
|---|---|
| Simple questions | gpt-5.4-mini / claude-haiku-4.5 |
| Medium tasks | claude-sonnet-4.6 / gpt-5.4 |
| Complex problems | claude-opus-4.6 |

## Keyboard Shortcut

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+S` (Win/Linux) | Open Copilot Chat |
| `Cmd+Alt+S` (Mac) | Open Copilot Chat |

## Commands

| Command | Description |
|---|---|
| `Smart Router: Diagnose Model Registration` | Show all registered models and verify Smart Router is visible |
| `Smart Router: Patch Copilot Chat Model Picker` | Manually inject Smart Router into the Copilot Chat model picker |
| `Smart Router: Remove Patch from Copilot Chat` | Restore the original Copilot Chat bundle |
| `Smart Chat: Open` | Open Copilot Chat (`Ctrl+Alt+S`) |

## Building

```bash
npm run compile    # one-time build
npm run watch      # rebuild on save
```

## Logging & Debugging

1. Open the Output panel (`Ctrl+Shift+U` / `Cmd+Shift+U`)
2. Select **Smart Router** from the dropdown
3. Every routed request logs: tier, score, signal reasons, and selected model

The extension also logs orphaned tool call/result stripping, escalation retries, and conversation continuity decisions.

## Project Structure

```
src/
  classifier.ts   — 11 scoring signals, outputs tier (simple/medium/complex)
  models.ts       — maps tiers to model fallback chains, blocklist, fuzzy matching
  extension.ts    — SmartRouterProvider, routing logic, activation
  proxy.ts        — message normalization, orphan-stripping, provider↔consumer conversion
  patcher.ts      — patches Copilot Chat bundle to inject Smart Router into the model picker
```
