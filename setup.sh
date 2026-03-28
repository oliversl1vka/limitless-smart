#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
#  Smart Router — One-click setup & install
#  Run:  chmod +x setup.sh && ./setup.sh
# ──────────────────────────────────────────────────────────────────────

set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

step() { printf "\n  \033[36m[%s/7] %s\033[0m\n  %s\n" "$1" "$2" "$(printf '%0.s-' {1..50})"; }
ok()   { printf "    \033[32m%s\033[0m\n" "$1"; }
warn() { printf "    \033[33m%s\033[0m\n" "$1"; }
fail() { printf "\n  \033[31mERROR: %s\033[0m\n\n" "$1"; exit 1; }

# ── Header ────────────────────────────────────────────────────────────
WHITE='\033[97m'
GREEN='\033[38;2;73;201;149m'
MINT='\033[38;2;159;255;229m'
RESET='\033[0m'

printf "\n"
printf "  ${WHITE} ██████ ███    ███  █████  ██████  ████████${RESET}\n"
printf "  ${GREEN}██      ████  ████ ██   ██ ██   ██    ██   ${RESET}\n"
printf "  ${GREEN} █████  ██ ████ ██ ███████ ██████     ██   ${RESET}\n"
printf "  ${MINT}     ██ ██  ██  ██ ██   ██ ██   ██    ██   ${RESET}\n"
printf "  ${WHITE}██████  ██      ██ ██   ██ ██   ██    ██   ${RESET}\n"
printf "  ${MINT}██████   ██████  ██    ██ ████████ ███████ ██████ ${RESET}\n"
printf "  ${GREEN}██   ██ ██    ██ ██    ██    ██    ██      ██   ██${RESET}\n"
printf "  ${GREEN}██████  ██    ██ ██    ██    ██    █████   ██████ ${RESET}\n"
printf "  ${WHITE}██   ██ ██    ██ ██    ██    ██    ██      ██   ██${RESET}\n"
printf "  ${MINT}██   ██  ██████   ██████     ██    ███████ ██   ██${RESET}\n"
printf "\n"
printf "  ${WHITE}Smart Router Setup Script${RESET}\n"
printf "  Routes your Copilot Chat messages to the\n"
printf "  optimal model automatically.\n\n"

# ── 1. Check prerequisites ───────────────────────────────────────────
step 1 "Checking prerequisites..."

command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Download it from https://nodejs.org"
ok "Node.js    : $(node --version)"

command -v npm >/dev/null 2>&1 || fail "npm is not found. It should come with Node.js."
ok "npm        : $(npm --version)"

CODE_CLI=""
if command -v code >/dev/null 2>&1; then
    CODE_CLI="code"
elif command -v code-insiders >/dev/null 2>&1; then
    CODE_CLI="code-insiders"
else
    fail "VS Code CLI (code) not found. Make sure VS Code is installed and on your PATH."
fi
ok "VS Code    : $CODE_CLI ($(command -v "$CODE_CLI"))"

if ! "$CODE_CLI" --list-extensions 2>/dev/null | grep -q "github.copilot-chat"; then
    warn "Copilot Chat not found — installing..."
    "$CODE_CLI" --install-extension github.copilot-chat --force >/dev/null 2>&1
    ok "Copilot    : installed"
else
    ok "Copilot    : installed"
fi

# ── 2. Install dependencies ──────────────────────────────────────────
step 2 "Installing dependencies..."
cd "$ROOT"
npm install --silent 2>/dev/null
ok "node_modules ready"

# ── 3. Compile TypeScript ────────────────────────────────────────────
step 3 "Compiling TypeScript..."
cd "$ROOT"
npx tsc -p ./
ok "Build succeeded (out/)"

# ── 4. Package extension ─────────────────────────────────────────────
step 4 "Packaging extension (.vsix)..."
cd "$ROOT"

if [ ! -f "node_modules/.bin/vsce" ] && ! command -v vsce >/dev/null 2>&1; then
    npm install --save-dev @vscode/vsce --silent 2>/dev/null
fi

