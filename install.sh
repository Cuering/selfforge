#!/usr/bin/env bash
# selfforge all-in-one installer (Linux / macOS / WSL).
# Windows: use `git bash` or WSL, or follow the manual steps in README.zh-CN.md.
set -euo pipefail

REPO="${1:-$(cd "$(dirname "$0")" && pwd)}"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
AGENT_SKILLS="$HOME/.agents/skills"
EVOLVE_HOME="$HOME/.evolve"

echo ""
echo "selfforge installer"
echo "==================="
echo ""

# ----- 1. Copy plugin source -----
echo "[1/5] Copying plugin files..."
mkdir -p "$CONFIG_DIR/plugins/selfforge/lib/tools"
cp "$REPO/plugin/selfforge.ts" "$CONFIG_DIR/plugins/"
cp "$REPO"/plugin/selfforge/lib/*.ts "$CONFIG_DIR/plugins/selfforge/lib/"
cp "$REPO"/plugin/selfforge/lib/tools/*.ts "$CONFIG_DIR/plugins/selfforge/lib/tools/"
cp "$REPO"/plugin/selfforge/serve-daemon.ts "$CONFIG_DIR/plugins/selfforge/"
cp "$REPO"/plugin/selfforge/build.mjs "$CONFIG_DIR/plugins/" 2>/dev/null || true
cp "$REPO"/plugin/selfforge/package.json "$CONFIG_DIR/plugins/" 2>/dev/null || true
echo "  done"

# ----- 2. Copy skills -----
echo "[2/5] Copying skills..."
mkdir -p "$AGENT_SKILLS/selfforge"
mkdir -p "$AGENT_SKILLS/evolve-reviewer"
cp "$REPO/skills/selfforge/SKILL.md" "$AGENT_SKILLS/selfforge/SKILL.md"
cp "$REPO/skills/evolve-reviewer/SKILL.md" "$AGENT_SKILLS/evolve-reviewer/SKILL.md"
echo "  done"

# ----- 3. Build compiled .js (for desktop / Node users) -----
echo "[3/5] Building compiled bundle..."
mkdir -p "$CONFIG_DIR/plugins/compiled"
if command -v bun &>/dev/null; then
  (cd "$CONFIG_DIR/plugins" && bun build.mjs) && echo "  build OK" || echo "  build skipped (bun failed)"
elif command -v node &>/dev/null; then
  echo "  bun not found — compiled .js not built. Desktop users must install bun first."
  echo "  CLI (Bun) users can load .ts directly."
else
  echo "  neither bun nor node found — install bun or node first."
fi

# ----- 4. JSON config (use Node.js to avoid python3 dependency) -----
echo "[4/5] Configuring opencode.json/jsonc..."
DETECT="$CONFIG_DIR/opencode.jsonc"
if [ ! -f "$DETECT" ]; then DETECT="$CONFIG_DIR/opencode.json"; fi

# Auto-detect: if compiled/selfforge.js exists, prefer .js entry
if [ -f "$CONFIG_DIR/plugins/compiled/selfforge.js" ]; then
  PLUGIN_ENTRY="./plugins/compiled/selfforge.js"
else
  PLUGIN_ENTRY="./plugins/selfforge.ts"
fi

# Use Node.js to edit the JSON (no python3 needed)
node -e "
const fs = require('fs');
const path = require('path');
const cfgPath = '$DETECT';
let data = {};
try {
  const raw = fs.readFileSync(cfgPath, 'utf8');
  // Strip // comments if present (jsonc)
  data = JSON.parse(raw.replace(/\/\/.*$/gm, ''));
} catch (e) {
  console.log('  Creating new config at ' + cfgPath);
}

let changed = false;

// Plugin entry
if (!data.plugin) data.plugin = [];
if (!Array.isArray(data.plugin)) data.plugin = [data.plugin];
if (!data.plugin.includes('$PLUGIN_ENTRY')) {
  data.plugin.push('$PLUGIN_ENTRY');
  changed = true;
}

// Instructions
if (!data.instructions) data.instructions = [];
if (!Array.isArray(data.instructions)) data.instructions = [data.instructions];
if (!data.instructions.includes('~/.evolve/memory.context.md')) {
  data.instructions.push('~/.evolve/memory.context.md');
  changed = true;
}

// Skills paths
if (!data.skills) data.skills = {};
if (!data.skills.paths || !data.skills.paths.includes('~/.evolve/skills')) {
  data.skills.paths = ['~/.evolve/skills'];
  changed = true;
}

// evolve-reviewer agent
if (!data.agent) data.agent = {};
if (!data.agent['evolve-reviewer']) {
  data.agent['evolve-reviewer'] = {
    description: 'Reviews past conversations for self-improvement opportunities',
    hidden: true,
    steps: 20,
    prompt: 'Load the selfforge skill and follow its review workflow to review the attached conversation for learning opportunities. Take immediate action: SKILL_DISTILL FIRST - if the session demonstrates a repeatable technique/workflow/fix, call skill_create with a concrete body; then update memory, track goals.',
    permission: {
      bash: 'allow', read: 'allow', glob: 'allow', grep: 'allow',
      write: 'allow', edit: 'deny', webfetch: 'deny', task: 'deny',
      skill: 'allow', external_directory: 'allow'
    }
  };
  changed = true;
}

if (changed) {
  fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2) + '\n');
  console.log('  Updated ' + cfgPath);
} else {
  console.log('  Already configured (' + cfgPath + ')');
}
"

# ----- 5. Verify -----
echo "[5/5] Verifying..."
OK=true
[[ -f "$CONFIG_DIR/plugins/selfforge.ts" ]] || { echo "  MISSING: plugin/selfforge.ts"; OK=false; }
[[ -f "$AGENT_SKILLS/selfforge/SKILL.md" ]] || { echo "  MISSING: selfforge skill"; OK=false; }
[[ -f "$AGENT_SKILLS/evolve-reviewer/SKILL.md" ]] || { echo "  MISSING: evolve-reviewer skill"; OK=false; }
if $OK; then
  echo "  All files present."
  echo ""
  echo "================================"
  echo "  Done! Restart opencode to activate."
  echo ""
  echo "  After restart:"
  echo "    - Dashboard: http://127.0.0.1:9210/"
  echo "    - CLI:        bun cli/selfforge.ts status"
  echo "  Skills will auto-sync from ~/.evolve/skills via skills.paths."
  echo "================================"
  exit 0
else
  echo "  Some files missing — check errors above."
  exit 1
fi