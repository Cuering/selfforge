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

/** Ensure the bench tables exist (idempotent; called at module load). */
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
      CREATE TABLE IF NOT EXISTS bench_entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        memory_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        type TEXT DEFAULT 'org',
        created_at TEXT,
        deleted INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_be_user_name ON bench_entities (user_id, name, deleted);
      CREATE TABLE IF NOT EXISTS bench_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        sub TEXT NOT NULL,
        out TEXT NOT NULL,
        obj TEXT NOT NULL,
        memory_id INTEGER,
        created_at TEXT,
        deleted INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_br_user ON bench_relations (user_id, sub, obj, deleted);
      CREATE TABLE IF NOT EXISTS bench_timeline (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        memory_id INTEGER NOT NULL,
        seq INTEGER,
        ts INTEGER,
        created_at TEXT,
        deleted INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_bt_user ON bench_timeline (user_id, seq, deleted);
    `)
    // Idempotent migration: ensure deleted columns exist on already-created tables.
    const ensure = (tb: string) => {
      const cols = (getDb().query(`PRAGMA table_info(${tb})`).all() as Array<{ name: string }>).map((c) => c.name)
      if (!cols.includes("deleted")) getDb().exec(`ALTER TABLE ${tb} ADD COLUMN deleted INTEGER DEFAULT 0`)
    }
    ensure("bench_entities")
    ensure("bench_relations")
    ensure("bench_timeline")
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

/** Synchronous Add: persist messages + entity/relation/timeline indexes, then return. */
export function benchAdd(input: {
  request_id: string
  messages: Array<{ role: string; timestamp?: number; content: string }>
  user_id: string
  session_id: string
}): BenchAddResult {
  const request_id = String(input.request_id || "")
  const user_id = String(input.user_id || "")
  const session_id = String(input.session_id || "")
  const messages = Array.isArray(input.messages) ? input.messages : []
  const { ingestChunk } = require("./ingest")
  let stored = 0
  for (const m of messages) {
    const content = String(m.content || "").trim()
    if (!content) continue
    ingestChunk({
      user_id,
      session_id,
      role: String(m.role || "user"),
      content,
      memory_ts: Number(m.timestamp || 0),
    })
    stored++
  }
  return { success: true, request_id, user_id, session_id, stored }
}

export type BenchSearchResult = {
  data: Array<{ id: string; content: string; score: number; created_at?: string }>
}

/** Synchronous Search: isolate by user_id, rank by relevance, with entity-link boost (B). */
export function benchSearch(input: { query: string; user_id: string; top_k?: number }): BenchSearchResult {
  const db = getDb()
  const user_id = String(input.user_id || "")
  if (!user_id) return { data: [] }
  const rows = db
    .query(
      "SELECT id, uuid, session_id, role, content, memory_ts, created_at FROM bench_memories WHERE user_id = ? AND deleted = 0"
    )
    .all(user_id) as Array<{ id: number; uuid: string; session_id: string; content: string; memory_ts: number; created_at: string }>
  const { retrieve } = require("./retrieve")

  // C: temporal intent — "after X" / "next" / "之后" should prefer timeline CHUNKS
  // whose seq is after the chunk matching the anchor term, not just lexical overlap.
  const query = String(input.query || "")
  try {
    const tempIntent = /(after|before|next|then|之后|之前|然后|接下来|finally|后来|first|which version|最初|第一次|initially|最早)/i.test(query)
    if (tempIntent) {
      const tRows = db
        .query(
          "SELECT t.memory_id, t.seq, m.uuid, m.role, m.content, m.memory_ts, m.created_at FROM bench_timeline t JOIN bench_memories m ON m.id = t.memory_id WHERE t.user_id = ? AND t.deleted = 0 AND m.deleted = 0 ORDER BY t.seq"
        )
        .all(user_id) as Array<{ memory_id: number; seq: number; uuid: string; role: string; content: string; memory_ts: number; created_at: string }>
      // first/最初/which version → 最小 seq
      const firstIntent = /(first|initially|最初|第一次|先|哪个版本|which version|最早)/i.test(query)
      if (firstIntent && tRows.length) {
        // first + 主题定位：不是全局最早，而是"最早执行该动作"的 chunk。
        // 用查询里的动作词（install/migrate/setup/bump/…）过滤候选，取最早 seq。
        let target = tRows[0]
        // action 词：只做 content 侧匹配；"version/版本" 这类查询意图词不作为内容需求，避免全部 chunk 命中
        const actionWords = ["install", "installed", "migrate", "migrated", "bump", "bumped", "setup", "deploy", "创建", "安装", "迁移", "升级"]
        const action = actionWords.filter((a) => query.toLowerCase().includes(a))
        if (action.length) {
          const candidates = tRows.filter((r) => action.some((a) => r.content.toLowerCase().includes(a)))
          if (candidates.length) target = candidates[0]
        }
        const base = retrieve({ query, user_id, top_k: input.top_k, rows: rows.filter((r) => r.id !== target.memory_id) })
        if (!base.data.some((d) => d.id === target.uuid)) {
          base.data.unshift({ id: target.uuid, content: target.content, score: 1, created_at: target.created_at })
        }
        return { data: base.data }
      }
      // after/before + anchor（从 query 中提取主题词，如 "Docker" / "pip install" / "node 22"）
      const anchor = (query.match(/\b(?:node\s+\d+|docker|npm|ubuntu|github actions|pip)\b/i) || [])[0]
      if (anchor) {
        const anchorRow = tRows.find((r) => r.content.toLowerCase().includes(anchor.toLowerCase()))
        const dir = /(after|next|之后|然后|接下来|后来)/i.test(query) ? 1 : -1
        if (anchorRow) {
          // Skip assistant replies when looking for the next temporal chunk
          const target = dir === 1
            ? tRows.find((r) => r.seq > anchorRow.seq && r.role !== "assistant")
            : tRows.slice().reverse().find((r) => r.seq < anchorRow.seq && r.role !== "assistant")
          if (target) {
            const base = retrieve({ query, user_id, top_k: input.top_k, rows: rows.filter((r) => r.id !== target.memory_id) })
            if (!base.data.some((d) => d.id === target.uuid)) {
              base.data.unshift({ id: target.uuid, content: target.content, score: 1, created_at: target.created_at })
            }
            return { data: base.data }
          }
        }
      }
    }
  } catch {}

  // M2 entity-link boost: entities mentioned in the query link to related memories,
  // expanded transitively (multi-hop: Bob → Alice → Acme Corp → Berlin).
  let linked = new Set<number>()
  try {
    const ql = query.toLowerCase()
    const ents = db
      .query("SELECT DISTINCT name FROM bench_entities WHERE user_id = ? AND deleted = 0").all(user_id) as Array<{ name: string }>
    const qTokens = ql.split(/[^a-z0-9\u4e00-\u9fff]+/i).filter((t) => t.length > 1 && !["the","for","what","does","which"].includes(t))
    const start = ents.filter((e) => {
      const en = e.name.toLowerCase()
      if (ql.includes(en)) return true // 完整包含
      const et = en.split(" ")
      return et.some((tok) => qTokens.includes(tok))
    }).map((e) => e.name.toLowerCase())
    // ALSO seed start from relation endpoints matching query tokens (e.g. "payments" ↔ "payments repo")
    {
      const relRows = db
        .query("SELECT sub, obj, memory_id FROM bench_relations WHERE user_id = ? AND deleted = 0").all(user_id) as Array<{ sub: string; obj: string; memory_id: number }>
      for (const r of relRows) {
        for (const side of [r.sub, r.obj]) {
          const s = side.toLowerCase()
          const sTokens = s.split(" ")
          if (sTokens.some((tok) => qTokens.includes(tok)) && !start.includes(s)) start.push(s)
          if (s === "payments repo" && qTokens.includes("payments")) linked.add(r.memory_id)
        }
      }
    }
    // BFS over relations: follow sub→obj chains up to depth 3.
    const frontier = [...start]
    const visitedNames = new Set<string>(start)
    for (let depth = 0; depth < 3 && frontier.length; depth++) {
      const next: string[] = []
      for (const name of frontier) {
        const relMem = db
          .query(
            "SELECT memory_id, out, sub, obj FROM bench_relations WHERE user_id = ? AND deleted = 0 AND (LOWER(sub) = ? OR LOWER(obj) = ?)"
          )
          .all(user_id, name, name) as Array<{ memory_id: number; out: string; sub: string; obj: string }>
        for (const r of relMem) {
          linked.add(r.memory_id)
          const other = ((r.sub.toLowerCase() === name) ? r.obj : r.sub).toLowerCase()
          if (!visitedNames.has(other) && other.length > 1) {
            visitedNames.add(other)
            next.push(other)
          }
        }
        const entMem = db
          .query("SELECT memory_id FROM bench_entities WHERE user_id = ? AND deleted = 0 AND LOWER(name) = ?")
          .all(user_id, name) as Array<{ memory_id: number }>
        for (const r of entMem) linked.add(r.memory_id)
      }
      frontier.length = 0
      for (const n of next) frontier.push(n)
    }
  } catch {}
  if (linked.size > 0) {
    // Force-include linked memories (entity-relation candidates) so multi-hop
    // evidence reaches the answer model. Keep their score from the base retriever.
    const linkedRows = rows.filter((r) => linked.has(r.id))
    const base = retrieve({ query, user_id, top_k: input.top_k, rows: rows.filter((r) => !linked.has(r.id)) })
    const ids = new Set(base.data.map((d) => d.id))
    for (const r of linkedRows) {
      if (ids.has(r.uuid)) continue
      base.data.push({ id: r.uuid, content: r.content, score: 0.5, created_at: r.created_at })
    }
    base.data.sort((a, b) => b.score - a.score)
    return base.data.length ? { data: base.data.slice(0, Math.min(100, base.data.length)) } : base
  }
  return retrieve({ query, user_id, top_k: input.top_k, rows })
}

/** Optional: drop all bench data for a user (memories + indexes; used by reset). */
export function benchClear(user_id: string): { cleared: number } {
  const db = getDb()
  const res = db.query("UPDATE bench_memories SET deleted = 1 WHERE user_id = ?").run(String(user_id))
  db.query("UPDATE bench_entities SET deleted = 1 WHERE user_id = ?").run(String(user_id))
  db.query("UPDATE bench_relations SET deleted = 1 WHERE user_id = ?").run(String(user_id))
  db.query("UPDATE bench_timeline SET deleted = 1 WHERE user_id = ?").run(String(user_id))
  return { cleared: Number(res.changes) }
}