import { writeFileSync } from "fs"
import { join } from "path"
import { getDb, getConfig, now, EVOLVE_HOME, stamp } from "./db"
import { scopeBoost } from "./workspace"

export const CONTEXT_FILE = join(EVOLVE_HOME, "memory.context.md")

export type Memory = {
  id: number
  uuid: string | null
  origin: string | null
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
  deleted: number
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
  const st = stamp()
  const info = db
    .query(
      "INSERT INTO memories (uuid, origin, content, source, project, strength, tier, importance, lifecycle, type, scope, status, confidence, expires_at, created_at, updated_at, last_reinforced_at, last_accessed_at, access_count, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'temporary', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)"
    )
    .run(
      st.uuid,
      st.origin,
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

/** Strengthen a memory by id (used by the recall-evidence feedback loop). */
export function strengthenById(id: number) {
  const db = getDb()
  const r = db.query("SELECT * FROM memories WHERE id = ? AND archived = 0").get(id) as Memory | undefined
  if (!r) return { ok: false, message: `No active memory with id ${id}` }
  const ts = now()
  const newStrength = r.strength + 1
  const access = (r.access_count ?? 0) + 1
  const nxt = nextLifecycle(r.lifecycle ?? "temporary", access)
  db.query(
    "UPDATE memories SET strength = ?, tier = ?, access_count = ?, lifecycle = ?, updated_at = ?, last_reinforced_at = ?, last_accessed_at = ? WHERE id = ?"
  ).run(newStrength, computeTier(newStrength), access, nxt.lifecycle, ts, ts, ts, id)
  return { ok: true, id, strength: newStrength, promoted: nxt.promoted }
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
    db.query("UPDATE memories SET archived = 1, deleted = 1, updated_at = ? WHERE id = ?").run(now(), r.id)
  }
  return { archived: rows.length, ids: rows.map((r) => r.id) }
}

/** Edit a memory by id: content, scope, importance, confidence, status, lifecycle. */
export function memoryUpdateById(
  id: number,
  patch: {
    content?: string
    scope?: string | null
    importance?: number
    confidence?: number
    status?: "confirmed" | "candidate"
    lifecycle?: Lifecycle
  }
): { ok: boolean; message?: string; memory?: Memory } {
  const db = getDb()
  const r = db.query("SELECT * FROM memories WHERE id = ?").get(id) as Memory | undefined
  if (!r) return { ok: false, message: `No memory with id ${id}` }
  if (patch.content !== undefined) {
    const blocked = isBlockedMemoryContent(patch.content)
    if (blocked.blocked) return { ok: false, message: `Rejected: ${blocked.reason}` }
  }
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.content !== undefined && patch.content !== r.content) {
    sets.push("content = ?")
    params.push(patch.content)
  }
  if (patch.scope !== undefined) {
    sets.push("scope = ?")
    params.push(patch.scope || null)
  }
  if (patch.importance !== undefined) {
    sets.push("importance = ?")
    params.push(patch.importance)
  }
  if (patch.confidence !== undefined) {
    sets.push("confidence = ?")
    params.push(patch.confidence)
  }
  if (patch.status !== undefined) {
    sets.push("status = ?")
    params.push(patch.status)
  }
  if (patch.lifecycle !== undefined) {
    sets.push("lifecycle = ?")
    params.push(patch.lifecycle)
  }
  if (sets.length === 0) {
    return { ok: false, message: "Nothing to update" }
  }
  sets.push("updated_at = ?")
  params.push(now())
  db.query(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...params, id)
  return { ok: true, memory: db.query("SELECT * FROM memories WHERE id = ?").get(id) as Memory }
}

