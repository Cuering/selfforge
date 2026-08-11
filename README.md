# selfforge

A unified self-evolution engine for [OpenCode](https://opencode.ai). One plugin merges many capabilities into a single store with a single set of tools.

Selfforge learns from your conversations, tracks goals, manages persistent memory, distills and optimizes reusable skills, escalates behavioral rules, repairs its own decisions, and syncs knowledge across agents, machines and teams — all through one plugin and one SQLite database.

## What it merges

| Capability | Origins | Surface |
|---|---|---|
| Conversation monitoring → review | autolearn | event hooks, review subagent |
| Persistent memory + user profile | autolearn | `memory_*`, `user_*` |
| Skill distillation/optimization | autolearn + opencode-self-improving-skills | `skill_*`, `evolution_*` |
| Behavioral rules → AGENTS.md | self-improving-agent | `rule_*` |
| Goal-driven PDCA loop | miles990/self-evolving-agent | `goal_*`, checkpoints CP0–CP6.5 |
| Skill lifecycle curation | autolearn | `curator_*` |
| Skill trial lifecycle + anti-hallucination | MemOS (memos-local-plugin) | `skill_status`, `skill_feedback`, `skill_verify`, `pattern_*` |
| Decision repair (feedback → repairs) | MemOS `core/feedback` + `core/decision-repair` | `repair_*`, `feedback_classify` |
| Work-environment awareness | MemOS workspace fingerprinting | `workspace_*`, scoped recall |
| Cross-agent / platform transfer | own | `transfer_*`, `cli/selfforge.ts`, local JSON-RPC |
| Team shared memory | own (git-backed) | `team_*` |

Everything is stored in a single SQLite database at `~/.evolve/unified.db` (or `$EVOLVE_HOME`).

## Install

One command (downloads + installs):

```bash
curl -sSL https://raw.githubusercontent.com/Cuering/selfforge/main/install-remote.sh | bash
```

Manual (from a local clone):

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

3. Restart opencode. The plugin creates `~/.evolve/unified.db` and `~/.evolve/memory.context.md` on first load.

## Tools

| Group | Tools |
| --- | --- |
| Memory | `memory_add`, `memory_search`, `memory_list`, `memory_strengthen`, `memory_weaken`, `memory_remove`, `memory_status`, `memory_brief`, `memory_candidates`, `memory_confirm`, `memory_reject`, `memory_feedback` |
| Session state | `session_summary`, `session_summaries`, `session_search` |
| Recall eval | `memory_eval` |
| User profile | `user_add`, `user_list`, `user_remove` |
| Skills | `skill_create`, `skill_patch`, `skill_list`, `skill_archive`, `skill_usage`, `skill_status`, `skill_feedback`, `skill_verify` |
| Rules | `rule_observe`, `rule_status`, `rule_escalate` |
| Goals | `goal_start`, `goal_status`, `goal_checkpoint`, `goal_complete`, `goal_stop` |
| Evolution | `evolution_status`, `evolution_propose`, `evolution_apply`, `evolution_reject` |
| Session recall | `session_search` (FTS5 full-text search over all past conversations) || Curator | `curator_run`, `curator_status` |
| Decision repair | `repair_run`, `repair_signal`, `feedback_classify`, `repair_status`, `repair_list`, `repair_accept`, `repair_reject` |
| Pattern candidates | `pattern_status`, `pattern_record`, `pattern_induce`, `pattern_signature` |
| Workspaces | `workspace_status`, `workspace_scan`, `workspace_list` |
| Transfer | `transfer_export`, `transfer_import`, `transfer_preview`, `transfer_status` |
| Team sync | `team_sync`, `team_status`, `team_init`, `team_ping` |

## Architecture

```
~/.evolve/unified.db                single SQLite store
  ├── memories / user_profile       memory + preferences (tiered: hot/warm/cold)
  ├── session_messages + FTS5       full-text index of all conversation history
  ├── skills                        distilled skills (mirrored to ~/.agents/skills/)
  ├── rules                         behavioral rules for AGENTS.md escalation
  ├── goals + checkpoints           PDCA goal tracking
  ├── evolution                     GEPA-style candidates (human-gated apply)
  ├── signals / repairs             decision-repair: step success/failure + repair drafts
  ├── pattern_signatures            zero-LLM recurrence buckets (episode quorum → memory)
  ├── workspaces                    environment fingerprint + ws: scoped memories
  ├── session_summaries             fixed-size compressed session state (distilled, not raw replay)
  ├── recall_evidence               per-word recall feedback (hits/positives/negatives)
  └── config                        node_id + Lamport clock (row-level sync identity)

opencode plugin (selfforge.ts)
  ├── session hooks                 turn counting, buffering, secret redaction, social-closer filter
  ├── tool.execute.after            skill usage tracking + failure/success signals
  └── chat.system.transform         advisory injection (active goals, evolution candidates)
```

Memory tiers and lifecycle: each memory is ranked into hot/warm/cold/evictable by `strength`, and passes through a temporary → active → permanent → archived lifecycle with promotion and demotion. Strength decays exponentially with an adaptive half-life (tuned by access frequency, importance and recency); inactive memories demote a lifecycle level, stale ones are archived, and near-duplicates merge. `memory_search` also injects recent evolution criteria as authoritative behavior guidance for short (≤ 15 char) queries.

## Design principles

- **One engine, one store.** All self-improvement data lives under `~/.evolve/`.
- **Ground Truth hierarchy.** Injected memory is authoritative over assumptions, but never overrides current facts: repo state, build scripts, test results and explicit instructions win, and conflicts surface as stale memories. See [docs/MEMORY_CONTRACT.md](docs/MEMORY_CONTRACT.md).
- **Surgical recall.** `memory_search` returns keyword-scored matches on demand rather than dumping the store.
- **Data ⇒ evolution.** Optimization candidates are only suggested after a skill shows `use ≥ 2 AND fail ≥ 1`.
- **Human-gated.** Skill rewrites and AGENTS.md writes require explicit approval.
- **Declining is valid.** Most sessions produce nothing worth capturing.
- **Hygiene.** Trivial messages are filtered before buffering; memories decay with age and near-duplicates merge.

## Privacy

All data is stored locally under `~/.evolve/`. Nothing leaves your machine. No outbound requests.

## Structure

The plugin is modular so each upgrade touches the smallest possible surface:

- `plugin/selfforge.ts` — thin entry: lifecycle hooks only (event buffering, threshold/idle review, goal/evolution advisories, dispose).
- `plugin/selfforge/lib/` — **engine layer, zero OpenCode dependency**: `db`, `memory`, `skills`, `rules`, `goals`, `evolution`, `review`, `user`, `repair`, `patterns`, `verify`, `workspace`, `transfer`, `sync`, `rpc`, plus `index.ts` as the engine import surface (usable by CLI/RPC/other agents).
- `plugin/selfforge/lib/tools/` — tool registration grouped by domain: `memory.ts`, `user.ts`, `skills.ts`, `rules.ts`, `goals.ts`, `evolution.ts`, `curator.ts`, `repair.ts`, `patterns.ts`, `workspace.ts`, `transfer.ts`, `team.ts`. Add or fix a tool here without touching the entry.
- `cli/selfforge.ts` — standalone CLI (status/export/import/serve/team) powered by the zero-dependency engine.

## Sync-ready rows (Phase 0)

Every data table (`memories`, `skills`, `rules`, `goals`, `checkpoints`, `evolution`, `observations`, `user_profile`, `signals`, `repairs`, `pattern_signatures`) carries row-level identity so replicas can be merged across agents, machines and platforms:

- `uuid` — unique row id (RFC 4122), backfilled on legacy DBs at migration.
- `origin` — the `node_id` that created the row (persisted in `config`).
- `deleted` — tombstone: soft deletes set `deleted = 1` so removals replicate.
- Lamport clock in `config.lamport_clock`, bumped by `db.stamp()` on every write for conflict ordering.

## MemOS-inspired engine (Phase 1)

Four capabilities adapted from MemOS (`memos-local-plugin`), all deterministic and zero-LLM:

- **Skill trial lifecycle:** every skill starts as `candidate` with `eta = (passed+1)/(attempted+2)` (Beta(1,1)). It graduates to `active`/`archived` after a quorum of trials, `skill_feedback` (+/− 0.1) supports rehab/retire, and `evolution_apply` feeds a reward drift (`0.7η + 0.3m`).
- **Decision repair:** step-level success/failure signals (`signals_auto`, default on) feed a burst detector (rolling window, cooldown). A repair burst or a classified user preference (`用X代替Y`/`prefer X over Y`/negations) drafts a deterministic repair with evidence; `repair_accept`/`repair_reject` gate application.
- **Anti-hallucination verification:** `skill_verify` checks a skill draft's tool mentions against real evidence (observed tool calls, code-fence commands) and reports tool-coverage + evidence resonance. Drafts fail fast instead of shipping fabricated tool names.
- **Pattern signature candidate pool:** a recurring sub-problem is fingerprinted as `primaryTag|secondaryTag|tool|errCode`, hashed to a 16-hex bucket. Only buckets with ≥ N distinct episodes (default 2, TTL-pruned) induce a candidate memory — a single flaky episode never mints knowledge.

## Work-environment awareness (Phase 2)

Workspaces are fingerprinted from cheap stack markers (`package.json`, `pyproject.toml`, `go.mod`, `Dockerfile`, …) into a stable `ws:<basename>:<hash>` scope key. Memories can be scoped to that key, and `memoryRecall` applies a `scopeBoost` so the current workspace's lessons rank first — no embeddings needed.

## Cross-agent / platform transfer (Phase 3)

A portable snapshot serializes the whole store (`format: selfforge-snapshot`) with per-row identity. `transfer_export`/`transfer_import` move it between machines/agents/platforms; importing is a per-uuid last-write-wins merge (newer `updated_at` wins, tie-broken by node id, tombstones delete). The zero-dependency engine (`lib/index.ts`) also powers:

- `cli/selfforge.ts` — `status`, `export`, `import` (with `--dry-run`), `serve`, `team` subcommands; runs anywhere with bun, no OpenCode needed.
- local JSON-RPC server (`lib/rpc.ts`) — `ping`, `status`, `memory.list`, `skills.list`, `workspaces.list`, `goals.list`, `snapshot.export`/`snapshot.import` over HTTP.

## Team shared memory (Phase 4)

A git repo holds `snapshot.json` as the shared truth. `team_sync` runs pull → per-uuid LWW merge into the local store → re-export → commit → push, so any number of nodes converge. `team_init` bootstraps a repo (optionally with a remote); tombstones propagate as removals.

## Visual management (Phase 5)

`selfforge serve` (or `bun cli/selfforge.ts serve`) starts a zero-dependency HTTP server:

- `GET /` — single-page dashboard (overview counts, memories, skills, goals, pending repairs, pattern candidates).
- `GET /api/*` — JSON endpoints (`/api/dashboard`, `/api/memories`, `/api/skills`, `/api/goals`, `/api/repairs`, `/api/patterns`, `/api/workspaces`).
- `POST /` — the JSON-RPC surface above.

### Integrated into OpenCode (v1.9)

The plugin auto-starts the dashboard/RPC server in the background on load (`serve(9210)`, port-stepping on conflict), so the browser panel is always reachable. Inside OpenCode:

- Type `/selfforge` — prints a terminal overview (memory/skill/goal/repair/pattern counts), and opens the browser panel on request.
- Tools: `selfforge_status` returns a plain-text overview; `selfforge_dashboard` ensures the server is up and opens the browser; `selfforge_dashboard_stop` shuts it down.
- Singleton serving: `serve()` is idempotent (no duplicate listeners) and `closeServer()` shuts down cleanly on plugin dispose.

## Metis-inspired memory (v1.8)

Five capabilities adapted from the [MemTensor Metis](https://github.com/MemTensor/Metis) memory-foundation-model paper — `native memory state`, `learned utilization`, and `fixed-size session state` — kept deterministic and zero-LLM:

- **Fixed-size session state (`session_summary`):** conversation history is distilled into a bounded digest of user directives/decisions (`session_summaries`), so later queries read a compact state instead of replaying the raw transcript — the plugin builds it automatically after each review.
- **Informative write gate:** a confirmed write must add enough novel tokens over the existing store (`memory_novelty_gate`, default 0.35); redundant rewrites are rejected instead of bloating memory. Candidate writes are exempt.
- **Recall evidence loop (`memory_feedback`):** every recall records per-word hits; explicit useful/not-useful feedback adjusts word-level precision weights that re-rank future recalls — learned utilization without an LLM.
- **Tiered injection fusion:** `composeMemoryContext` fuses memory in priority tiers — current workspace first, then scoped lessons, then general — so the most situational signal is closest to the querying head.
- **Recall eval benchmark (`memory_eval` / `selfforge eval`):** seeds a known fixture set and reports precision@k over a battery of positive and negative queries, keeping recall regressions visible.

## License

MIT

## Version history

### v1.9.0 (2026-08-10) OpenCode UI integration

- **Auto background server:** the plugin starts the dashboard/RPC server on load (`serve(9210)`, port-stepping on conflict), so `selfforge serve`'s panel is always available.
- **`/selfforge` command:** an OpenCode global command prints a terminal overview (`selfforge_status`) and opens the browser panel when wanted (`selfforge_dashboard`); `selfforge_dashboard_stop` stops it.
- **Terminal text overview:** new `dashboardText()` renders counts, recent memories, skills, goals, pending repairs and mature patterns without a network round trip.
- **Singleton serving:** `serve()` is safe to call repeatedly (no duplicate listen); `closeServer()` shuts down on plugin dispose.
- Tests: `tests/rpc.test.ts` adds `dashboardText` + `serve` singleton cases — full suite 101 pass.

### v1.8.0 (2026-08-10) Metis-inspired memory (native state, learned utilization, fixed-size state)

- **Fixed-size session state:** new `session_summaries` table + `lib/summary.ts` distills a session's user directives/decisions into a bounded digest; the plugin builds it after every review and fuses it into the injected context. Tools: `session_summary`, `session_summaries`.
- **Informative write gate:** `memoryAddDedup` now rejects confirmed writes whose token novelty over the existing store falls below `memory_novelty_gate` (default 0.35); candidates are exempt. New `memoryNovelty` / `noveltyGate`.
- **Recall evidence loop:** new `recall_evidence` table records per-word hits on every recall; `memory_feedback` (+/−) adjusts word-level precision weights that re-rank future recalls. `recallFeedback` also strengthens/weakens the underlying memory by id.
- **Tiered injection fusion:** `composeMemoryContext` ranks confirmed memories workspace → scoped → general and can fuse a session-state block.
- **Recall eval:** new `lib/eval.ts` seeds a fixture set and reports precision@k; surfaced as `memory_eval` tool and `selfforge eval` CLI.
- Tests: new `tests/metis.test.ts` (13 cases) — full suite 99 pass.

### v1.7.0 (2026-08-10) MemOS engine + cross-agent + team sync + dashboard (Phases 1–5)

- **Skill trial lifecycle (Phase 1):** skills carry Beta(1,1) `eta`, start as `candidate`, graduate by trial quorum (`skill_candidate_trials`, default 3), reward drift from `evolution_apply`, rehab/retire via `skill_feedback`. Tools: `skill_status`, `skill_feedback`.
- **Decision repair (Phase 1):** step-level success/failure signals (`signals_auto`) feed a burst detector + cooldown; classified user preferences and anti-patterns draft deterministic repairs with evidence. Tools: `repair_run`, `repair_signal`, `feedback_classify`, `repair_status`, `repair_list`, `repair_accept`, `repair_reject`.
- **Anti-hallucination verification (Phase 1):** `skill_verify` scores a skill draft's tool coverage + evidence resonance against real observed tool calls and code-fence commands; `skill_create` reports the advisory.
- **Pattern signature candidates (Phase 1):** recurring sub-problems are fingerprinted as `primaryTag|secondaryTag|tool|errCode`, hashed to 16-hex buckets; only buckets with ≥ N distinct episodes (TTL-pruned) induce candidate memories. Tools: `pattern_status`, `pattern_record`, `pattern_induce`, `pattern_signature`.
- **Workspace awareness (Phase 2):** `workspaces` table + stack-marker fingerprint → `ws:` scope keys; `memoryRecall` applies a `scopeBoost`. Tools: `workspace_status`, `workspace_scan`, `workspace_list`.
- **Cross-agent/platform transfer (Phase 3):** portable snapshot + per-uuid LWW import; CLI `cli/selfforge.ts`; zero-dependency local JSON-RPC. Tools: `transfer_export`, `transfer_import`, `transfer_preview`, `transfer_status`.
- **Team shared memory (Phase 4):** git repo holds `snapshot.json`; `team_sync` = pull → LWW merge → re-export → push. Tools: `team_sync`, `team_status`, `team_init`, `team_ping`.
- **Visual management (Phase 5):** `selfforge serve` serves a single-page dashboard at `GET /` plus JSON endpoints at `/api/*`; JSON-RPC stays under `POST /`.
- Tests: `skill-lifecycle`, `repair`, `verify`, `patterns`, `workspace`, `transfer`, `rpc`, `team`.

### v1.5.0 (2026-08-09) Sync primitives (Phase 0)

- Row-level sync identity on all data tables: `uuid` + `origin` + `deleted` tombstone; legacy DBs backfilled idempotently at migration.
- `node_id` persisted in `config`; Lamport clock (`config.lamport_clock`) bumped on every write — the foundation for cross-agent / cross-platform / team-synced memory.
- Explicit deletions (memory remove/reject, skill archive, profile remove) set the tombstone so they replicate as removals, not leftovers.
- Export surface: `lib/index.ts` re-exports the engine independently of the OpenCode adapter.
- New test suite `tests/sync.test.ts` (node id, clock monotonicity, stamping, tombstones, migration backfill).

### v1.4.0 (2026-08-09) Modularized entry

- Tool registration moved out of the entry file into `lib/tools/*` grouped by domain (memory/user/skills/rules/goals/evolution/curator). The entry now holds lifecycle hooks only.
- `install.sh` copies the new `lib/tools/` directory; no `opencode.json` changes required.

### v1.3.0 (2026-08-09) Memory contract & contamination defense

- **Candidate zone:** auto-inferred memories land as `candidate`; they are never recalled or injected until a human confirms them (`memory_candidates`, `memory_confirm`, `memory_reject`). Explicit user statements write directly as confirmed.
- **Scope:** memories carry an optional path-glob `scope` so a lesson in one module never leaks into another module's recall.
- **Confidence & TTL:** `confidence` 1–10 plus `expires_at` for temporary facts — expired memories are excluded from recall and archived by decay.
- **Store-level write guard:** credentials, tokens and code/file snapshots are rejected at write time.
- **Priority clarified:** injected memory is authoritative over assumptions but never overrides current repo/CI/test facts; conflicts surface as stale memories.
- **Memory contract:** documented operating rules in `docs/MEMORY_CONTRACT.md`.
- **Memory trace:** every recall records query/scope/recalled ids/injected criteria in `observations` for reconstructable debugging.
- **Contamination regression suite:** `tests/memory-fixtures.test.ts` (7 high-risk fixtures: secrets, candidates, expiry, scope leakage, injection purity, dedup promotion).

### v1.2.0 (2026-08-09) Memory lifecycle management

- **Schema migration:** `memories` gains `last_accessed_at`, `access_count`, `importance`, `lifecycle`, `type`; legacy DBs are upgraded idempotently via `PRAGMA table_info` probing.
- **Adaptive exponential decay:** strength decays by a half-life formula; the half-life adapts to access frequency, importance and recency. Stale memories demote a lifecycle level; long-inactive ones are archived.
- **Lifecycle promotion/demotion:** temporary → active → permanent by access count (15/30); manual weakening or inactivity demotes.
- **Memory classification:** `memory_add` accepts `type` (preference/insight/instruction/fact/decision/episodic) and `importance` (1–10).
- **Daily brief:** new `memory_brief` tool reporting active/archived counts, today's additions, type & lifecycle distribution and health suggestions.
- **Short-query injection:** `memory_search` auto-injects recently applied evolution criteria as authoritative behavior guidance for queries ≤ 15 chars.
- **VACUUM maintenance:** low-frequency DB compaction folded into the idle maintenance loop (default daily, configurable).

### v1.1.0 (2026-08-09) Recall & session search

- Ground Truth hierarchy: injected memory is authoritative, so the agent uses it instead of re-running discovery.
- Surgical recall: `memory_search` returns keyword-scored matches on demand.
- FTS5 session full-text search: new `session_search` across all past conversations.
- Decay & dedup: memories age-decay; near-duplicates (sim ≥ 0.7) auto-merge and strengthen.
- New smoke test suite.

### v1.0.0 (2026-08-07) Initial release

- Unified self-evolution engine: conversation review, persistent memory, skill distillation/optimization, behavioral rule escalation, PDCA goal tracking, skill lifecycle curation.
- Single SQLite store `~/.evolve/unified.db` plus injected context file `~/.evolve/memory.context.md`.
- One-command install scripts `install.sh` and `install-remote.sh`.