import { createHash } from "crypto"
import { getDb, getConfig, now, stamp } from "./db"
import type { MemoryType } from "./memory"
import { memoryAddDedup } from "./memory"

/**
 * Pattern signature candidate pool (ported from MemOS `core/memory/l2`),
 * adapted to selfforge's zero-LLM style.
 *
 * A "pattern" is the distinctive fingerprint of a recurring sub-problem:
 *
 *   sig = <primaryTag> "|" <secondaryTag> "|" <tool> "|" <errCode>
 *
 * All four slots are deterministic string extractions (no LLM, no
 * embedding). The signature is hashed to 16-hex as the candidate-bucket
 * key (`signatureHash`). `_` fills empty slots.
 *
 * We only *induce* (promote to a memory/repair) once a bucket holds
 * >= `minEpisodesForInduction` **distinct episodes** — never from a
 * single episode. Buckets that never reach quorum expire via TTL.
 */

export type PatternCandidate = {
  sig: string
  sig_hash: string
  sig_label: string
  tool: string | null
  err_code: string | null
  context: string | null
  episodes: number
  total: number
  latest_at: string
}

export function patternConfig() {
  return {
    minEpisodesForInduction: Number(getConfig("pattern_min_episodes", "2")) || 2,
    candidateTtlDays: Number(getConfig("pattern_ttl_days", "30")) || 30,
  }
}

/** Build the readable signature label (padded slots filled with `_`). */
export function signatureLabel(tool?: string, errCode?: string, context?: string): string {
  const primary = (errCode && errCode.trim()) || (tool && tool.trim()) || "_"
  const secondary = (context && context.split(/[\\/:]/).pop()) || "_"
  return `${primary}|${secondary}|${tool?.trim() || "_"}|${errCode?.trim() || "_"}`
}

/** 16-hex hash of a signature — the candidate-pool bucket key. */
export function signatureHash(sig: string): string {
  return createHash("sha1").update(sig).digest("hex").slice(0, 16)
}

/**
 * Record a recurrence. episodeKey identifies the episode (e.g. a session
 * or a date-bucket); distinct episodes count toward induction.
 */
export function recordPattern(
  tool: string,
  errCode?: string,
  context?: string,
  episodeKey?: string
): { sig_hash: string; sig_label: string } {
  const label = signatureLabel(tool, errCode, context)
  const hash = signatureHash(label)
  const db = getDb()
  // refresh TTL: delete any older row for the same (sig_hash, episode), then insert
  db.query("DELETE FROM pattern_signatures WHERE sig_hash = ? AND episode_key = ?").run(hash, episodeKey ?? null)
  const st = stamp()
  db.query(
    "INSERT INTO pattern_signatures (uuid, origin, sig, sig_hash, sig_label, tool, err_code, context, episode_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(st.uuid, st.origin, label, hash, label, tool ?? null, errCode ?? null, context ?? null, episodeKey ?? null, now())
  return { sig_hash: hash, sig_label: label }
}

/** Buckets that have reached quorum (>= N distinct episodes). */
export function patternCandidates(): PatternCandidate[] {
  const cfg = patternConfig()
  const rows = getDb()
    .query(
      `SELECT sig_hash, sig_label, tool, err_code, context,
              COUNT(DISTINCT episode_key) AS episodes,
              COUNT(*) AS total,
              MAX(created_at) AS latest_at
       FROM pattern_signatures
       WHERE deleted = 0
       GROUP BY sig_hash
       HAVING episodes >= ?
       ORDER BY episodes DESC, latest_at DESC`
    )
    .all(cfg.minEpisodesForInduction) as Array<{
    sig_hash: string
    sig_label: string
    tool: string | null
    err_code: string | null
    context: string | null
    episodes: number
    total: number
    latest_at: string
  }>
  return rows as PatternCandidate[]
}

/** Expire buckets / rows older than the TTL (silent drop-out). */
export function prunePatterns(): { removed: number } {
  const cfg = patternConfig()
  const cutoff = new Date(Date.now() - cfg.candidateTtlDays * 86400000).toISOString()
  const info = getDb()
    .query("UPDATE pattern_signatures SET deleted = 1 WHERE deleted = 0 AND created_at < ?")
    .run(cutoff)
  return { removed: Number(info.changes) }
}

/**
 * Induce mature buckets into the memory store as candidate memories —
 * the zero-LLM "distill a recurring pattern into durable knowledge" step.
 * Returns what was promoted.
 */
export function inducePatterns(opts?: { type?: MemoryType }): {
  promoted: Array<{ sig_hash: string; sig_label: string; memoryId: number }>
  skipped: number
} {
  const cands = patternCandidates()
  const promoted: Array<{ sig_hash: string; sig_label: string; memoryId: number }> = []
  let skipped = 0
  for (const c of cands) {
    const lesson = patternLesson(c)
    // dedup-aware add: near-duplicate merges instead of inserting
    const res = memoryAddDedup(lesson, {
      source: "pattern",
      type: opts?.type ?? (c.err_code ? "instruction" : "insight"),
      status: "candidate",
      confidence: 5,
    })
    if (res.merged || res.id > 0) {
      promoted.push({ sig_hash: c.sig_hash, sig_label: c.sig_label, memoryId: res.id })
      // mark bucket rows promoted so they stop re-inducing
      getDb().query("UPDATE pattern_signatures SET deleted = 1 WHERE sig_hash = ?").run(c.sig_hash)
    } else {
      skipped++
    }
  }
  return { promoted, skipped }
}

/** Human-readable lesson text for a mature pattern bucket. */
export function patternLesson(c: PatternCandidate): string {
  const where = c.context ? ` in ${c.context}` : ""
  const code = c.err_code ? ` (${c.err_code})` : ""
  return `Pattern in ${c.tool || "tools"}${where}${code} has recurred across ${c.episodes} episodes — treat it as a known failure mode and avoid repeating the same failing approach.`
}

export function patternStatus() {
  const db = getDb()
  const total = (
    db.query("SELECT COUNT(*) AS n FROM pattern_signatures WHERE deleted = 0").get() as { n: number }
  ).n
  const cfg = patternConfig()
  return {
    total_signatures: total,
    min_episodes_for_induction: cfg.minEpisodesForInduction,
    ttl_days: cfg.candidateTtlDays,
    ready: patternCandidates().map((c) => ({
      sig: c.sig_label,
      tool: c.tool,
      err_code: c.err_code,
      episodes: c.episodes,
    })),
  }
}