/** Archive(soft-delete) a single memory by id. */
export function memoryArchiveById(id: number): { ok: boolean; message?: string } {
  const db = getDb()
  const r = db.query("SELECT * FROM memories WHERE id = ?").get(id) as Memory | undefined
  if (!r) return { ok: false, message: `No memory with id ${id}` }
  db.query("UPDATE memories SET archived = 1, deleted = 1, updated_at = ? WHERE id = ?").run(now(), id)
  return { ok: true }
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
  db.query("UPDATE memories SET archived = 1, deleted = 1, updated_at = ? WHERE id = ?").run(now(), id)
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

/**
 * Feature 2 — informative write gate (Metis GDN analog).
 *
 * Metis only lets informative hidden states update memory. selfforge mirrors
 * that by measuring how much NEW information a prospective memory adds over
 * the existing confirmed store. `memoryNovelty` returns the fraction of the
 * candidate's tokens that are NOT already covered by the best single existing
 * memory (token coverage, not mere similarity). A write whose novelty is
 * below `memory_novelty_gate` is rejected as redundant rather than stored.
 */
export function memoryNovelty(content: string): { novelty: number; coverage: number; covered_by: { id: number; content: string } | null } {
  const rows = getDb().query("SELECT * FROM memories WHERE archived = 0 AND status = 'confirmed'").all() as Memory[]
  const c = tokenize(content)
  if (c.size === 0) return { novelty: 0, coverage: 1, covered_by: null }
  let bestCov = 0
  let best: { id: number; content: string } | null = null
  for (const r of rows) {
    const rt = tokenize(r.content)
    if (rt.size === 0) continue
    let cov = 0
    for (const w of c) if (rt.has(w)) cov++
    const covRatio = cov / c.size
    if (covRatio > bestCov) {
      bestCov = covRatio
      best = { id: r.id, content: r.content }
    }
  }
  return { novelty: 1 - bestCov, coverage: bestCov, covered_by: best }
}

/** Feature 2 config: minimum fraction of NEW tokens a write must contribute. */
export function noveltyGate(): number {
  const g = Number(getConfig("memory_novelty_gate", "0.35"))
  return Math.max(0, Math.min(1, g))
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
    /** Feature 2: enforce the informative-novelty gate before inserting (default true). */
    gate?: boolean
  }
) {
  const rows = getDb().query("SELECT * FROM memories WHERE archived = 0").all() as Memory[]

  // Feature 2 — informative write gate: a confirmed write that adds too little
  // novel token content over the existing confirmed store is redundant. Checked
  // BEFORE dedup so exact re-writes are caught too (candidates are exempt).
  const gateEnabled = opts?.gate !== false
  if (gateEnabled && opts?.status !== "candidate") {
    const nv = memoryNovelty(content)
    const gate = noveltyGate()
    if (nv.novelty < gate && nv.covered_by) {
      return {
        merged: false,
        blocked: true,
        gated: true,
        reason: `redundant (novelty ${nv.novelty.toFixed(2)} < gate ${gate.toFixed(2)}; covered by memory #${nv.covered_by.id})`,
        id: 0,
        covered_by: nv.covered_by.id,
        novelty: nv.novelty,
      }
    }
  }

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
 * Feature 3 — recall evidence loop (Metis "learned utilization" analog).
 *
 * Metis learns storage/utilization from data instead of handcrafted rules.
 * selfforge stays zero-LLM but closes the loop with per-word evidence:
 * every recall increments `hits` for each (query word, recalled memory)
 * pair; explicit useful/not-useful feedback (`recallFeedback`) adjusts
 * `positives`/`negatives`. The score bonus below is the empirical
 * precision of a word for a memory: (positives - negatives) / hits.
 */

export type RecallEvidence = {
  id: number
  word: string
  memory_id: number
  hits: number
  positives: number
  negatives: number
  updated_at: string | null
  deleted: number
}

/** Record that `word` led to `memoryId` being recalled (hit incremented). */
export function recordRecallHit(word: string, memoryId: number) {
  try {
    const db = getDb()
    const ts = now()
    db.query(
      `INSERT INTO recall_evidence (word, memory_id, hits, positives, negatives, updated_at, deleted)
       VALUES (?, ?, 1, 0, 0, ?, 0)
       ON CONFLICT(word, memory_id) DO UPDATE SET hits = hits + 1, updated_at = excluded.updated_at`
    ).run(word.toLowerCase(), memoryId, ts)
  } catch {}
}

/** Record explicit user feedback about a recalled memory (word-level precision). */
export function recallFeedback(memoryId: number, useful: boolean): { ok: boolean; matched: number; message: string } {
  const db = getDb()
  const rows = db
    .query("SELECT * FROM recall_evidence WHERE memory_id = ? AND deleted = 0")
    .all(memoryId) as RecallEvidence[]
  if (rows.length === 0) return { ok: false, matched: 0, message: `No recall evidence recorded for memory #${memoryId}` }
  const ts = now()
  const col = useful ? "positives" : "negatives"
  for (const r of rows) {
    db.query(`UPDATE recall_evidence SET ${col} = ${col} + 1, updated_at = ? WHERE id = ?`).run(ts, r.id)
  }
  // feedback also feeds the memory decay model directly (reinforce/weaken)
  if (useful) strengthenById(memoryId)
  return { ok: true, matched: rows.length, message: `Recorded ${useful ? "positive" : "negative"} feedback for memory #${memoryId} (${rows.length} words)` }
}

/** Empirical precision bonus for a (word, memory) pair: (pos-neg)/hits in [-1, 1]. */
function evidenceWeight(row: RecallEvidence | undefined): number {
  if (!row || row.hits <= 0) return 0
  return Math.max(-1, Math.min(1, (row.positives - row.negatives) / row.hits))
}

/**
 * Lightweight relevance recall: score memories against a query by keyword
 * overlap (token intersection, weighted by strength + evidence feedback).
 * Used for surgical injection rather than dumping the whole store.
 * Threshold-guarded.
 */
export function memoryRecall(
  query: string,
  opts?: { minScore?: number; limit?: number; scope?: string; wsScope?: string; evidence?: boolean }
): Memory[] {
  const minScore = opts?.minScore ?? 2
  const limit = opts?.limit ?? 5
  const wsBoost = opts?.wsScope ? 1 : 0
  const useEvidence = opts?.evidence !== false
  if (!query || query.trim().length < 2) return []
  const q = tokenize(query)
  const nowMs = Date.now()
  const rows = memoryList({ limit: 500, scope: opts?.scope })
  const scored: Array<{ m: Memory; score: number; hits: number }> = []
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
    const boost = wsBoost ? scopeBoost(opts.wsScope!, m) : 0
    scored.push({ m, score: hits + tierBonus + boost, hits })
  }
  if (useEvidence && scored.length > 0) {
    // one batched evidence lookup per candidate memory
    const ids = scored.map((s) => s.m.id)
    const evidence = new Map<number, RecallEvidence[]>()
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200).join(",")
      const rowsEv = getDb()
        .query(`SELECT * FROM recall_evidence WHERE memory_id IN (${chunk}) AND deleted = 0`)
        .all() as RecallEvidence[]
      for (const r of rowsEv) {
        const list = evidence.get(r.memory_id) ?? []
        list.push(r)
        evidence.set(r.memory_id, list)
      }
    }
    const byWord = new Map<number, Map<string, RecallEvidence>>()
    for (const [mid, list] of evidence) {
      const m = new Map<string, RecallEvidence>()
      for (const r of list) m.set(r.word, r)
      byWord.set(mid, m)
    }
    for (const s of scored) {
      const wm = byWord.get(s.m.id)
      if (!wm) continue
      let evSum = 0
      for (const w of q) {
        const row = wm.get(w)
        if (row) evSum += evidenceWeight(row)
      }
      s.score += evSum
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, limit)
  // access feedback: recalls reinforce last_accessed_at (feeds the decay/recency model)
  // + record per-word hit evidence for the feature-3 loop
  if (top.length > 0) {
    const ts = now()
    for (const x of top) {
      getDb()
        .query("UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?")
        .run(ts, x.m.id)
      for (const w of q) recordRecallHit(w, x.m.id)
    }
  }
  return top.map((x) => x.m)
}

