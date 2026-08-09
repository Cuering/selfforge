import { writeFileSync } from "fs"
import { join } from "path"
import { getDb, getConfig, now, EVOLVE_HOME } from "./db"

export const CONTEXT_FILE = join(EVOLVE_HOME, "memory.context.md")

export type Memory = {
  id: number
  content: string
  source: string
  project: string | null
  strength: number
  tier: string
  created_at: string
  updated_at: string
  last_reinforced_at: string | null
  archived: number
}

function computeTier(strength: number): string {
  if (strength >= 5) return "hot"
  if (strength >= 2) return "warm"
  if (strength >= 1) return "cold"
  return "evictable"
}

export function memoryAdd(content: string, opts?: { source?: string; project?: string }) {
  const db = getDb()
  const ts = now()
  const info = db
    .query(
      "INSERT INTO memories (content, source, project, strength, tier, created_at, updated_at, last_reinforced_at, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)"
    )
    .run(
      content,
      opts?.source ?? "manual",
      opts?.project ?? null,
      1,
      computeTier(1),
      ts,
      ts,
      ts
    )
  return { id: Number(info.lastInsertRowid), content, tier: computeTier(1) }
}

export function memoryList(opts?: { archived?: boolean; tier?: string; limit?: number }): Memory[] {
  const where: string[] = []
  const params: unknown[] = []
  if (!opts?.archived) where.push("archived = 0")
  if (opts?.tier) {
    where.push("tier = ?")
    params.push(opts.tier)
  }
  const sql = `SELECT * FROM memories ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY strength DESC, last_reinforced_at DESC LIMIT ?`
  params.push(opts?.limit ?? 50)
  return getDb().query(sql).all(...params) as Memory[]
}

export function memoryStrengthen(keyword: string) {
  const db = getDb()
  const rows = db
    .query("SELECT * FROM memories WHERE archived = 0 AND content LIKE ?")
    .all(`%${keyword}%`) as Memory[]
  if (rows.length === 0) return { matched: 0, message: `No memory matches "${keyword}"` }
  const ts = now()
  for (const r of rows) {
    const newStrength = r.strength + 1
    db.query(
      "UPDATE memories SET strength = ?, tier = ?, updated_at = ?, last_reinforced_at = ? WHERE id = ?"
    ).run(newStrength, computeTier(newStrength), ts, ts, r.id)
  }
  return { matched: rows.length, ids: rows.map((r) => r.id) }
}

export function memoryWeaken(keyword: string) {
  const db = getDb()
  const rows = db
    .query("SELECT * FROM memories WHERE archived = 0 AND content LIKE ?")
    .all(`%${keyword}%`) as Memory[]
  if (rows.length === 0) return { matched: 0, message: `No memory matches "${keyword}"` }
  const ts = now()
  for (const r of rows) {
    const newStrength = Math.max(0, r.strength - 1)
    db.query(
      "UPDATE memories SET strength = ?, tier = ?, updated_at = ? WHERE id = ?"
    ).run(newStrength, computeTier(newStrength), ts, r.id)
  }
  return { matched: rows.length, ids: rows.map((r) => r.id) }
}

export function memoryRemove(keyword: string) {
  const db = getDb()
  const rows = db
    .query("SELECT * FROM memories WHERE content LIKE ?")
    .all(`%${keyword}%`) as Memory[]
  if (rows.length === 0) return { matched: 0, message: `No memory matches "${keyword}"` }
  for (const r of rows) {
    db.query("UPDATE memories SET archived = 1, updated_at = ? WHERE id = ?").run(now(), r.id)
  }
  return { archived: rows.length, ids: rows.map((r) => r.id) }
}

export function memorySummary(): { hot: number; warm: number; cold: number; evictable: number } {
  const rows = getDb()
    .query("SELECT tier, COUNT(*) AS n FROM memories WHERE archived = 0 GROUP BY tier")
    .all() as { tier: string; n: number }[]
  const out = { hot: 0, warm: 0, cold: 0, evictable: 0 }
  for (const r of rows) out[r.tier as keyof typeof out] = r.n
  return out
}

const DAY_MS = 86400000

/**
 * Time-based decay: memories not reinforced for `decayDays` lose strength
 * (drop tier); once strength <= 1 and older than `archiveDays`, they are
 * archived. Prevents stale lessons from accumulating.
 * Call periodically (e.g. on session idle / plugin load).
 */
