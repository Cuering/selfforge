# selfforge all-in-one installer for Windows PowerShell 5.1+
# Run: powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = "Continue"
$REPO = Split-Path -Parent $MyInvocation.MyCommand.Path
$CONFIG_DIR = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".config\opencode" }
$AGENT_SKILLS = Join-Path $env:USERPROFILE ".agents\skills"
$EVOLVE_HOME = Join-Path $env:USERPROFILE ".evolve"

Write-Output ""
Write-Output "selfforge installer (Windows)"
Write-Output "============================="
Write-Output ""

# 1. Copy plugin source
Write-Output "[1/5] Copying plugin files..."
New-Item -ItemType Directory -Force -Path "$CONFIG_DIR\plugins\selfforge\lib\tools" | Out-Null
Copy-Item "$REPO\plugin\selfforge.ts" "$CONFIG_DIR\plugins\" -Force
Get-ChildItem "$REPO\plugin\selfforge\lib\*.ts" | Copy-Item -Destination "$CONFIG_DIR\plugins\selfforge\lib\" -Force
Get-ChildItem "$REPO\plugin\selfforge\lib\tools\*.ts" | Copy-Item -Destination "$CONFIG_DIR\plugins\selfforge\lib\tools\" -Force
Copy-Item "$REPO\plugin\selfforge\serve-daemon.ts" "$CONFIG_DIR\plugins\selfforge\" -Force
if (Test-Path "$REPO\plugin\selfforge\build.mjs") { Copy-Item "$REPO\plugin\selfforge\build.mjs" "$CONFIG_DIR\plugins\build.mjs" -Force }
if (Test-Path "$REPO\plugin\selfforge\package.json") { Copy-Item "$REPO\plugin\selfforge\package.json" "$CONFIG_DIR\plugins\package.json" -Force }
Write-Output "  done"

# 2. Copy skills
Write-Output "[2/5] Copying skills..."
New-Item -ItemType Directory -Force -Path "$AGENT_SKILLS\selfforge" | Out-Null
New-Item -ItemType Directory -Force -Path "$AGENT_SKILLS\evolve-reviewer" | Out-Null
Copy-Item "$REPO\skills\selfforge\SKILL.md" "$AGENT_SKILLS\selfforge\SKILL.md" -Force
Copy-Item "$REPO\skills\evolve-reviewer\SKILL.md" "$AGENT_SKILLS\evolve-reviewer\SKILL.md" -Force
Write-Output "  done"

# 3. Build compiled .js
Write-Output "[3/5] Building compiled bundle..."
New-Item -ItemType Directory -Force -Path "$CONFIG_DIR\plugins\compiled" | Out-Null
$bun = Get-Command "bun.cmd" -ErrorAction SilentlyContinue
if (-not $bun) { $bun = Get-Command "bun" -ErrorAction SilentlyContinue }
if ($bun) {
  Push-Location "$CONFIG_DIR\plugins"
  & $bun.Source build.mjs
  Pop-Location
  Write-Output "  build OK"
} else {
  Write-Output "  bun not found. Install bun first: https://bun.sh"
  Write-Output "  CLI (Bun) users can load .ts directly; Desktop (Node) needs compiled .js."
}

# 4. Configure opencode.json
Write-Output "[4/5] Configuring opencode.json..."
$cfgPath = "$CONFIG_DIR\opencode.jsonc"
if (-not (Test-Path $cfgPath)) { $cfgPath = "$CONFIG_DIR\opencode.json" }
$pluginEntry = if (Test-Path "$CONFIG_DIR\plugins\compiled\selfforge.js") { "./plugins/compiled/selfforge.js" } else { "./plugins/selfforge.ts" }

$data = @{}
if (Test-Path $cfgPath) {
  $raw = Get-Content $cfgPath -Raw -Encoding UTF8
  try { $data = $raw | ConvertFrom-Json -AsHashtable } catch {}
}
$changed = $false

if (-not $data.plugin) { $data.plugin = @() }
if ($data.plugin -is [string]) { $data.plugin = @($data.plugin) }
if ($data.plugin -notcontains $pluginEntry) { $data.plugin += $pluginEntry; $changed = $true }

if (-not $data.instructions) { $data.instructions = @() }
if ($data.instructions -is [string]) { $data.instructions = @($data.instructions) }
if ($data.instructions -notcontains "~/.evolve/memory.context.md") { $data.instructions += "~/.evolve/memory.context.md"; $changed = $true }

if (-not $data.skills) { $data.skills = @{} }
if (-not $data.skills.paths -or $data.skills.paths -notcontains "~/.evolve/skills") { $data.skills.paths = @("~/.evolve/skills"); $changed = $true }

if (-not $data.agent) { $data.agent = @{} }
if (-not $data.agent["evolve-reviewer"]) {
  $data.agent["evolve-reviewer"] = @{
    description = "Reviews past conversations for self-improvement opportunities"
    hidden = $true
    steps = 20
    prompt = "Load the selfforge skill and follow its review workflow to review the attached conversation for learning opportunities. Take immediate action: SKILL_DISTILL FIRST - if the session demonstrates a repeatable technique/workflow/fix, call skill_create with a concrete body; then update memory, track goals."
    permission = @{
      bash = "allow"; read = "allow"; glob = "allow"; grep = "allow"
      write = "allow"; edit = "deny"; webfetch = "deny"; task = "deny"
      skill = "allow"; external_directory = "allow"
    }
  }
  $changed = $true
}
if ($changed) {
  $json = $data | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($cfgPath, $json + "`n", [Text.UTF8Encoding]::new($false))
  Write-Output "  Updated $cfgPath"
} else {
  Write-Output "  Already configured ($cfgPath)"
}

# 5. Verify
Write-Output "[5/5] Verifying..."
$ok = $true
if (-not (Test-Path "$CONFIG_DIR\plugins\selfforge.ts")) { Write-Output "  MISSING: plugin/selfforge.ts"; $ok = $false }
if (-not (Test-Path "$AGENT_SKILLS\selfforge\SKILL.md")) { Write-Output "  MISSING: selfforge skill"; $ok = $false }
if (-not (Test-Path "$AGENT_SKILLS\evolve-reviewer\SKILL.md")) { Write-Output "  MISSING: evolve-reviewer skill"; $ok = $false }
if ($ok) {
  Write-Output "  All files present."
  Write-Output ""
  Write-Output "================================"
  Write-Output "  Done! Restart opencode to activate."
  Write-Output ""
  Write-Output "  After restart:"
  Write-Output "    - Dashboard: http://127.0.0.1:9210/"
  Write-Output "    - CLI:        bun cli/selfforge.ts status"
  Write-Output "  Skills will auto-sync from ~/.evolve/skills via skills.paths."
  Write-Output "================================"
  exit 0
} else {
  Write-Output "  Some files missing — check errors above."
  exit 1
}