/**
 * Feature 4 — tiered injection fusion (Metis "memory attention" analog).
 *
 * Metis fuses the memory read with the original attention branch. selfforge
 * fuses memory into the system context in priority tiers: current workspace
 * -> related scoped -> general. Workspace-relevant lessons rank first (more
 * get injected), then scoped lessons, then general ones — so the most
 * situational signal is closest to the querying head.
 */
export function composeMemoryContext(opts?: { wsScope?: string; limit?: number; includeSession?: string }): string {
  const limit = opts?.limit ?? 30
  const wsCap = Math.min(10, Math.max(4, Math.round(limit * 0.4)))
  const scopedCap = Math.min(8, Math.max(3, Math.round(limit * 0.25)))
  const generalCap = limit - wsCap - scopedCap

  const all = memoryList({ limit: 200, status: "confirmed" })
  const profile = getDb()
    .query("SELECT keyword, content FROM user_profile ORDER BY created_at DESC LIMIT 20")
    .all() as { keyword: string; content: string }[]

  // tier assignment: current workspace match first, then any scoped, then general
  const ws: Memory[] = []
  const scoped: Memory[] = []
  const general: Memory[] = []
  for (const m of all) {
    if (opts?.wsScope && scopeBoost(opts.wsScope, m) > 0) ws.push(m)
    else if (m.scope) scoped.push(m)
    else general.push(m)
  }
  const sortByStrength = (a: Memory, b: Memory) =>
    b.strength - a.strength || (b.last_reinforced_at || "").localeCompare(a.last_reinforced_at || "")
  ws.sort(sortByStrength)
  scoped.sort(sortByStrength)
  general.sort(sortByStrength)

  const wsTop = ws.slice(0, wsCap)
  const scopedTop = scoped.slice(0, scopedCap)
  const generalTop = general.slice(0, generalCap)

  let md = "# Evolve Memory\n\n<!-- Managed by unified-evolver. Do not edit manually. -->\n\n"
  md += GROUND_TRUTH
  if (profile.length > 0) {
    md += "## User Profile\n\n"
    for (const p of profile) md += `- **${p.keyword}**: ${p.content}\n`
    md += "\n"
  }

  const lines = (memories: Memory[]): string =>
    memories
      .map((m) => {
        const lc = m.lifecycle && m.lifecycle !== "temporary" ? ` ${m.lifecycle}` : ""
        const sc = m.scope ? ` (scope:${m.scope})` : ""
        const vt = m.last_reinforced_at ? ` verified:${m.last_reinforced_at.slice(0, 10)}` : ""
        return `- [${m.tier}/${m.strength}${lc}${sc}${vt}] ${m.content}`
      })
      .join("\n")

  const sections: string[] = []
  if (wsTop.length > 0) sections.push(`## Current Workspace\n\n${lines(wsTop)}`)
  if (scopedTop.length > 0) sections.push(`## Scoped Lessons\n\n${lines(scopedTop)}`)
  if (generalTop.length > 0) sections.push(`## General Lessons\n\n${lines(generalTop)}`)

  if (sections.length === 0) {
    md += "_No persistent memories yet._\n"
  } else {
    md += sections.join("\n\n") + "\n"
  }

  // Feature 1 — fixed-size session state fusion: distilled digest, not raw replay.
  if (opts?.includeSession) {
    try {
      const { renderSessionState } = require("./summary")
      const state = renderSessionState(opts.includeSession)
      if (state) md += "\n" + state
    } catch {}
  }

  writeFileSync(CONTEXT_FILE, md)
  return md
}
