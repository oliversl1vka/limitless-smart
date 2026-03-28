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

Select **Smart Router** in the model picker, then just type your message. The extension scores it (0–10) using five heuristic signals:

| Signal | Max Points |
|---|---|
| Message length (word count) | 3 |
| Code block presence & size | 2 |
| Complexity keywords (architecture, algorithm, refactor…) | 3 |
| Multi-step / multi-question | 1 |
| Attached file references | 1 |

Based on the total score it routes to a model tier:

| Tier | Score | Default Models (first available wins) |
|---|---|---|
| **Simple** | ≤ 4 | `gpt-5.4-mini` → `gpt-4o-mini` → `claude-haiku-4.5` |
| **Medium** | 5–8 | `gpt-5.2` → `claude-sonnet-4.6` → `gpt-5.4` |
| **Complex** | ≥ 9 | `claude-sonnet-4.6` → `gpt-5.4` → `claude-opus-4.6` |

Each tier tries models left-to-right. The first one available from Copilot wins. If every model in the chain is unavailable it falls back to any available Copilot model — routing never fails.

## How Routing Works

The Smart Router extension uses several signal functions to determine the complexity of a message and route it to the appropriate model based on that complexity.

| Signal Function | Description | Example |
| --- | --- | --- |
| `useMessageLength` | Calculates the length of the message in words. | ```typescript const message = "How to bake a cake?"; const length = useMessageLength(message); // length: 5 ``` |
| `useCodeBlockPresenceAndSize` | Determines if there is a code block and its size. | ```typescript const message = "Here's some code:\n\n```python\ndef add(a, b):\n    return a + b\n```"; const result = useCodeBlockPresenceAndSize(message); // { hasCode: true, size: 5 } ``` |
| `useComplexityKeywords` | Checks for complexity keywords in the message. | ```typescript const message = "Explain quantum computing."; const result = useComplexityKeywords(message); // { found: true, keywords: ["quantum", "computing"] } ``` |
| `useMultiStepOrMultiQuestion` | Determines if the message is multi-step or contains multiple questions. | ```typescript const message = "What is the capital of France? What is 2 + 2?"; const result = useMultiStepOrMultiQuestion(message); // { isMultiStep: true } ``` |
| `useAttachedFileReferences` | Checks for attached file references in the message. | ```typescript const message = "Check out this file: project.pdf"; const result = useAttachedFileReferences(message); // { hasFiles: true, files: ["project.pdf"] } ```

Based on the values returned by these signal functions, the total score is calculated and the appropriate model tier is determined.

## Configuring Models

Open **Settings → Extensions → Smart Router** (or edit `settings.json` directly):

```jsonc
{
  // Simple tasks — fast & cheap
  "smart-router.models.simple": [
    "gpt-5.4-mini",
    "gpt-4o-mini",
    "claude-haiku-4.5"
  ],

  // Medium tasks — balanced
  "smart-router.models.medium": [
    "gpt-5.2",
    "claude-sonnet-4.6",
    "gpt-5.4"
  ],

  // Complex tasks — deep reasoning, with the most expensive model reserved last
  "smart-router.models.complex": [
    "claude-sonnet-4.6",
    "gpt-5.4",
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
| Simple questions | gpt-5.4-mini / gpt-4o-mini |
| Medium tasks | gpt-5.2 / claude-sonnet-4.6 |
| Complex problems | claude-sonnet-4.6 / gpt-5.4 / claude-opus-4.6 |

## Keyboard Shortcut

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+S` (Win/Linux) | Open Copilot Chat |
| `Cmd+Alt+S` (Mac) | Open Copilot Chat |

## Building

```bash
npm run compile    # one-time build
npm run watch      # rebuild on save
```


To access logs and run commands, follow these steps:

- Open the Output view in VS Code (`Ctrl+Shift+U` / `Cmd+Shift+U`).
- Navigate to the Smart Router extension output.
- Run any necessary commands directly in the terminal or via the extension interface.
