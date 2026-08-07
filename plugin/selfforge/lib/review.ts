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

export function formatReview(messages: Array<{ role: string; content: string }>, project: string): string {
  let md = "# Autolearn Review\n\n"
  md += "## Context\n\n"
  md += `- Project: ${project}\n`
  md += `- Date: ${new Date().toISOString()}\n`
  md += `- Messages: ${messages.length}\n`
  md += `- Trigger: unified-evolver\n\n`
  md += "## Instructions\n\n"
  md += 'Review the conversation below for learning opportunities.\nLoad the selfforge skill with: skill({ name: "evolve" })\n\n'
  md += "Use the provided tools to take action:\n\n"
  md += "1. `memory_add` 鈥?record general rules, corrections, preferences (not narrow instances)\n"
  md += "2. `user_add` 鈥?record communication/workflow preferences\n"
  md += "3. `rule_observe` 鈥?capture behavioral rules for AGENTS.md escalation\n"
  md += "4. `skill_create` / `skill_patch` 鈥?distill reusable techniques into skills\n"
  md += "5. `goal_*` 鈥?track ongoing goal progress\n\n"
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
    logObs("review_spawned", { file }, project)
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
  return buf
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
      db.query("UPDATE skills SET status = 'archived', updated_at = ? WHERE id = ?").run(
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

