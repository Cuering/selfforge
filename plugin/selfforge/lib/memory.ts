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
  last_accessed_at: string | null
  access_count: number
  importance: number
  lifecycle: string
  type: string
  archived: number
  scope: string | null
  status: string
  confidence: number
  expires_at: string | null
}

export const MEMORY_TYPES = [
  "preference",
  "insight",
  "instruction",
  "fact",
  "decision",
  "episodic",
] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]

export const LIFECYCLE_ORDER = ["temporary", "active", "permanent", "archived"] as const
export type Lifecycle = (typeof LIFECYCLE_ORDER)[number]

// Adaptive decay constants (ported from the LanXin memory_system_manager decay_v2).
const BASE_HALF_LIFE = 7.0 // days
const MIN_HALF_LIFE = 1.5
const MAX_HALF_LIFE = 30.0
const ACCESS_BONUS = 0.15 // per access, capped at +150%
const IMPORTANCE_WEIGHT = 0.3
const RECENCY_WEIGHT = 0.2
const PROMOTE_THRESHOLD = 15 // accesses
const PROMOTE_PERMANENT_THRESHOLD = 30 // accesses
const DEMOTE_THRESHOLD = 30 // inactive days
const ARCHIVE_THRESHOLD = 90 // inactive days

/** Next lifecycle level given current access count (temporary->active->permanent). */
function nextLifecycle(lifecycle: string, access: number): { lifecycle: string; promoted: boolean } {
  const level = lifecycleLevel(lifecycle)
  if (level >= 2) return { lifecycle, promoted: false }
  const threshold = level === 0 ? PROMOTE_THRESHOLD : PROMOTE_PERMANENT_THRESHOLD
  if (access >= threshold) {
    return { lifecycle: LIFECYCLE_ORDER[level + 1], promoted: true }
  }
  return { lifecycle, promoted: false }
}

export function computeTier(strength: number): string {
  if (strength >= 5) return "hot"
  if (strength >= 2) return "warm"
  if (strength >= 1) return "cold"
  return "evictable"
}

function calcHalfLife(strength: number, accessCount: number, inactiveDays: number, importance: number): number {
  let hl = BASE_HALF_LIFE
  hl *= 1 + Math.min(accessCount * ACCESS_BONUS, 1.5)
  hl *= 1 + ((importance - 5) / 10) * IMPORTANCE_WEIGHT
  if (inactiveDays < 1) hl *= 1 + RECENCY_WEIGHT
  return Math.max(MIN_HALF_LIFE, Math.min(MAX_HALF_LIFE, hl))
}

/** Exponential half-life decay: new = old * 0.5^(inactiveDays/halfLife). */
function applyDecay(strength: number, accessCount: number, inactiveDays: number, importance: number): number {
  const hl = calcHalfLife(strength, accessCount, inactiveDays, importance)
  const factor = Math.pow(0.5, inactiveDays / hl)
  return Math.max(0.05, strength * factor)
}

export function lifecycleLevel(lc: string): number {
  const i = LIFECYCLE_ORDER.indexOf(lc as Lifecycle)
  return i === -1 ? 1 : i
}

/** Reject content that should never enter long-term memory (secrets, config, code snapshots). */
const BLOCKED_PATTERNS = [
  /\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]+)\b/,
  /\b(?:password|passwd|secret|api_key|apikey|access_token|auth_token|private_key)\s*[:=]\s*\S+/i,
]
export function isBlockedMemoryContent(content: string): { blocked: boolean; reason?: string } {
  if (!content) return { blocked: false }
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(content)) {
      return { blocked: true, reason: "contains credential/secret-like content" }
    }
  }
  // code snapshots / file dumps are too volatile to store as durable lessons
  if (/^```[\s\S]*```$/m.test(content) && content.length > 500) {
    return { blocked: true, reason: "looks like a code/file snapshot rather than a durable lesson" }
  }
  return { blocked: false }
}

