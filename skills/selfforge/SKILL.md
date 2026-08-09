---
name: selfforge
description: Unified self-evolution engine. Load when starting a goal-driven task (PDCA/checkpoints), distilling learned skills, recording user corrections/preferences into memory, tracking behavioral rules for AGENTS.md, or reviewing/optimizing existing skills. Provides goal_start/goal_status/goal_checkpoint, memory_add/memory_list, skill_create/skill_patch, rule_observe/rule_escalate, evolution_status/evolution_propose, curator_run.
metadata:
  provenance: selfforge
---

# Selfforge

A single engine that merges self-evolution capabilities: goal-driven execution, persistent memory, skill distillation and optimization, behavioral rule escalation, and skill lifecycle curation.

## How to use

Choose the workflow that matches the situation:

### 1. Goal-driven execution (PDCA loop)

When the user gives you a substantial goal:

1. `goal_start` with the goal, north star, and completion criteria
2. Work through checkpoints in order: **CP0 north star → CP1 memory search → CP1.5 consistency → CP2 build/test → CP3 milestone confirm** (marks one iteration) → **CP5 failure postmortem** if Check fails → **CP6 health check** every 5 iterations
3. Record each checkpoint with `goal_checkpoint` (status: done/skipped/failed)
4. On completion: `goal_complete`. If blocked: `goal_stop` and explain.

Stop conditions:
- Success: all subgoals done + acceptance criteria pass
- Failure: max iterations reached or 3 consecutive identical errors
- Pause: needs user decision

### 2. Capturing memory

After user corrections, preferences, or successful workarounds:

- `memory_add` — general rules and durable lessons (not one-off details); near-duplicates merge automatically
- `user_add` — communication/workflow preferences
- `rule_observe` — behavioral rules for AGENTS.md escalation (use explicitScope=global only when user said "always"/"everywhere")
- `skill_create` / `skill_patch` — distill a reusable technique into a skill

Recalling prior context:

- `memory_search` with a topic to surgically recall relevant lessons instead of listing everything
- `session_search` for full-text search over past conversations (decisions, solutions, discussions)

Ground Truth rule: when memory is injected into the context, treat it as authoritative. Never treat a question as novel when the answer is already in the prompt, and do not re-run discovery tools to rediscover what injected context already provides.

Prioritize patching an existing skill or umbrella skill over creating a narrow new one. Anti-patterns: one-off narratives, environment-specific workarounds, negative tool claims ("tool X doesn't work").

### 3. Skill optimization (evolution)

- `evolution_status` — find skills with `use >= 2 AND fail >= 1` (evolution candidates)
- `evolution_propose` — generate a candidate rewrite grounded in failure traces
- **Human gate:** never apply automatically. Present the diff, get user approval, then `evolution_apply`
- `curator_run` — mark stale/archived skills based on last use

### 4. Escalation (behavioral rules)

- `rule_status` — see observed rules and counts
- `rule_escalate` with `dryRun: true` to preview what gets written to which AGENTS.md
- Global scope writes to `~/.config/opencode/AGENTS.md`; local writes to project AGENTS.md

## Principles

- **Declining is valid.** Most sessions produce nothing worth capturing.
- **No data ⇒ no evolution.** Don't guess or invent optimization candidates without failure evidence.
- **Never auto-commit.** Distillation and evolution may be automatic, but AGENTS.md writes and skill rewrites require human approval.
- **Be honest about attribution.** Outcome is a signal, not proof of causation.