export function memoryDecay(opts?: { decayDays?: number; archiveDays?: number }) {
  const decayDays = opts?.decayDays ?? (Number(getConfig("memory_decay_days", "30")) || 30)
  const archiveDays = opts?.archiveDays ?? (Number(getConfig("memory_archive_days", "120")) || 120)
  const nowMs = Date.now()
  const db = getDb()
  const rows = db.query("SELECT * FROM memories WHERE archived = 0").all() as Memory[]
  let decayed = 0
  let archived = 0
  for (const r of rows) {
    const last = r.last_reinforced_at ? new Date(r.last_reinforced_at).getTime() : nowMs
    const ageDays = (nowMs - last) / DAY_MS
    if (ageDays < decayDays) continue
    if (r.strength <= 1 && ageDays > archiveDays) {
      db.query("UPDATE memories SET archived = 1, updated_at = ? WHERE id = ?").run(now(), r.id)
      archived++
      continue
    }
    const ns = Math.max(0, r.strength - 1)
    db.query(
      "UPDATE memories SET strength = ?, tier = ?, updated_at = ? WHERE id = ?"
    ).run(ns, computeTier(ns), now(), r.id)
    decayed++
  }
  return { decayed, archived }
}

/** Token-set similarity for lightweight dedup (latin + CJK). */
function similarity(a: string, b: string): number {
  const ta = tokenize(a)
  const tb = tokenize(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const w of ta) if (tb.has(w)) inter++
  return inter / Math.min(ta.size, tb.size)
}

/** Dedup-aware add: strengthen the best near-duplicate (sim >= 0.7) instead of inserting. */
export function memoryAddDedup(content: string, opts?: { source?: string; project?: string }) {
  const rows = getDb().query("SELECT * FROM memories WHERE archived = 0").all() as Memory[]
  let best: Memory | undefined
  let bestSim = 0
  for (const r of rows) {
    const sim = similarity(content, r.content)
    if (sim > bestSim) {
      best = r
      bestSim = sim
    }
  }
  if (best && bestSim >= 0.7) {
    const ts = now()
    const newStrength = best.strength + 1
    getDb()
      .query(
        "UPDATE memories SET strength = ?, tier = ?, updated_at = ?, last_reinforced_at = ? WHERE id = ?"
      )
      .run(newStrength, computeTier(newStrength), ts, ts, best.id)
    return { merged: true, id: best.id, strength: newStrength, tier: computeTier(newStrength) }
  }
  return { merged: false, ...memoryAdd(content, opts) }
}

const GROUND_TRUTH =
  "> **Authority (Ground Truth):** The injected memory below is authoritative for documented knowledge and prior decisions. When it contradicts assumptions, memory wins. Never treat a question as novel when the answer is already here, and do not re-run search/review tools to rediscover what this context already provides.\n\n"

function tokenize(text: string): Set<string> {
  return new Set(
    (text || "")
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .filter((w) => w.length > 1)
  )
}

/**
 * Lightweight relevance recall: score memories against a query by keyword
 * overlap (token intersection, weighted by strength). Used for surgical
 * injection rather than dumping the whole store. Threshold-guarded.
 */
export function memoryRecall(query: string, opts?: { minScore?: number; limit?: number }): Memory[] {
  const minScore = opts?.minScore ?? 2
  const limit = opts?.limit ?? 5
  if (!query || query.trim().length < 2) return []
  const q = tokenize(query)
  const rows = memoryList({ limit: 500 })
  const scored: Array<{ m: Memory; score: number }> = []
  for (const m of rows) {
    const mt = tokenize(m.content)
    if (mt.size === 0) continue
    let hits = 0
    for (const w of q) if (mt.has(w)) hits++
    if (hits < minScore) continue
    const tierBonus = m.tier === "hot" ? 1 : m.tier === "warm" ? 0.5 : 0
    scored.push({ m, score: hits + tierBonus })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((x) => x.m)
}

export function composeMemoryContext(): string {
  const memories = memoryList({ limit: 30 })
  const profile = getDb()
    .query("SELECT keyword, content FROM user_profile ORDER BY created_at DESC LIMIT 20")
    .all() as { keyword: string; content: string }[]
  let md = "# Evolve Memory\n\n<!-- Managed by unified-evolver. Do not edit manually. -->\n\n"
  md += GROUND_TRUTH
  if (profile.length > 0) {
    md += "## User Profile\n\n"
    for (const p of profile) md += `- **${p.keyword}**: ${p.content}\n`
    md += "\n"
  }
  if (memories.length === 0) {
    md += "_No persistent memories yet._\n"
    writeFileSync(CONTEXT_FILE, md)
    return md
  }
  md += "## Persistent Lessons\n\n"
  for (const m of memories) {
    md += `- [${m.tier}/${m.strength}] ${m.content}\n`
  }
  writeFileSync(CONTEXT_FILE, md)
  return md
}
