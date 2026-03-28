$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$esc = [char]27
$script:CurrentPercent = 0

$logoLines = @(
    " ██████ ███    ███  █████  ██████  ████████",
    "██      ████  ████ ██   ██ ██   ██    ██   ",
    " █████  ██ ████ ██ ███████ ██████     ██   ",
    "     ██ ██  ██  ██ ██   ██ ██   ██    ██   ",
    "██████  ██      ██ ██   ██ ██   ██    ██   ",
    "",
    "██████   ██████  ██    ██ ████████ ███████ ██████ ",
    "██   ██ ██    ██ ██    ██    ██    ██      ██   ██",
    "██████  ██    ██ ██    ██    ██    █████   ██████ ",
    "██   ██ ██    ██ ██    ██    ██    ██      ██   ██",
    "██   ██  ██████   ██████     ██    ███████ ██   ██"
)

function Get-RgbSequence {
    param([int]$r, [int]$g, [int]$b)
    return "${esc}[38;2;${r};${g};${b}m"
}

function Get-VisibleLength {
    param([string]$text)
    return ($text -replace "$esc\[[0-9;]*m", "").Length
}

function Write-CenteredLine {
    param([string]$text)

    $width = [Math]::Max([Console]::WindowWidth, 80)
    $padding = [Math]::Max([Math]::Floor(($width - (Get-VisibleLength $text)) / 2), 0)
    Write-Host ((" " * $padding) + $text)
}

function Show-LogoFrame {
    param([int]$frameIndex)

    $baseA = @(255, 255, 255)
    $baseB = @(73, 201, 149)
    $shine = @(159, 255, 229)
    $reset = "${esc}[0m"

    foreach ($y in 0..($logoLines.Count - 1)) {
        $line = $logoLines[$y]
        $parts = [System.Collections.Generic.List[string]]::new()
        $shineCenter = ($line.Length - 1) - ($frameIndex * 5) - ($y * 2)

        for ($x = 0; $x -lt $line.Length; $x++) {
            $char = $line[$x]
            if ($char -eq ' ') {
                $parts.Add(' ')
                continue
            }

            $mixBase = [Math]::Min(($x + ($y * 3)) / [Math]::Max(($line.Length + 12), 1), 1)
            $r = [int]($baseA[0] + (($baseB[0] - $baseA[0]) * $mixBase))
            $g = [int]($baseA[1] + (($baseB[1] - $baseA[1]) * $mixBase))
            $b = [int]($baseA[2] + (($baseB[2] - $baseA[2]) * $mixBase))

            $distance = [Math]::Abs($x - $shineCenter)
            if ($distance -le 1) {
                $shineMix = 1.0
            } elseif ($distance -le 3) {
                $shineMix = 0.45
            } else {
                $shineMix = 0.0
            }

            if ($shineMix -gt 0) {
                $r = [int]($r + (($shine[0] - $r) * $shineMix))
                $g = [int]($g + (($shine[1] - $g) * $shineMix))
                $b = [int]($b + (($shine[2] - $b) * $shineMix))
            }

            $parts.Add("$(Get-RgbSequence $r $g $b)$char$reset")
        }

        Write-CenteredLine ($parts -join "")
    }
}

function Show-LogoAnimation {
    $subtitleColor = Get-RgbSequence 170 255 229
    $reset = "${esc}[0m"

    foreach ($frame in 0..9) {
        Clear-Host
        Write-Host ""
        Write-Host ""
        Show-LogoFrame -frameIndex $frame
        Write-Host ""
        Write-CenteredLine "${subtitleColor} Smart Router installer ${reset}"
        Start-Sleep -Milliseconds 85
    }

    Start-Sleep -Milliseconds 150
}

function Show-InstallerScreen {
    param(
        [int]$percent,
        [string]$title,
        [string]$detail
    )

    $reset = "${esc}[0m"
    $titleColor = Get-RgbSequence 184 255 232
    $detailColor = Get-RgbSequence 128 204 188
    $labelColor = Get-RgbSequence 214 255 244
    $fillColor = Get-RgbSequence 63 235 202
    $emptyColor = Get-RgbSequence 29 70 68
    $footerColor = Get-RgbSequence 89 184 171

    $barWidth = 42
    $filled = [Math]::Min([Math]::Floor(($percent / 100) * $barWidth), $barWidth)
    $empty = $barWidth - $filled
    $bar = ($fillColor + ("#" * $filled)) + ($emptyColor + ("-" * $empty)) + $reset

    Clear-Host
    Write-Host ""
    Show-LogoFrame -frameIndex 3
    Write-Host ""
    Write-CenteredLine "${titleColor}${title}${reset}"
    Write-Host ""
    Write-CenteredLine $bar
    Write-CenteredLine "${labelColor}${percent}%${reset}"
    Write-Host ""
    Write-CenteredLine "${detailColor}${detail}${reset}"
    Write-Host ""
    Write-CenteredLine "${footerColor} Preparing your VS Code plus Copilot environment ${reset}"
}

