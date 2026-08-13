# selfforge

A self-evolving agent memory engine. It learns from your conversations, tracks goals, manages persistent memory, distills reusable skills, escalates behavioral rules, and syncs knowledge across agents, machines and teams — all through one plugin and one SQLite database.

`selfforge` runs as an [OpenCode](https://opencode.ai) plugin, but its core engine is dependency-free and can run standalone (`cli/selfforge.ts`, HTTP daemon, Docker).

Everything is stored in a single SQLite database at `~/.evolve/unified.db` (or `$EVOLVE_HOME`).

## Features

- **Conversation monitoring & review** — turns each session's messages into review artifacts: memory, skills, rules, goals.
- **Persistent memory + user profile** — tiered by strength (`hot/warm/cold/evictable`), with decay, dedup, scope isolation and TTL.
- **Skill distillation & lifecycle** — distill reusable techniques into skills; each skill starts as `candidate` and graduates via trials/eta; unused skills are auto-archived.
- **Behavioral rules → AGENTS.md** — rules are auto-scored (base 3, −1 per 60 days); high-score rules escalate into `AGENTS.md` automatically.
- **Goal-driven PDCA loop** — active goals with checkpoints (CP0–CP6.5), progress advisory injected into the chat system prompt.
- **Decision repair** — step-level success/failure signals draft deterministic repairs with evidence.
- **Daily summary** — each session's final assistant conclusion, appended incrementally and quality-gated.
- **Work-environment awareness** — workspaces are fingerprinted into stable `ws:` scope keys; scoped memories rank first.
- **Cross-agent / platform transfer** — portable snapshot (`format: selfforge-snapshot`) with per-row sync identity.
- **Team shared memory** — a git repo holds `snapshot.json`; `team_sync` pulls, merges (per-uuid LWW), re-exports and pushes.
- **Web dashboard** — bilingual (中文/English) single-page panel: overview counts, memories, skills, rules, goals, checkpoints, daily summary, logs.

## Memory model

```
~/.evolve/unified.db                single SQLite store
  ├── memories / user_profile       memory + preferences (hot/warm/cold)
  ├── session_messages + FTS5       full-text index of all conversation history
  ├── skills                        distilled skills (mirrored to ~/.evolve/skills)
  ├── rules                         behavioral rules (scored, escalate to AGENTS.md)
  ├── goals + checkpoints           PDCA goal tracking
  ├── repairs / signals             decision-repair: step success/failure + repair drafts
  ├── pattern_signatures            recurring failure buckets (episode quorum → memory)
  ├── workspaces                    environment fingerprint + ws: scoped memories
  ├── session_summaries             fixed-size compressed session state
  └── config                        node_id + Lamport clock (row-level sync identity)
```

Memories are ranked into `hot/warm/cold/evictable` by `strength`; strength decays with an adaptive half-life (tuned by access frequency, importance and recency), near-duplicates merge, stale memories get archived.

**Ground truth hierarchy** — injected memory is authoritative over assumptions, but never overrides current facts: repo state, build scripts, test results and explicit instructions win; conflicts surface as stale memories.

## Install

### One-command (recommended, no manual config needed)

Linux / macOS / WSL (bash):

```bash
curl -sSL https://raw.githubusercontent.com/Cuering/selfforge/main/install-remote.sh | bash
# or from a local clone:
bash install.sh
# restart opencode
```

Windows (PowerShell):

```powershell
git clone https://github.com/Cuering/selfforge.git
cd selfforge
powershell -ExecutionPolicy Bypass -File install.ps1
# restart opencode
```

The install script auto-detects the environment:

- Copies plugin source → `~/.config/opencode/plugins/`
- Copies `selfforge` + `evolve-reviewer` skills → `~/.agents/skills/`
- If Bun is available, runs `bun build.mjs` to produce `compiled/selfforge.js` (required for desktop Node; config points at `.js` if built, `.ts` if not)
- Writes `opencode.json`/`jsonc`: `plugin`, `instructions` (`~/.evolve/memory.context.md`), `skills.paths` (`~/.evolve/skills`), `evolve-reviewer` agent
- Verifies file completeness

### Dependencies

| Dependency | Purpose | If missing |
|------------|---------|------------|
| opencode | Runtime | Plugin won't load |
| Bun (optional) | Build `.js` / CLI | CLI works with `.ts`; desktop needs Bun first |
| Node / git / bash or PowerShell | Install script & CLI | Can't install |

> Everything else is self-contained: SQLite is built-in, no external services. First load creates `~/.evolve/unified.db` and `~/.evolve/memory.context.md` automatically.

## Usage

### Inside OpenCode

- Type `/selfforge` — prints a terminal overview (memory/skill/goal/repair counts) and opens the browser panel on request.
- Tools: `selfforge_status` (plain-text overview), `selfforge_dashboard` (ensure the daemon is up and open the browser), `selfforge_dashboard_stop`.
- Memory/search/rule/goal tools: `memory_add`, `memory_search`, `memory_candidates`, `skill_create`, `skill_patch`, `rule_observe`, `rule_escalate`, `goal_start`, `goal_checkpoint`, `evolution_propose`, `curator_run`, and more.

### Web dashboard

`selfforge serve` (or the plugin's auto-started daemon) prefers http://127.0.0.1:9210/. If the preferred port is taken by another process, `serve()` auto-migrates up to +64 ports via `tryListen`, so the daemon stays reachable even when e.g. Tencent QQ squats 9210. The plugin's `/selfforge`, `selfforge_dashboard`, and the browser popup all follow the actual port.

- `GET /` — single-page bilingual dashboard
- `GET /api/*` — JSON endpoints (`/api/dashboard`, `/api/memories`, `/api/skills`, `/api/goals`, `/api/rules`, `/api/checkpoints`, `/api/workspaces`, `/api/errors`, `/api/stats`)
- `GET /api/ping` — liveness probe returning `{pong, pid, port}`; this is the reliable way to detect a real selfforge daemon (a foreign service answering 200 on 9210 does **not** match)
- `POST /` — the JSON-RPC surface
- Header buttons: language toggle (EN/中文), theme, refresh, hot-restart daemon

### Port stability & Windows watchdog

On Windows the dashboard port can be stolen by unrelated apps (e.g. Tencent QQ takes `127.0.0.1:9210`). When that happens the daemon drifts to a higher port and the in-page Restart button becomes unreachable. For a stable, self-healing setup independent of the desktop app / plugin / browser:

- Ship the watchdog scripts from `scripts/watchdog/` (install to the Windows Startup folder or a scheduled task):
  - `selfforge-watchdog.cmd` — loop launcher (every 30s, mutex-guarded)
  - `selfforge-watchdog-once.ps1` — single check: probes `/api/ping` on 9220..9230 (preferred, QQ-free) then 9211..9215; spawns the daemon with `SELFFORGE_PORT=9220` when nothing answers; keeps only the lowest-port survivor and kills duplicate daemons; writes the live port to `~/.evolve/watchdog-port.txt` and opens the browser when the port first changes
- Use a fixed non-conflicting preferred port (e.g. 9220 via `SELFFORGE_PORT`) so the address does not drift on every boot.
- Never stop unrelated services (QQ) to free the port — selfforge migrates around them.

### Standalone CLI (no OpenCode needed)

```bash
bun cli/selfforge.ts status                # node id, clock, DB path
bun cli/selfforge.ts export <file.json>    # portable snapshot
bun cli/selfforge.ts import <file.json>    # per-uuid LWW merge (--dry-run to preview)
bun cli/selfforge.ts serve --port 9210     # dashboard + JSON-RPC
bun cli/selfforge.ts team init <dir>       # team repo (optionally --remote)
bun cli/selfforge.ts team sync [<dir>]     # pull, merge, re-export, push
bun cli/selfforge.ts eval [--k <n>]        # recall precision benchmark
```

## Agent Memory Leaderboard

selfforge participates in the [Agent Memory](https://agentmemories.ai) benchmark (textual track) via the **academic × code** route: the platform builds and evaluates the submitted repository — no always-on host required.

The bench endpoint implements the synchronous Add/Search contract:

| Endpoint | Method | Behavior |
|----------|--------|----------|
| `/health` | GET | unauthenticated liveness (200) |
| `/add` | POST | synchronously persists messages, returns `success:true` + echoed ids |
| `/search` | POST | user-scoped, relevance-ordered `{data:[{id,content,score}]}`; never leak another user's memory |

Running the bench service locally:

```bash
bun cli/selfforge.ts serve --port 9210
# or with Docker (evaluation image, only /add /search /health)
docker build -t selfforge-bench .
docker run -p 9210:9210 -e SELFFORGE_PORT=9210 -e EVOLVE_HOME=/data selfforge-bench
```

Smoke test:

```bash
curl -s localhost:9210/health
curl -s -X POST localhost:9210/add -H 'content-type: application/json' \
  -d '{"request_id":"r1","messages":[{"role":"user","content":"prefer Node"}],"user_id":"u1","session_id":"s1"}'
curl -s -X POST localhost:9210/search -H 'content-type: application/json' \
  -d '{"query":"runtime","user_id":"u1","top_k":10}'
```

## Version history

### v1.9.4 (2026-08-13) Port stability watchdog

- **Watchdog scripts** (`scripts/watchdog/`) — 30s loop that probes `/api/ping`, respawns a dead daemon with `SELFFORGE_PORT=9220` (migrates past port squatters like Tencent QQ), dedupes multiple daemons, records the live port, and opens the browser on first port change.
- **`/api/ping`** documented as the authoritative liveness probe (`{pong, pid, port}`) — HTTP 200 from a foreign service is not selfforge.

### v1.9.3 (2026-08-13) Agent Memory benchmark + rule scoring + i18n

- **Add/Search contract endpoints** for the [Agent Memory](https://agentmemories.ai) textual track (`/add`, `/search`, `/health`) with strict `user_id` isolation; `lib/bench.ts` + `tests/bench.test.ts`.
- **Dockerfile** — evaluation image exposing only the bench HTTP endpoints.
- **Rule auto-scoring** — base 3 points, −1 per 60 days, plus frequency/recency/domain/feedback bonuses; rules panel gains thumbs up/down; high-score rules auto-escalate to `AGENTS.md`.
- **Dashboard i18n** — EN/中文 toggle persisted in `localStorage.lang`, remembers the active tab; skill descriptions switch to `description_en` in English mode.

### v1.9.2 (2026-08-11) In-process review + stable dashboard daemon

- **Reviews run inside opencode, no external CLI needed** (`spawnReviewSdk`); the detached CLI spawn remains only as a last-resort fallback.
- **Detached dashboard daemon** — survives opencode restarts; port stays fixed.
- Generic per-row edit/delete across dashboard tabs.
- Soft-delete filter fixes; consolidated `review_triggered` observations.

### v1.9.1 (2026-08-11) Dashboard management panel

- Editable/deletable memories in the dashboard panel.
- `memory.daily` daily summary section.
- Chinese labels for tiers/status/goals.

### v1.9.0 (2026-08-10) OpenCode UI integration

- Auto background server on plugin load (`serve(9210)`).
- `/selfforge` command + `selfforge_status`/`selfforge_dashboard` tools.
- Terminal text overview (`dashboardText()`); singleton serving.

### v1.8.0 (2026-08-10) Native memory state

- Fixed-size session state (`session_summaries`), informative write gate, recall evidence loop (`recall_evidence`), tiered injection fusion, recall eval benchmark.

### v1.7.0 (2026-08-10) Engine phases 1–5

- Skill trial lifecycle, decision repair, anti-hallucination verification, pattern candidates, workspace awareness, cross-agent transfer, team sync, visual dashboard.

### v1.5.0 (2026-08-09) Sync primitives

- Row-level sync identity (`uuid` + `origin` + `deleted` tombstone), node_id + Lamport clock.

### v1.4.0 (2026-08-09) Modularized entry

- Tool registration moved into `lib/tools/*` grouped by domain.

### v1.3.0 (2026-08-09) Memory contract & contamination defense

- Candidate zone, scope isolation, confidence & TTL, store-level write guard, memory trace, regression suite.

### v1.2.0 (2026-08-09) Memory lifecycle management

- Adaptive exponential decay, lifecycle promotion/demotion, memory classification, daily brief, VACUUM maintenance.

### v1.1.0 (2026-08-09) Recall & session search

- Ground Truth hierarchy, surgical `memory_search`, FTS5 session search, decay & dedup.

### v1.0.0 (2026-08-07) Initial release

- Unified self-evolution engine, single SQLite store, one-command install.

## License

MIT