VSCE_CMD="vsce"
[ -f "node_modules/.bin/vsce" ] && VSCE_CMD="node_modules/.bin/vsce"

# Ensure LICENSE exists
if [ ! -f LICENSE ] && [ ! -f LICENSE.md ] && [ ! -f LICENSE.txt ]; then
    echo "MIT License" > LICENSE.txt
fi

echo y | "$VSCE_CMD" package --allow-missing-repository >/dev/null 2>&1

VSIX_FILE=$(ls -t "$ROOT"/*.vsix 2>/dev/null | head -1)
[ -z "$VSIX_FILE" ] && fail "VSIX packaging failed."
ok "Created: $(basename "$VSIX_FILE")"

# ── 5. Install into VS Code ──────────────────────────────────────────
step 5 "Installing into VS Code..."
"$CODE_CLI" --install-extension "$VSIX_FILE" --force >/dev/null 2>&1

if "$CODE_CLI" --list-extensions 2>/dev/null | grep -q "smartrouter.smart-router"; then
    ok "Extension installed!"
else
    fail "Installation could not be verified. Try:\n    $CODE_CLI --install-extension \"$VSIX_FILE\""
fi

# ── 6. Enable proposed API in VS Code argv.json ──────────────────────
step 6 "Enabling model picker integration..."

if [[ "$OSTYPE" == darwin* ]]; then
    ARGV_JSON="$HOME/Library/Application Support/Code/argv.json"
    [ ! -f "$ARGV_JSON" ] && ARGV_JSON="$HOME/Library/Application Support/Code - Insiders/argv.json"
else
    ARGV_JSON="${XDG_CONFIG_HOME:-$HOME/.config}/Code/argv.json"
    [ ! -f "$ARGV_JSON" ] && ARGV_JSON="${XDG_CONFIG_HOME:-$HOME/.config}/Code - Insiders/argv.json"
fi

EXT_ID="smartrouter.smart-router"

if [ -f "$ARGV_JSON" ]; then
    if command -v python3 >/dev/null 2>&1; then
        python3 -c "
import json, sys
path = sys.argv[1]
ext = sys.argv[2]
try:
    with open(path) as f:
        data = json.load(f)
except Exception:
    data = {}
lst = data.get('enable-proposed-api', [])
if ext not in lst:
    lst.append(ext)
    data['enable-proposed-api'] = lst
    with open(path, 'w') as f:
        json.dump(data, f, indent=4)
" "$ARGV_JSON" "$EXT_ID"
        ok "Proposed API enabled in argv.json"
    else
        warn "python3 not found — cannot patch argv.json automatically"
        warn "Manually add to $ARGV_JSON:"
        warn '  "enable-proposed-api": ["smartrouter.smart-router"]'
    fi
else
    ARGV_DIR="$(dirname "$ARGV_JSON")"
    mkdir -p "$ARGV_DIR"
    printf '{\n    "enable-proposed-api": ["%s"]\n}\n' "$EXT_ID" > "$ARGV_JSON"
    ok "Created argv.json with proposed API enabled"
fi

# ── 7. Done — onboarding ─────────────────────────────────────────────
step 7 "You're all set!"

printf "\n"
printf "  \033[32m=============================================\033[0m\n"
printf "     Smart Router is installed!\n"
printf "  \033[32m=============================================\033[0m\n"
printf "\n"
printf "  \033[33mNext steps:\033[0m\n\n"
printf "    1. Restart VS Code (close & reopen)\n\n"
printf "    2. Select 'Smart Router' in the Copilot model picker\n\n"
printf "    3. Just type your question — the right model\n"
printf "       is picked automatically!\n\n"
printf "  \033[33mModel routing:\033[0m\n"
printf "    \033[36mSimple questions  -> claude-3.5-haiku / gpt-5.4-mini\033[0m\n"
printf "    \033[36mMedium tasks      -> claude-sonnet-4  / gpt-5.4\033[0m\n"
printf "    \033[34mComplex problems  -> claude-opus-4    / o1\033[0m\n\n"
printf "  \033[90mCustomize: Settings -> Extensions -> Smart Router\033[0m\n\n"
