# Memory Contract

This document fixes the operating rules of selfforge's long-term memory. Before any memory is written, these questions must be answered: where does the info come from, who can change it, when does it expire, how is it deleted, and how can it be rolled back.

## 1. What is stored vs queried live

| Layer | Content | How it's handled |
|---|---|---|
| L0 Rules | must-follow constraints (project/global rules, permissions, hooks) | `rule_*` → AGENTS.md; highest priority, never overridden by memory |
| L1 Current facts | repo state, git diff, build scripts, test results, CI | always re-queried at task start, never stored |
| L2 Task state | this task's progress | session buffer, cleaned up after the task |
| L3 Memory | cross-session lessons that change future behavior | `memory_*`, tiered/lifecycled, decayed, scoped |

Only L3 enters the persistent store. L1 is never cached in memory: storing a source snapshot or CI result today creates a stale contradiction tomorrow.

## 2. Provenance (where each memory comes from)

- `source` column: manual / review / migration / evolution.
- `project`: which project the lesson was learned in.
- `scope` (optional path glob, e.g. `services/payment/**`): constrains where the lesson applies. A payment lesson must never surface in a search module recall.

## 3. Status and the candidate zone

- `status = confirmed`: user-endorsed or explicitly confirmed; the only memories that reach recall and injected context.
- `status = candidate`: auto-inferred lessons awaiting human review (`memory_confirm` / `memory_reject`). Candidates are never recalled and never injected.
- Explicit user statements ("remember this", corrections) may be written directly as confirmed. Auto-inference must go to the candidate zone first.
- Merging a near-duplicate (sim ≥ 0.7) counts as a confirmation.

## 4. Confidence

- `confidence` 1–10. Explicit instructions default to 8; inferred candidates default to 4. Confirming raises it to at least 8.

## 5. Expiry (TTL)

- `expires_at` (ISO timestamp) marks temporary facts (e.g. an order status). Past expiry ⇒ excluded from recall and archived by `memoryDecay`.
- Inactivity decay: strength decays by adaptive half-life; long-inactive memories demote a lifecycle level; stale, low-value memories archive.

## 6. Who can change what

| Action | Who |
|---|---|
| Write confirmed memory | agent, on explicit user instruction or verified correction |
| Write candidate | agent, auto-inference only |
| Confirm/reject candidate | human (via `memory_confirm`/`memory_reject`) |
| Weaken/archive | agent on request; decay handles aging automatically |
| Delete | human via `memory_remove` (archives, never hard-deletes) |

## 7. Deletion and rollback

- `memory_remove` archives (soft delete) — the row stays for traceability.
- AGENTS.md writes and skill rewrites are human-gated and reversible by editing the file / reverting the skill.
- The store is a single SQLite file (`~/.evolve/unified.db`), so a backup is one file copy.

## 8. Conflict policy (memory vs current facts)

Injected memory is authoritative for documented knowledge and prior decisions — but it is a clue, never a substitute for current facts. If memory contradicts the current repo, build scripts, test results or an explicit user instruction, the current fact wins; the stale memory should be weakened, archived, or noted for cleanup.

## 9. What is never stored

- Credentials, tokens, API keys, internal addresses (rejected at write time).
- Source snapshots, CI state, and other fast-changing facts.
- Unverified guesses mid-diagnosis (task state only).
- Vague preferences that would override project conventions (kept as low-priority user profile at most).

## 10. Observability

Every recall records a `memory_trace` observation: query, scope, recalled ids, injected criteria. Combined with `memory_add` observations, a failure can be traced to write error, recall error, or stale-memory-overrides-current-fact.