export function memoryAdd(
  content: string,
  opts?: {
    source?: string
    project?: string
    importance?: number
    type?: MemoryType
    scope?: string
    status?: "confirmed" | "candidate"
    confidence?: number
    expires_at?: string
  }
) {
  const db = getDb()
  const ts = now()
  // store-level guard: blocked content must never reach long-term memory
  const blocked = isBlockedMemoryContent(content)
  if (blocked.blocked) {
    return { id: 0, blocked: true, reason: blocked.reason, tier: "", type: "fact", importance: 5, status: "confirmed", confidence: 8 }
  }
  const importance = Math.max(1, Math.min(10, opts?.importance ?? 5))
  const type = opts?.type && MEMORY_TYPES.includes(opts.type) ? opts.type : "fact"
  const status = opts?.status === "candidate" ? "candidate" : "confirmed"
  const confidence = Math.max(1, Math.min(10, opts?.confidence ?? (status === "candidate" ? 4 : 8)))
  const info = db
    .query(
      "INSERT INTO memories (content, source, project, strength, tier, importance, lifecycle, type, scope, status, confidence, expires_at, created_at, updated_at, last_reinforced_at, last_accessed_at, access_count, archived) VALUES (?, ?, ?, ?, ?, ?, 'temporary', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)"
    )
    .run(
      content,
      opts?.source ?? "manual",
      opts?.project ?? null,
      1,
      computeTier(1),
      importance,
      type,
      opts?.scope ?? null,
      status,
      confidence,
      opts?.expires_at ?? null,
      ts,
      ts,
      ts,
      ts
    )
  return { id: Number(info.lastInsertRowid), content, tier: computeTier(1), type, importance, status, confidence }
}

