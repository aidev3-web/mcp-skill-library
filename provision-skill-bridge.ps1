<#
.SYNOPSIS
  One-time provisioning of skill-bridge (mcp-skill-library) on a brand-new
  employee machine that has no personal GitHub account.

.DESCRIPTION
  Run by IT (or a login/provisioning script) with a single shared, IT-managed
  GitHub token. The employee never sees this token and never touches GitHub.
  Idempotent - safe to re-run (e.g. to rotate the token).

.PARAMETER GitHubToken
  The shared, read-only GitHub token (classic PAT with repo + read:packages
  scopes recommended for the GitHub Packages install path used here).

.EXAMPLE
  .\provision-skill-bridge.ps1 -GitHubToken "ghp_xxx"
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$GitHubToken
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# 1. Node.js -------------------------------------------------------------
Write-Step "Checking Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Step "Node.js not found - installing (winget, silent)"
  winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  Write-Host "Node.js installed. Re-run this script in a NEW terminal so PATH picks it up." -ForegroundColor Yellow
  exit 0
} else {
  Write-Host "Node.js found: $(node --version)"
}

# 2. GITHUB_TOKEN (machine-wide - this is a company-owned device) --------
Write-Step "Setting GITHUB_TOKEN (machine-level)"
[System.Environment]::SetEnvironmentVariable("GITHUB_TOKEN", $GitHubToken, "Machine")

# 3. ~/.npmrc for GitHub Packages (current user profile) -----------------
Write-Step "Configuring npm for GitHub Packages (@aidev3-web scope)"
$npmrcPath = Join-Path $HOME ".npmrc"
$lines = @(
  "@aidev3-web:registry=https://npm.pkg.github.com",
  '//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}'
)
$existing = if (Test-Path $npmrcPath) { Get-Content $npmrcPath } else { @() }
foreach ($line in $lines) {
  if ($existing -notcontains $line) {
    Add-Content -Path $npmrcPath -Value $line
  }
}

# 4. Register the MCP server with whichever agents are present -----------
Write-Step "Registering skill-bridge with installed agents"

$claudeCli = Get-Command claude -ErrorAction SilentlyContinue
if ($claudeCli) {
  Write-Host "Claude Code found - registering (user scope)"
  $npxArgs = @("mcp", "add", "--scope", "user", "skill-bridge", "--", "npx", "--yes", "@aidev3-web/mcp-skill-library")
  & claude @npxArgs 2>&1 | Out-Null
}

$claudeDesktopConfig = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
if (Test-Path (Split-Path $claudeDesktopConfig -Parent)) {
  Write-Host "Claude Desktop found - writing config"
  $config = if (Test-Path $claudeDesktopConfig) {
    Get-Content $claudeDesktopConfig -Raw | ConvertFrom-Json
  } else {
    [PSCustomObject]@{}
  }
  if (-not (Get-Member -InputObject $config -Name "mcpServers" -MemberType NoteProperty)) {
    $config | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue ([PSCustomObject]@{})
  }
  $skillBridgeEntry = [PSCustomObject]@{
    command = "npx"
    args    = @("--yes", "@aidev3-web/mcp-skill-library")
    env     = [PSCustomObject]@{ GITHUB_TOKEN = $GitHubToken }
  }
  if (Get-Member -InputObject $config.mcpServers -Name "skill-bridge" -MemberType NoteProperty) {
    $config.mcpServers.'skill-bridge' = $skillBridgeEntry
  } else {
    $config.mcpServers | Add-Member -NotePropertyName "skill-bridge" -NotePropertyValue $skillBridgeEntry
  }
  $config | ConvertTo-Json -Depth 10 | Set-Content $claudeDesktopConfig -Encoding utf8
}

$opencodeCli = Get-Command opencode -ErrorAction SilentlyContinue
if ($opencodeCli) {
  Write-Host "OpenCode found - please add the skill-bridge entry to opencode.json manually (see README)"
}

$codexHome = Join-Path $HOME ".codex"
if (Test-Path $codexHome) {
  $codexConfig = Join-Path $codexHome "config.toml"
  $entry = @"

[mcp_servers.skill-bridge]
command = "npx"
args = ["--yes", "@aidev3-web/mcp-skill-library"]
"@
  $current = if (Test-Path $codexConfig) { Get-Content $codexConfig -Raw } else { "" }
  if ($current -notmatch "\[mcp_servers\.skill-bridge\]") {
    Add-Content -Path $codexConfig -Value $entry
    Write-Host "Codex found - appended config"
  }
}

Write-Step "Done. Restart any running agent (Claude Code / Desktop / OpenCode / Codex) to pick up the new config."