function Set-InstallerProgress {
    param(
        [int]$percent,
        [string]$title,
        [string]$detail,
        [int]$delay = 20
    )

    $start = $script:CurrentPercent
    if ($percent -lt $start) {
        $start = $percent
    }

    for ($value = $start; $value -le $percent; $value++) {
        Show-InstallerScreen -percent $value -title $title -detail $detail
        Start-Sleep -Milliseconds $delay
    }

    $script:CurrentPercent = $percent
}

function Show-FailureScreen {
    param([string]$message)

    $reset = "${esc}[0m"
    $errorColor = Get-RgbSequence 255 130 160
    $detailColor = Get-RgbSequence 255 219 228

    Clear-Host
    Write-Host ""
    Show-LogoFrame -frameIndex 3
    Write-Host ""
    Write-CenteredLine "${errorColor} Installation failed ${reset}"
    Write-Host ""

    foreach ($line in ($message -split "`r?`n")) {
        if ($line.Trim().Length -gt 0) {
            Write-CenteredLine "${detailColor}${line}${reset}"
        }
    }

    Write-Host ""
    exit 1
}

function Fail {
    param([string]$message)
    Show-FailureScreen -message $message
}

function Invoke-ExternalCommand {
    param(
        [scriptblock]$Command,
        [string]$FailureMessage
    )

    $output = & $Command 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        $trimmed = $output.Trim()
        if ($trimmed.Length -eq 0) {
            Fail $FailureMessage
        } else {
            $lines = $trimmed -split "`r?`n"
            $tail = ($lines | Select-Object -Last 8) -join "`n"
            Fail "$FailureMessage`n`n$tail"
        }
    }
    return $output.Trim()
}

function Find-CodeCli {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\bin\code.cmd"),
        "code.cmd",
        "code"
    )

    foreach ($candidate in $candidates) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command) {
            return $command.Source
        }
    }

    return $null
}

function Show-SuccessScreen {
    $reset = "${esc}[0m"
    $headline = Get-RgbSequence 184 255 232
    $body = Get-RgbSequence 215 255 244
    $subtle = Get-RgbSequence 123 193 180

    Clear-Host
    Write-Host ""
    Show-LogoFrame -frameIndex 4
    Write-Host ""
    Write-CenteredLine "${headline} Smart Router is installed ${reset}"
    Write-Host ""
    Write-CenteredLine "${body} 1. Restart VS Code (close & reopen) ${reset}"
    Write-CenteredLine "${body} 2. Select 'Smart Router' in the Copilot model picker ${reset}"
    Write-CenteredLine "${body} 3. Just chat — the right model is picked automatically ${reset}"
    Write-Host ""
    Write-CenteredLine "${subtle} Simple -> Haiku or GPT-5.4 mini   Medium -> Sonnet or GPT-5.4   Complex -> Opus 4.6 ${reset}"
    Write-CenteredLine "${subtle} Settings / Extensions / Smart Router ${reset}"
    Write-Host ""
}

Show-LogoAnimation
Set-InstallerProgress -percent 6 -title "Bootstrapping installer" -detail "Checking your local environment"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "Node.js is not installed.`nDownload it from https://nodejs.org"
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail "npm is not available.`nIt should be installed with Node.js"
}

$codeCli = Find-CodeCli
if (-not $codeCli) {
    Fail "VS Code CLI was not found.`nInstall VS Code and make sure the code command is available"
}

Set-InstallerProgress -percent 16 -title "Checking prerequisites" -detail "Node, npm, and VS Code CLI detected"

$extensions = Invoke-ExternalCommand -Command { & $codeCli --list-extensions } -FailureMessage "Unable to list VS Code extensions"
if ($extensions -notmatch "github\.copilot-chat") {
    Set-InstallerProgress -percent 24 -title "Preparing Copilot Chat" -detail "Installing GitHub Copilot Chat"
    Invoke-ExternalCommand -Command { & $codeCli --install-extension github.copilot-chat --force } -FailureMessage "Unable to install GitHub Copilot Chat"
} else {
    Set-InstallerProgress -percent 24 -title "Preparing Copilot Chat" -detail "GitHub Copilot Chat is already installed"
}

