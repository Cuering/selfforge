#!/usr/bin/env bash
# selfforge installer for OpenCode
set -euo pipefail

REPO_DIR="${1:-$(cd "$(dirname "$0")" && pwd)}"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
SKILLS_DIR="$HOME/.agents/skills"

echo "selfforge installer"
echo "==================="

# 1. Copy plugin
echo "[1/4] Installing plugin..."
mkdir -p "$CONFIG_DIR/plugins"
cp "$REPO_DIR/plugin/selfforge.ts" "$CONFIG_DIR/plugins/"
mkdir -p "$CONFIG_DIR/plugins/selfforge/lib"
cp "$REPO_DIR"/plugin/lib/*.ts "$CONFIG_DIR/plugins/selfforge/lib/"

# 2. Copy skills
echo "[2/4] Installing skills..."
mkdir -p "$SKILLS_DIR/selfforge"
cp "$REPO_DIR/skills/selfforge/SKILL.md" "$SKILLS_DIR/selfforge/SKILL.md"
mkdir -p "$SKILLS_DIR/evolve-reviewer"
cp "$REPO_DIR/skills/evolve-reviewer/SKILL.md" "$SKILLS_DIR/evolve-reviewer/SKILL.md"

# 3. Register opencode.json / .jsonc
echo "[3/4] Configuring opencode..."
if [ -f "$CONFIG_DIR/opencode.jsonc" ]; then CFG="$CONFIG_DIR/opencode.jsonc"; else CFG="$CONFIG_DIR/opencode.json"; fi

python3 - "$CFG" <<'PY'
import json, sys, os
path = sys.argv[1]
data = {}
if os.path.exists(path):
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    try:
        data = json.loads(raw)
    except Exception:
        print("  Warning: could not parse existing config as JSON; leaving unchanged.")
        sys.exit(0)

changed = False
data.setdefault("plugin", [])
if isinstance(data["plugin"], str):
    data["plugin"] = [data["plugin"]]
entry = "./plugins/selfforge.ts"
if entry not in data["plugin"]:
    data["plugin"].append(entry)
    changed = True

data.setdefault("instructions", [])
if isinstance(data["instructions"], str):
    data["instructions"] = [data["instructions"]]
ctx = "~/.evolve/memory.context.md"
if ctx not in data["instructions"]:
    data["instructions"].append(ctx)
    changed = True

data.setdefault("agent", {})
data["agent"].setdefault("evolve-reviewer", {
    "description": "Reviews past conversations for self-improvement opportunities",
    "hidden": True,
    "steps": 20,
    "prompt": "Load the selfforge skill and follow its review instruction to review the attached conversation for learning opportunities. Take immediate action: record observations, update memory, create or patch skills, track goals.",
    "permission": {
        "bash": "allow", "read": "allow", "glob": "allow", "grep": "allow",
        "write": "allow", "edit": "deny", "webfetch": "deny", "task": "deny",
        "skill": "allow", "external_directory": "allow"
    }
})
changed = True

if changed:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print("  Updated " + path)
else:
    print("  Already configured (" + path + ")")
PY

# 4. Verify
echo "[4/4] Verifying..."
OK=true
[[ -f "$CONFIG_DIR/plugins/selfforge.ts" ]] || { echo "MISSING plugin/selfforge.ts"; OK=false; }
[[ -f "$SKILLS_DIR/selfforge/SKILL.md" ]] || { echo "MISSING skill"; OK=false; }
[[ -f "$SKILLS_DIR/evolve-reviewer/SKILL.md" ]] || { echo "MISSING reviewer skill"; OK=false; }
if $OK; then
    echo "Done! Restart OpenCode to activate selfforge."
else
    echo "Some files are missing — check errors above."
    exit 1
fi