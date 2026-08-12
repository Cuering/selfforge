import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { getDb, now, logObs, EVOLVE_HOME, REVIEWS_DIR, getConfig } from "./db"
import { skillList } from "./skills"

const SECRET_RE =
  /(api[_-]?key|token|secret|password|authorization|credentials?|auth)(["\s:=]+)([A-Za-z]+\s+)?([A-Za-z0-9_\-/.+=]{8,})/gi

export function redact(str: string): string {
  if (!str) return str
  return str.replace(SECRET_RE, "$1$2$3[REDACTED]")
}

export function truncate(text: string, maxLen: number): string {
  if (!text || text.length <= maxLen) return text || ""
  return text.slice(0, maxLen - 3) + "..."
}

const SOCIAL_CLOSERSET =
  /^(thanks|thank you|ty|thx|ok|okay|kk|k|sure|got it|ga|sounds good|nice|great|good|done|fine|👍|🙏|✅|perfect|yeah|yep|yes|no|lol|hmm|huh|right|sabe|helped|useful|interesting|cool|coolok|understood|copy|roger|acknowledged|fine by me|saw it|tired|certo)$/i

/**
 * Heuristic social-closer filter. Returns true for trivial messages that should
 * not be buffered for review: bare greetings/closers, ultra-short acknowledg-
 * ments, or content without substantive tokens.
 */
export function isTrivial(content: string | undefined | null): boolean {
  const t = (content || "").trim()
  if (!t) return true
  // pure punctuation / emoji-only
  if (/^[\p{P}\p{S}\s]+$/u.test(t)) return true
  // single-word closer
  if (t.length <= 12 && SOCIAL_CLOSERSET.test(t)) return true
  // very short with no real content (e.g. "1." formatting junk)
  if (t.length < 5 && !/[a-z]{3}/i.test(t)) return true
  return false
}

export function formatReview(messages: Array<{ role: string; content: string }>, project: string): string {
  let md = "# Autolearn Review\n\n"
  md += "## Context\n\n"
  md += `- Project: ${project}\n`
  md += `- Date: ${new Date().toISOString()}\n`
  md += `- Messages: ${messages.length}\n`
  md += `- Trigger: unified-evolver\n\n`
md += "## Instructions\n\n"
  md += 'Review the conversation below for learning opportunities.\nLoad the selfforge skill with: skill({ name: "selfforge" })\n\n'
  md += "Use the provided tools to take action:\n\n"
  md += "1. `memory_add` - record general rules, corrections, preferences (not narrow instances)\n"
  md += "2. `user_add` - record communication/workflow preferences\n"
  md += "3. `rule_observe` - capture behavioral rules for AGENTS.md escalation\n"
  md += "4. `skill_create` / `skill_patch` - distill reusable techniques into skills\n"
  md += "5. `goal_*` - track ongoing goal progress\n\n"
  md += "IMPORTANT: Preferences are not always corrections. Capture declarative specs (\"should be\", \"we use\", \"we don't\", \"I want\") even when no error occurred.\n\n"
  md += "## Conversation\n\n"
  for (const msg of messages) {
    const label = msg.role === "user" ? "User" : "Assistant"
    md += `### ${label}\n\n${msg.content}\n\n`
  }
  md += "---\n\nTake action now.\n"
  return md
}

export function spawnReview(
  messages: Array<{ role: string; content: string }>,
  project: string,
  wrapper: string
) {
  try {
    const reviewMd = formatReview(messages, project)
    const file = join(REVIEWS_DIR, `review-${Date.now()}.md`)
    mkdirSync(REVIEWS_DIR, { recursive: true })
    writeFileSync(file, reviewMd)
    logObs("review_spawned", { file, mode: "cli" }, project)
    const args = [reviewMd, "--agent", "evolve-reviewer", "--title", "evolve review"]
    const { spawn } = require("node:child_process")
    const child = spawn(wrapper, args, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, EVOLVE_REVIEWER: "1" },
    })
    child.unref()
    return { spawned: true, file }
  } catch (err) {
    const fallback = join(EVOLVE_HOME, `review-failed-${Date.now()}.md`)
    try {
      writeFileSync(fallback, formatReview(messages, project))
    } catch {}
    return { spawned: false, error: (err as Error).message, fallback }
  }
}