Push-Location $root
try {
    Set-InstallerProgress -percent 40 -title "Installing dependencies" -detail "Resolving npm packages"
    Invoke-ExternalCommand -Command { npm install --silent } -FailureMessage "npm install failed"

    Set-InstallerProgress -percent 58 -title "Compiling extension" -detail "Building TypeScript sources"
    Invoke-ExternalCommand -Command { npx tsc -p ./ } -FailureMessage "TypeScript compilation failed"

    $vsceLocal = Join-Path $root "node_modules/.bin/vsce.cmd"
    if ((-not (Test-Path $vsceLocal)) -and (-not (Get-Command vsce -ErrorAction SilentlyContinue))) {
        Set-InstallerProgress -percent 68 -title "Preparing packager" -detail "Installing VS Code packaging tools"
        Invoke-ExternalCommand -Command { npm install --save-dev @vscode/vsce --silent } -FailureMessage "Unable to install @vscode/vsce"
    } else {
        Set-InstallerProgress -percent 68 -title "Preparing packager" -detail "Packaging tools already available"
    }

    if ((-not (Test-Path "LICENSE")) -and (-not (Test-Path "LICENSE.md")) -and (-not (Test-Path "LICENSE.txt"))) {
        Set-Content -Path "LICENSE.txt" -Value "MIT License" -Encoding UTF8
    }

    $vsceCmd = if (Test-Path $vsceLocal) { $vsceLocal } else { "vsce" }
    Set-InstallerProgress -percent 82 -title "Packaging extension" -detail "Building VSIX bundle"
    Invoke-ExternalCommand -Command {
        $confirmation = "y"
        $confirmation | & $vsceCmd package --allow-missing-repository
    } -FailureMessage "VSIX packaging failed"

    $vsixFile = Get-ChildItem -Path $root -Filter "*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $vsixFile) {
        Fail "Packaging completed without producing a VSIX file"
    }
} finally {
    Pop-Location
}

Set-InstallerProgress -percent 90 -title "Installing in VS Code" -detail "Registering Smart Router locally"
Invoke-ExternalCommand -Command { & $codeCli --install-extension $vsixFile.FullName --force } -FailureMessage "VS Code extension installation failed"

$installed = Invoke-ExternalCommand -Command { & $codeCli --list-extensions } -FailureMessage "Unable to verify installed extensions"
if ($installed -notmatch "smartrouter\.smart-router") {
    Fail "Smart Router could not be verified after installation`nTry: code --install-extension $($vsixFile.FullName) --force"
}

# ── Enable proposed API in VS Code argv.json ──────────────────────────
Set-InstallerProgress -percent 96 -title "Enabling model picker integration" -detail "Configuring VS Code to allow proposed API"

$argvPath = Join-Path $env:USERPROFILE ".vscode\argv.json"
if (Test-Path $argvPath) {
    try {
        $raw = Get-Content -Path $argvPath -Raw
        $jsonOnly = ($raw -split "`n" | Where-Object { $_ -notmatch '^\s*//' }) -join "`n"
        $argvJson = $jsonOnly | ConvertFrom-Json
    } catch {
        $argvJson = [pscustomobject]@{}
    }
} else {
    $argvJson = [pscustomobject]@{}
}

$extId = "smartrouter.smart-router"
$existing = @()
if ($argvJson.PSObject.Properties.Name -contains "enable-proposed-api") {
    $existing = @($argvJson."enable-proposed-api")
}
if ($existing -notcontains $extId) {
    $existing += $extId
}

# Preserve the original file but inject/update the enable-proposed-api key
$raw = if (Test-Path $argvPath) { Get-Content -Path $argvPath -Raw } else { "{`n}" }
$arrayJson = "[" + (($existing | ForEach-Object { "`"$_`"" }) -join ', ') + "]"
if ($raw -match '"enable-proposed-api"') {
    $raw = $raw -replace '"enable-proposed-api"\s*:\s*\[[^\]]*\]', "`"enable-proposed-api`": $arrayJson"
} else {
    $raw = $raw -replace '\}\s*$', ",`n`t`"enable-proposed-api`": $arrayJson`n}"
}
[System.IO.File]::WriteAllText($argvPath, $raw, (New-Object System.Text.UTF8Encoding $false))

Set-InstallerProgress -percent 100 -title "Installation complete" -detail "Smart Router is ready"
Start-Sleep -Milliseconds 250
Show-SuccessScreen
