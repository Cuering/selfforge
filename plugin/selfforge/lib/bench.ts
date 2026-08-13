/**
 * Agent Memory Leaderboard evaluation contract.
 *
 * The leaderboard (agentmemories.ai) evaluates memory systems by calling
 * participant HTTP endpoints:
 *   POST /add     — synchronous persist of a session's messages
 *   POST /search  — retrieve ranked memory candidates for a question
 *   GET  /health  — unauthenticated liveness (any 2xx)
 *
 * Contract (see also lib/rpc.ts route wiring):
 *   - Add: request { request_id, messages:[{role,timestamp?,content}], user_id, session_id }
 *           must persist synchronously, then HTTP 200 with success:true and echoed ids.
 *           Never return 202 / task id / polling URL.
 *   - Search: request { query, options?:[], user_id, top_k }
 *           returns { data:[{id, content, score?, created_at?}] } relevance-ordered.
 *           user_id is the ONLY isolation boundary; never cross-user recall.
 *   - Content goes straight to the answer model — return evidence, not answers.
 */
import { getDb, stamp } from "./db"

type BenchRow = {
  id: number
  uuid: string
  user_id: string
  session_id: string
  role: string
  content: string
  memory_ts: number
  created_at: string
  deleted: number
}

/** Ensure the bench table exists (idempotent; called at module load). */
export function ensureBenchSchema(): void {
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS bench_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE,
        user_id TEXT NOT NULL,
        session_id TEXT,
        role TEXT,
        content TEXT NOT NULL,
        memory_ts INTEGER DEFAULT 0,
        created_at TEXT,
        deleted INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_bench_user ON bench_memories (user_id, deleted);
    `)
  } catch {}
}
ensureBenchSchema()

function tokenize(s: string): Set<string> {
  return new Set(
    (s || "")
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .filter((t) => t.length > 1)
  )
}

/** Overlap score: |A ∩ B| / |A|  (query coverage in content). */
function overlapScore(query: string, content: string): number {
  const q = tokenize(query)
  if (q.size === 0) return 0
  const c = tokenize(content)
  if (c.size === 0) return 0
  let hit = 0
  for (const t of q) if (c.has(t)) hit++
  // Penalize very short queries to avoid trivial matches.
  return q.size <= 1 ? (hit > 0 ? 0.3 : 0) : hit / q.size
}

/** Exact phrase match gives a strong bonus. */
function phraseScore(query: string, content: string): number {
  const q = (query || "").trim().toLowerCase()
  const c = (content || "").toLowerCase()
  if (!q) return 0
  if (c.includes(q)) return 1
  return 0
}

export type BenchAddResult = {
  success: boolean
  request_id: string
  user_id: string
  session_id: string
  stored: number
}

/** Synchronous Add: persist messages, then return. */
export function benchAdd(input: {
  request_id: string
  messages: Array<{ role: string; timestamp?: number; content: string }>
  user_id: string
  session_id: string
}): BenchAddResult {
  const db = getDb()
  const request_id = String(input.request_id || "")
  const user_id = String(input.user_id || "")
  const session_id = String(input.session_id || "")
  const messages = Array.isArray(input.messages) ? input.messages : []
  let stored = 0
  for (const m of messages) {
    const content = String(m.content || "").trim()
    if (!content) continue
    const st = stamp()
    db.query(
      "INSERT INTO bench_memories (uuid, user_id, session_id, role, content, memory_ts, created_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)"
    ).run(st.uuid, user_id, session_id, String(m.role || "user"), content, Number(m.timestamp || 0), st.created_at)
    stored++
  }
  return { success: true, request_id, user_id, session_id, stored }
}

export type BenchSearchResult = {
  data: Array<{ id: string; content: string; score: number; created_at?: string }>
}

/** Synchronous Search: isolate by user_id, rank by relevance. */
export function benchSearch(input: { query: string; user_id: string; top_k?: number }): BenchSearchResult {
  const db = getDb()
  const query = String(input.query || "")
  const user_id = String(input.user_id || "")
  const top_k = Math.max(1, Math.min(100, Number(input.top_k) || 100))
  if (!user_id) return { data: [] }
  const rows = db
    .query(
      "SELECT id, uuid, session_id, content, memory_ts, created_at FROM bench_memories WHERE user_id = ? AND deleted = 0"
    )
    .all(user_id) as Array<{ id: number; uuid: string; session_id: string; content: string; memory_ts: number; created_at: string }>
  if (!query) {
    // Empty query: return latest memories first (fallback for degenerate cases).
    const out = rows
      .slice(-top_k)
      .reverse()
      .map((r) => ({ id: r.uuid, content: r.content, score: 0, created_at: r.created_at }))
    return { data: out }
  }
  const scored = rows.map((r) => {
    const phrase = phraseScore(query, r.content)
    const overlap = overlapScore(query, r.content)
    // Recency gentle boost: newer content slightly preferred on ties.
    const recency = Math.max(0, Math.min(1, (Date.now() - (r.memory_ts || 0)) / 86400000 / 30))
    const score = phrase * 1 + overlap * 0.8 + (1 - recency) * 0.05
    return { r, score }
  })
  scored.sort((a, b) => b.score - a.score || b.r.id - a.r.id)
  const data = scored
    .slice(0, top_k)
    .map(({ r, score }) => ({ id: r.uuid, content: r.content, score: Math.round(score * 100) / 100, created_at: r.created_at }))
  return { data }
}

/** Optional: drop all bench data for a user (used by reset). */
export function benchClear(user_id: string): { cleared: number } {
  const res = getDb()
    .query("UPDATE bench_memories SET deleted = 1 WHERE user_id = ?")
    .run(String(user_id))
  return { cleared: Number(res.changes) }
}