/**
 * Spawn a review sub-session inside the running opencode server, using the
 * evolve-reviewer agent. This is the desktop-friendly path: no external CLI
 * binary is needed (the npm opencode CLI may be missing/broken), and the review
 * agent runs as a normal child session that can use the selfforge tools.
 *
 * `onSession` is invoked with the created review session id so the caller can
 * mark it and skip re-triggering review on its own messages.
 */
export async function spawnReviewSdk(
  client: any,
  messages: Array<{ role: string; content: string }>,
  project: string,
  onSession?: (sessionId: string) => void
): Promise<{ spawned: boolean; file?: string; session?: string; error?: string; fallback?: string }> {
  try {
    const reviewMd = formatReview(messages, project)
    const file = join(REVIEWS_DIR, `review-${Date.now()}.md`)
    mkdirSync(REVIEWS_DIR, { recursive: true })
    writeFileSync(file, reviewMd)
    logObs("review_spawned", { file, mode: "sdk" }, project)
    if (!client?.session?.create || !client?.session?.promptAsync) {
      throw new Error("SDK session API unavailable")
    }
    const session = await client.session.create({ body: { title: "evolve review" } })
    // SDK client wraps responses as { data, request, response }; the plugin may
    // pass either the raw session or the wrapped result, so accept both.
    const sid: string | undefined =
      session?.id ?? session?.data?.id ?? (session && typeof session === "object" ? (session as any).result?.id : undefined)
    if (!sid) throw new Error(`no session id returned (${JSON.stringify(session).slice(0, 200)})`)
    if (onSession) onSession(sid)
    await client.session.promptAsync({
      path: { id: sid },
      body: {
        agent: "evolve-reviewer",
        parts: [{ type: "text", text: reviewMd }],
      },
    })
    return { spawned: true, file, session: sid }
  } catch (err) {
    const fallback = join(EVOLVE_HOME, `review-failed-${Date.now()}.md`)
    try {
      writeFileSync(fallback, formatReview(messages, project))
    } catch {}
    return { spawned: false, error: (err as Error).message, fallback }
  }
}

export type Session = {
  id: string
  project: string | null
  turn_count: number
  last_review_turn: number
  last_idle_review: number
  buffer: string
  created_at: string
  updated_at: string
}

export function getSession(id: string): Session {
  const db = getDb()
  let s = db.query("SELECT * FROM sessions WHERE id = ?").get(id) as Session | undefined
  if (!s) {
    const ts = now()
    db.query(
      "INSERT INTO sessions (id, turn_count, last_review_turn, last_idle_review, buffer, created_at, updated_at) VALUES (?, 0, 0, 0, '[]', ?, ?)"
    ).run(id, ts, ts)
    s = db.query("SELECT * FROM sessions WHERE id = ?").get(id) as Session
  }
  return s
}

export function sessionSet(id: string, patch: Partial<Session>) {
  const s = getSession(id)
  const merged = { ...s, ...patch, updated_at: now() }
  getDb()
    .query(
      "UPDATE sessions SET turn_count = ?, last_review_turn = ?, last_idle_review = ?, buffer = ?, project = ?, updated_at = ? WHERE id = ?"
    )
    .run(
      merged.turn_count,
      merged.last_review_turn,
      merged.last_idle_review,
      merged.buffer,
      merged.project ?? null,
      merged.updated_at,
      id
    )
  return merged
}