export function memoryList(opts?: {
  archived?: boolean
  tier?: string
  status?: string
  scope?: string
  limit?: number
}): Memory[] {
  const where: string[] = []
  const params: unknown[] = []
  if (!opts?.archived) where.push("archived = 0")
  if (opts?.tier) {
    where.push("tier = ?")
    params.push(opts.tier)
  }
  if (opts?.status) {
    where.push("status = ?")
    params.push(opts.status)
  }
  if (opts?.scope) {
    where.push("(scope IS NULL OR scope = ?)")
    params.push(opts.scope)
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
  const promoted: number[] = []
  for (const r of rows) {
    const newStrength = r.strength + 1
    const access = (r.access_count ?? 0) + 1
    // lifecycle promotion: frequent access upgrades temporary -> active -> permanent
    const cur = r.lifecycle ?? "temporary"
    const nxt = nextLifecycle(cur, access)
    if (nxt.promoted) promoted.push(r.id)
    db.query(
      "UPDATE memories SET strength = ?, tier = ?, access_count = ?, lifecycle = ?, updated_at = ?, last_reinforced_at = ?, last_accessed_at = ? WHERE id = ?"
    ).run(newStrength, computeTier(newStrength), access, nxt.lifecycle, ts, ts, ts, r.id)
  }
  return { matched: rows.length, ids: rows.map((r) => r.id), promoted }
}

export function memoryWeaken(keyword: string) {
  const db = getDb()
  const rows = db
    .query("SELECT * FROM memories WHERE archived = 0 AND content LIKE ?")
    .all(`%${keyword}%`) as Memory[]
  if (rows.length === 0) return { matched: 0, message: `No memory matches "${keyword}"` }
  const ts = now()
  const demoted: number[] = []
  for (const r of rows) {
    const newStrength = Math.max(0, r.strength - 1)
    // lifecycle demotion on manual weaken
    let lifecycle = r.lifecycle ?? "temporary"
    if (lifecycleLevel(lifecycle) > 0 && newStrength < 2) {
      lifecycle = LIFECYCLE_ORDER[lifecycleLevel(lifecycle) - 1]
      demoted.push(r.id)
    }
    db.query(
      "UPDATE memories SET strength = ?, tier = ?, lifecycle = ?, updated_at = ? WHERE id = ?"
    ).run(newStrength, computeTier(newStrength), lifecycle, ts, r.id)
  }
  return { matched: rows.length, ids: rows.map((r) => r.id), demoted }
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

export function memoryBrief(): {
  active: number
  archived: number
  addedToday: number
  byType: Record<string, number>
  byLifecycle: Record<string, number>
  health: string[]
} {
  const db = getDb()
  const today = new Date().toISOString().slice(0, 10)
  const active = (db.query("SELECT COUNT(*) AS n FROM memories WHERE archived = 0").get() as { n: number }).n
  const archived = (db.query("SELECT COUNT(*) AS n FROM memories WHERE archived = 1").get() as { n: number }).n
  const addedToday = (db.query("SELECT COUNT(*) AS n FROM memories WHERE archived = 0 AND created_at >= ?").get(today) as { n: number }).n
  const byType: Record<string, number> = {}
  for (const r of db.query("SELECT type, COUNT(*) AS n FROM memories WHERE archived = 0 GROUP BY type").all() as Array<{ type: string; n: number }>) {
    byType[r.type] = r.n
  }
  const byLifecycle: Record<string, number> = {}
  for (const r of db.query("SELECT lifecycle, COUNT(*) AS n FROM memories WHERE archived = 0 GROUP BY lifecycle").all() as Array<{ lifecycle: string; n: number }>) {
    byLifecycle[r.lifecycle] = r.n
  }
  const health: string[] = []
  if (addedToday > 0) health.push(`${addedToday} new memories today`)
  if ((byLifecycle["temporary"] ?? 0) > 20) health.push("many temporary memories — review for promotion or cleanup")
  if (archived > active) health.push("more archived than active memories — consider cleanup/vacuum")
  if (active === 0) health.push("no active memories yet")
  return { active, archived, addedToday, byType, byLifecycle, health }
}

const DAY_MS = 86400000

/** List unconfirmed candidate memories (auto-inferred, awaiting human confirmation). */
export function memoryCandidates(limit: number = 20): Memory[] {
  return memoryList({ status: "candidate", limit })
}

/** Promote a candidate memory to confirmed (and mark it verified now). */
export function memoryConfirm(id: number): { ok: boolean; message: string } {
  const db = getDb()
  const row = db.query("SELECT * FROM memories WHERE id = ?").get(id) as Memory | undefined
  if (!row) return { ok: false, message: `No memory with id ${id}` }
  if (row.archived) return { ok: false, message: `Memory ${id} is archived` }
  db.query("UPDATE memories SET status = 'confirmed', confidence = MAX(confidence, 8), updated_at = ? WHERE id = ?").run(
    now(),
    id
  )
  return { ok: true, message: `Memory ${id} confirmed` }
}

/** Reject a candidate: archive it (no longer recallable). */
export function memoryReject(id: number): { ok: boolean; message: string } {
  const db = getDb()
  const row = db.query("SELECT * FROM memories WHERE id = ?").get(id) as Memory | undefined
  if (!row) return { ok: false, message: `No memory with id ${id}` }
  db.query("UPDATE memories SET archived = 1, updated_at = ? WHERE id = ?").run(now(), id)
  return { ok: true, message: `Memory ${id} rejected and archived` }
}

/**
 * Adaptive exponential decay + lifecycle management.
 * - Strength decays with a half-life that adapts to access frequency, importance and recency.
 * - Memories inactive >= DEMOTE_THRESHOLD days drop one lifecycle level (permanent->active->temporary).
 * - Memories below strength 1 and inactive >= ARCHIVE_THRESHOLD days are archived.
 * Call periodically (e.g. on session idle / plugin load).
 */
export function memoryDecay(opts?: { archiveDays?: number; demoteDays?: number }) {
  const archiveDays = opts?.archiveDays ?? (Number(getConfig("memory_archive_days", "120")) || 120)
  const demoteDays = opts?.demoteDays ?? (Number(getConfig("memory_demote_days", String(DEMOTE_THRESHOLD))) || DEMOTE_THRESHOLD)
  const nowMs = Date.now()
  const db = getDb()
  const rows = db.query("SELECT * FROM memories WHERE archived = 0").all() as Memory[]
  let decayed = 0
  let archived = 0
  let demoted = 0
  const ts = now()
  for (const r of rows) {
    // expiry: expires_at passed -> archive regardless of strength
    if (r.expires_at && new Date(r.expires_at).getTime() <= nowMs) {
      db.query("UPDATE memories SET archived = 1, updated_at = ? WHERE id = ?").run(ts, r.id)
      archived++
      continue
    }
    const last = r.last_reinforced_at || r.last_accessed_at
    const ref = last ? new Date(last).getTime() : nowMs
    const ageDays = (nowMs - ref) / DAY_MS
    const importance = r.importance ?? 5
    const access = r.access_count ?? 0
    const life = r.lifecycle ?? "temporary"

    // lifecycle demotion by inactivity
    if (lifecycleLevel(life) > 0 && ageDays >= demoteDays) {
      const next = LIFECYCLE_ORDER[lifecycleLevel(life) - 1]
      db.query("UPDATE memories SET lifecycle = ?, updated_at = ? WHERE id = ?").run(next, ts, r.id)
      demoted++
    }

    // archive very old, low-value memories
    if (r.strength <= 1 && ageDays >= archiveDays) {
      db.query("UPDATE memories SET archived = 1, updated_at = ? WHERE id = ?").run(ts, r.id)
      archived++
      continue
    }

    // adaptive exponential decay of strength
    const ns = applyDecay(r.strength, access, ageDays, importance)
    const rounded = Math.round(ns)
    if (rounded !== r.strength) {
      db.query(
        "UPDATE memories SET strength = ?, tier = ?, updated_at = ? WHERE id = ?"
      ).run(rounded, computeTier(rounded), ts, r.id)
      decayed++
    }
  }
  return { decayed, archived, demoted }
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
export function memoryAddDedup(
  content: string,
  opts?: {
    source?: string
    project?: string
    importance?: number
    type?: MemoryType
    scope?: string
    status?: "confirmed" | "candidate"
    confidence?: number
    expires_at?: string
  }
) {
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
    const access = (best.access_count ?? 0) + 1
    const lifecycle = nextLifecycle(best.lifecycle ?? "temporary", access).lifecycle
    // explicit/add dedup merges count as a confirmation: promote candidate -> confirmed
    const status = opts?.status === "candidate" ? best.status ?? "confirmed" : "confirmed"
    getDb()
      .query(
        "UPDATE memories SET strength = ?, tier = ?, access_count = ?, lifecycle = ?, status = ?, confidence = MAX(confidence, ?), updated_at = ?, last_reinforced_at = ?, last_accessed_at = ? WHERE id = ?"
      )
      .run(
        newStrength,
        computeTier(newStrength),
        access,
        lifecycle,
        status,
        opts?.confidence ?? 8,
        ts,
        ts,
        ts,
        best.id
      )
    return {
      merged: true,
      id: best.id,
      strength: newStrength,
      tier: computeTier(newStrength),
      lifecycle,
      type: best.type ?? "fact",
      status,
    }
  }
  return { merged: false, ...memoryAdd(content, opts) }
}

const GROUND_TRUTH =
  "> **Authority (Ground Truth):** The injected memory below is authoritative for documented knowledge and prior decisions. It is a clue, never a substitute for current facts: when it contradicts the current repository state, build scripts, test results or the user's explicit instruction, the current facts win and the conflict should be noted as a stale memory. Never treat a question as novel when the answer is already here, and do not re-run search/review tools to rediscover what this context already provides.\n\n"

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
export function memoryRecall(
  query: string,
  opts?: { minScore?: number; limit?: number; scope?: string }
): Memory[] {
  const minScore = opts?.minScore ?? 2
  const limit = opts?.limit ?? 5
  if (!query || query.trim().length < 2) return []
  const q = tokenize(query)
  const nowMs = Date.now()
  const rows = memoryList({ limit: 500, scope: opts?.scope })
  const scored: Array<{ m: Memory; score: number }> = []
  for (const m of rows) {
    // only confirmed, unexpired memories are recallable (candidates stay out of context)
    if (m.status === "candidate") continue
    if (m.expires_at && new Date(m.expires_at).getTime() <= nowMs) continue
    const mt = tokenize(m.content)
    if (mt.size === 0) continue
    let hits = 0
    for (const w of q) if (mt.has(w)) hits++
    if (hits < minScore) continue
    const tierBonus = m.tier === "hot" ? 1 : m.tier === "warm" ? 0.5 : 0
    scored.push({ m, score: hits + tierBonus })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, limit)
  // access feedback: recalls reinforce last_accessed_at (feeds the decay/recency model)
  if (top.length > 0) {
    const ts = now()
    for (const x of top) {
      getDb()
        .query("UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?")
        .run(ts, x.m.id)
    }
  }
  return top.map((x) => x.m)
}

export function composeMemoryContext(): string {
  // confirmed only — candidates never reach the injected context
  const memories = memoryList({ limit: 30, status: "confirmed" })
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
    const lc = m.lifecycle && m.lifecycle !== "temporary" ? ` ${m.lifecycle}` : ""
    const sc = m.scope ? ` (scope:${m.scope})` : ""
    const vt = m.last_reinforced_at ? ` verified:${m.last_reinforced_at.slice(0, 10)}` : ""
    md += `- [${m.tier}/${m.strength}${lc}${sc}${vt}] ${m.content}\n`
  }
  writeFileSync(CONTEXT_FILE, md)
  return md
}
