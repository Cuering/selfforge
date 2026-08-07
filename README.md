# selfforge

A unified self-evolution engine for [OpenCode](https://opencode.ai). One plugin merges four capabilities into a single store with a single set of tools.

Selfforge learns from your conversations, tracks goals, manages persistent memory, distills and optimizes reusable skills, and escalates behavioral rules — all through one plugin and one SQLite database.

## What it merges

| Capability | Origins | Surface |
|---|---|---|
| Conversation monitoring → review | autolearn | event hooks, review subagent |
| Persistent memory + user profile | autolearn | `memory_*`, `user_*` |
| Skill distillation/optimization | autolearn + opencode-self-improving-skills | `skill_*`, `evolution_*` |
| Behavioral rules → AGENTS.md | self-improving-agent | `rule_*` |
| Goal-driven PDCA loop | miles990/self-evolving-agent | `goal_*`, checkpoints CP0–CP6.5 |
| Skill lifecycle curation | autolearn | `curator_*` |

Everything is stored in a single SQLite database at `~/.evolve/unified.db` (or `$EVOLVE_HOME`).

## Install

```bash
git clone https://github.com/Cuering/selfforge.git
bash selfforge/install.sh
# restart opencode
```

Manual install:

1. Copy the plugin and skill:
   - `plugin/selfforge.ts` + `plugin/lib/**` → `~/.config/opencode/plugins/`
   - `skills/selfforge/` → `~/.agents/skills/selfforge/`
   - `skills/evolve-reviewer/` → `~/.agents/skills/evolve-reviewer/`
2. Register in `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["./plugins/selfforge.ts"],
  "instructions": ["~/.evolve/memory.context.md"],
  "agent": {
    "evolve-reviewer": {
      "description": "Reviews past conversations for self-improvement opportunities",
      "hidden": true,
      "steps": 20,
      "prompt": "Load the selfforge skill and follow its review workflow to review the attached conversation for learning opportunities. Take immediate action: record observations, update memory, create or patch skills, track goals.",
      "permission": {
        "bash": "allow", "read": "allow", "glob": "allow", "grep": "allow",
        "write": "allow", "edit": "deny", "webfetch": "deny", "task": "deny",
        "skill": "allow", "external_directory": "allow"
      }
    }
  }
}
```

3. Restart opencode. The plugin creates `~/.evolve/unlearn.db` and `~/.evolve/memory.context.md` on first load.

## Tools

| Group | Tools |
| --- | --- |
| Memory | `memory_add`, `memory_list`, `memory_strengthen`, `memory_weaken`, `memory_remove`, `memory_status` |
| User profile | `user_add`, `user_list`, `user_remove` |
| Skills | `skill_create`, `skill_patch`, `skill_list`, `skill_archive`, `skill_usage` |
| Rules | `rule_observe`, `rule_status`, `rule_escalate` |
| Goals | `goal_start`, `goal_status`, `goal_checkpoint`, `goal_complete`, `goal_stop` |
| Evolution | `evolution_status`, `evolution_propose`, `evolution_apply`, `evolution_reject` |
| Curator | `curator_run`, `curator_status` |

## Architecture

```
~/.evolve/unlearn.db                single SQLite store
  ├── memories / user_profile       memory + preferences
  ├── skills                        distilled skills (mirrored to ~/.agents/skills/)
  ├── rules                         behavioral rules for AGENTS.md escalation
  ├── goals + checkpoints           PDCA goal tracking
  └── evolution                     GEPA-style candidates (human-gated apply)

opencode plugin (selfforge.ts)
  ├── session hooks                 turn counting, buffering, secret redaction
  ├── tool.execute.after            skill usage tracking
  └── chat.system.transform         advisory injection (active goals, evolution candidates)
```

## Design principles

- **One engine, one store.** All self-improvement data lives under `~/.evolve/`.
- **Data ⇒ evolution.** Optimization candidates are only suggested after a skill shows `use ≥ 2 AND fail ≥ 1`.
- **Human-gated.** Skill rewrites and AGENTS.md writes require explicit approval.
- **Declining is valid.** Most sessions produce nothing worth capturing.

## Privacy

All data is stored locally under `~/.evolve/`. Nothing leaves your machine. No outbound requests.

## License

MIT