export function bufferPush(session: Session, msg: { role: string; content: string }) {
  const buf = JSON.parse(session.buffer || "[]") as Array<{ role: string; content: string }>
  buf.push(msg)
  const max = Number(getConfig("max_conversation_buffer", "50"))
  while (buf.length > max) buf.shift()
  // Mirror into session_messages + FTS5 index for full-text search.
  try {
    const ts = now()
    const info = getDb()
      .query(
        "INSERT INTO session_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(session.id, msg.role, msg.content, ts)
    const rowid = Number(info.lastInsertRowid)
    getDb().query("INSERT INTO session_messages_fts (rowid, content) VALUES (?, ?)").run(rowid, msg.content)
  } catch {}
  return buf
}

export type SessionHit = {
  session_id: string
  role: string
  content: string
  created_at: string
  project: string | null
}

export function sessionSearch(query: string, opts?: { limit?: number }): SessionHit[] {
  const limit = opts?.limit ?? 8
  if (!query || !query.trim()) return []
  const q = query.trim()
  const db = getDb()
  // Prefer FTS5; fall back to LIKE when FTS returns nothing (e.g. empty index).
  try {
    const fts = db
      .query(
        `SELECT sm.session_id, sm.role, sm.content, sm.created_at, s.project
         FROM session_messages_fts f
         JOIN session_messages sm ON sm.id = f.rowid
         LEFT JOIN sessions s ON s.id = sm.session_id
         WHERE session_messages_fts MATCH ?
         ORDER BY f.rank ASC
         LIMIT ?`
      )
      .all(safeFtsQuery(q), limit) as unknown as SessionHit[]
    if (fts.length > 0) return fts.map(fmtHit)
  } catch {}
  try {
    const like = db
      .query(
        `SELECT sm.session_id, sm.role, sm.content, sm.created_at, s.project
         FROM session_messages sm
         LEFT JOIN sessions s ON s.id = sm.session_id
         WHERE sm.content LIKE ?
         ORDER BY sm.id DESC
         LIMIT ?`
      )
      .all(`%${q}%`, limit) as unknown as SessionHit[]
    return like.map(fmtHit)
  } catch {}
  return []
}

function fmtHit(h: any): SessionHit {
  return {
    session_id: h.session_id,
    role: h.role,
    content: h.content,
    created_at: h.created_at,
    project: h.project ?? null,
  }
}

/** Turn user text into a safe FTS5 MATCH expression (quoted phrase per token). */
function safeFtsQuery(q: string): string {
  const cleaned = q.replace(/[^\p{L}\p{N}\s-]/gu, "").trim()
  if (!cleaned) return '""'
  return cleaned
    .split(/\s+/)
    .map((t) => (t.length > 0 ? `"${t}"` : t))
    .join(" ")
}

export function curatorRun() {
  const db = getDb()
  const staleAfter = Number(getConfig("stale_after_days", "30")) * 86400000
  const archiveAfter = Number(getConfig("archive_after_days", "90")) * 86400000
  const nowMs = Date.now()
  const stats = { stale: 0, archived: 0 }
  for (const skill of skillList()) {
    if (skill.status !== "active") continue
    const lastUse = skill.last_used_at ? new Date(skill.last_used_at).getTime() : 0
    if (lastUse === 0) continue
    const age = nowMs - lastUse
    if (age > archiveAfter) {
      // lifecycle-aware archive: tombstone set so the removal replicates
      db.query("UPDATE skills SET status = 'archived', deleted = 1, updated_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        skill.id
      )
      stats.archived++
    } else if (age > staleAfter) {
      db.query("UPDATE skills SET status = 'stale', updated_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        skill.id
      )
      stats.stale++
    }
  }
  logObs("curator_run", stats)
  return stats
}

export function curatorStatus() {
  const db = getDb()
  const counts = db
    .query("SELECT status, COUNT(*) AS n FROM skills GROUP BY status")
    .all() as Array<{ status: string; n: number }>
  const last = db
    .query("SELECT created_at FROM observations WHERE type = 'curator_run' ORDER BY id DESC LIMIT 1")
    .get() as { created_at: string } | undefined
  return { counts, last_run: last?.created_at ?? null }
}

