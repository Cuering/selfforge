import { getDb, getConfig, now } from "./db"
import { isTrivial, truncate } from "./review"

/**
 * Feature 1 — fixed-size session state (MemTensor Metis analog).
 *
 * Metis compresses an interaction history into a compact native state so a
 * later query does not need to replay the original text. selfforge mirrors
 * that with `session_summaries`: after a conversation is distilled (or on
 * demand), the session's key user directives, decisions and open items are
 * reduced to a bounded digest that can be injected instead of replaying raw
 * transcript. Zero-LLM: facts are selected by declarative/preference signal
 * heuristics, truncated, deduped and capped.
 */

export type SessionSummaryRow = {
  id: number
  session_id: string
  summary: string
  fact_count: number
  covered_until_turn: number
  created_at: string
  updated_at: string
}

/** Declarative/preference signals that mark a sentence as a durable directive. */
const FACT_SIGNALS = [
  /\bi (?:want|prefer|need|like|use|always|never|should|would|tend|decide|decided|want to)\b/i,
  /\bwe (?:use|should|don't|do not|always|never|prefer|stick to|will use|deploy|ship|build|run|install)\b/i,
  /\b(?:prefer|preferred|usually|instead of|rather than|as a rule|remember|remember that|note that|important)\b/i,
  /(?:决定|偏好|喜欢|不喜欢|不要|应该|必须|记住|习惯|以后|采用|用|优先|避免)/,
  /\b(?:requirement|constraint|convention|standard|must|always|never)\b/i,
]

function sentenceSplit(text: string): string[] {
  return (text || "")
    .replace(/\r/g, "")
    .split(/(?<=[。！？.!?;；])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Extract durable directive sentences from a single message. */
export function extractFacts(content: string): string[] {
  const out: string[] = []
  for (const s of sentenceSplit(content)) {
    if (s.length < 8 || s.length > 200) continue
    if (isTrivial(s)) continue
    if (FACT_SIGNALS.some((re) => re.test(s))) {
      out.push(truncate(s, 160))
      if (out.length >= 8) break
    }
  }
  return out
}

/** Dedupe near-identical facts (normalized lowercase). */
function dedupeFacts(facts: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const f of facts) {
    const key = f.toLowerCase().replace(/\s+/g, " ").trim()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}

/** Cap summary output so injected state is bounded (Metis fixed-size state). */
function capSummary(facts: string[]): { summary: string; fact_count: number } {
  const maxFacts = Number(getConfig("session_summary_max_facts", "10")) || 10
  const maxLen = Number(getConfig("session_summary_max_chars", "1200")) || 1200
  const capped = facts.slice(0, maxFacts)
  let text = ""
  for (let i = 0; i < capped.length; i++) {
    const line = `${i + 1}. ${capped[i]}`
    if (text.length + line.length + 1 > maxLen) break
    text += (text ? "\n" : "") + line
  }
  return { summary: text, fact_count: capped.length }
}

/**
 * Distill a session's buffered messages into a compact summary and upsert it.
 * `coveredUntilTurn` records how far the digest has consumed, so later calls
 * can rebuild incrementally.
 */
export function summarizeSession(
  sessionId: string,
  messages: Array<{ role: string; content: string }>,
  coveredUntilTurn?: number
): SessionSummaryRow {
  const facts: string[] = []
  for (const msg of messages) {
    if (msg.role !== "user") continue
    if (isTrivial(msg.content)) continue
    facts.push(...extractFacts(msg.content))
  }
  const uniq = dedupeFacts(facts)
  const { summary, fact_count } = capSummary(uniq)
  const ts = now()
  const db = getDb()
  const existing = getSessionSummary(sessionId)
  const turn = coveredUntilTurn ?? existing?.covered_until_turn ?? 0
  if (existing) {
    db.query(
      "UPDATE session_summaries SET summary = ?, fact_count = ?, covered_until_turn = ?, updated_at = ? WHERE session_id = ?"
    ).run(summary, fact_count, turn, ts, sessionId)
  } else {
    db.query(
      "INSERT INTO session_summaries (session_id, summary, fact_count, covered_until_turn, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(sessionId, summary, fact_count, turn, ts, ts)
  }
  return getSessionSummary(sessionId) as SessionSummaryRow
}

export function getSessionSummary(sessionId: string): SessionSummaryRow | null {
  return (getDb().query("SELECT * FROM session_summaries WHERE session_id = ?").get(sessionId) as SessionSummaryRow | undefined) ?? null
}

export function sessionSummaryList(opts?: { limit?: number }): SessionSummaryRow[] {
  return getDb()
    .query("SELECT * FROM session_summaries ORDER BY updated_at DESC LIMIT ?")
    .all(opts?.limit ?? 20) as SessionSummaryRow[]
}

/** Render a session summary as an injectable compact state block. */
export function renderSessionState(sessionId: string): string | null {
  const s = getSessionSummary(sessionId)
  if (!s || !s.summary) return null
  return `## Session State\n\n<!-- fixed-size session summary (distilled, not a transcript replay) -->\n${s.summary}\n`
}

/** Aggregate session summaries by calendar day (UTC), newest first. */
export function dailySummaries(opts?: { limit?: number }): Array<{
  day: string
  session_count: number
  fact_count: number
  facts: string[]
}> {
  const rows = sessionSummaryList({ limit: 500 })
  const byDay = new Map<string, { sessions: Set<string>; facts: string[] }>()
  for (const s of rows) {
    const day = (s.updated_at || "").slice(0, 10)
    if (!day) continue
    let bucket = byDay.get(day)
    if (!bucket) {
      bucket = { sessions: new Set(), facts: [] }
      byDay.set(day, bucket)
    }
    bucket.sessions.add(s.session_id)
    for (const line of (s.summary || "").split("\n")) {
      const fact = line.replace(/^\d+\.\s*/, "").trim()
      if (fact) bucket.facts.push(fact)
    }
  }
  const out: Array<{ day: string; session_count: number; fact_count: number; facts: string[] }> = []
  for (const [day, b] of byDay.entries()) {
    const facts = [...new Set(b.facts)]
    out.push({ day, session_count: b.sessions.size, fact_count: facts.length, facts: facts.slice(0, 20) })
  }
  out.sort((a, b) => (a.day < b.day ? 1 : -1))
  return out.slice(0, opts?.limit ?? 14)
}
