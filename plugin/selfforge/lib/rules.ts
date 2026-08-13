import { existsSync, readFileSync, writeFileSync, appendFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { getDb, now, stamp } from "./db"

// Ensure score/feedback columns exist
function ensureRuleColumns(): void {
  try {
    const db = getDb()
    const cols = db.query("PRAGMA table_info(rules)").all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === "score"))
      db.exec("ALTER TABLE rules ADD COLUMN score REAL DEFAULT 0")
    if (!cols.some((c) => c.name === "feedback"))
      db.exec("ALTER TABLE rules ADD COLUMN feedback INTEGER DEFAULT 0")
  } catch {}
}
ensureRuleColumns()

export type Rule = {
  id: number
  uuid: string | null
  origin: string | null
  rule: string
  project: string | null
  domain: string
  explicit_scope: string
  count: number
  total_count: number
  written_to: string | null
  created_at: string
  updated_at: string
  deleted: number
  /** Auto-computed score (0-10): higher = more likely to be escalated/used. */
  score: number
  /** Manual thumbs feedback: +1 or -1, cumulative. */
  feedback: number
}

export const DOMAINS = [
  "tooling",
  "workflow",
  "code-style",
  "communication",
  "architecture",
  "testing",
  "security",
  "unknown",
]

export function ruleObserve(opts: {
  rule: string
  project?: string
  domain?: string
  explicitScope?: "global" | "local"
}) {
  const db = getDb()
  const domain = opts.domain && DOMAINS.includes(opts.domain) ? opts.domain : "unknown"
  const scope = opts.explicitScope ?? "local"
  const existing = db
    .query("SELECT * FROM rules WHERE rule = ? AND project IS ?")
    .get(opts.rule, opts.project ?? null) as Rule | undefined
  const ts = now()
  let rule: Rule
  if (existing) {
    const count = existing.count + 1
    const total = existing.total_count + 1
    db.query(
      "UPDATE rules SET count = ?, total_count = ?, updated_at = ? WHERE id = ?"
    ).run(count, total, ts, existing.id)
    rule = { ...existing, count, total_count: total, updated_at: ts }
  } else {
    const st = stamp()
    const info = db
      .query(
        "INSERT INTO rules (uuid, origin, rule, project, domain, explicit_scope, count, total_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)"
      )
      .run(st.uuid, st.origin, opts.rule, opts.project ?? null, domain, scope, ts, ts)
    rule = {
      id: Number(info.lastInsertRowid),
      uuid: st.uuid,
      origin: st.origin,
      rule: opts.rule,
      project: opts.project ?? null,
      domain,
      explicit_scope: scope,
      count: 1,
      total_count: 1,
      written_to: null,
      created_at: ts,
      updated_at: ts,
      deleted: 0,
    }
  }
  const score = computeScore(rule)
  persistScore(rule.id, score)
  return { rule, recommendation: recommend({ ...rule, score }) }
}

/** Auto-score a rule (0-10, higher = better for escalation/use). */
function computeScore(rule: Rule): number {
  // Base 3 points for every rule; decay 1 point per 60 days since last update.
  let score = 3
  if (rule.updated_at) {
    const days = (Date.now() - new Date(rule.updated_at).getTime()) / 86400000
    const decay = Math.floor(days / 60)
    if (decay > 0) score -= decay
  }
  // Count frequency bonus (max 4 pts)
  const freq = rule.total_count > 0 ? Math.min(rule.total_count, 20) / 20 * 4 : 0
  score += freq
  // Recency: updated within last 7 days → +2, 30 days → +1, else 0
  if (rule.updated_at) {
    const days = (Date.now() - new Date(rule.updated_at).getTime()) / 86400000
    if (days < 7) score += 2
    else if (days < 30) score += 1
  }
  // Domain weight: communication/tooling more actionable
  if (rule.domain === "communication" || rule.domain === "tooling") score += 1.5
  if (rule.domain === "workflow" || rule.domain === "code-style") score += 1
  // Already escalated → +1 (confirmed value)
  if (rule.written_to) score += 1
  // Manual feedback: ±1 per thumbs
  const fb = rule.feedback ?? 0
  score += Math.sign(fb) * Math.min(Math.abs(fb), 3) * 0.5
  // Recency bonus for re-observation
  if (rule.count >= 3) score += 1
  // Scale to 0-10
  return Math.max(0, Math.min(10, Math.round(score * 10) / 10))
}

/** Persist the computed score for a rule. */
function persistScore(id: number, score: number): void {
  getDb().query("UPDATE rules SET score = ? WHERE id = ?").run(score, id)
}

function recommend(rule: Rule): string {
  if (rule.score === undefined) rule.score = computeScore(rule)
  if (rule.score >= 6) return "escalate-global"
  if (rule.score >= 4) return "write-project"
  if (rule.count >= 2) return "write-project"
  return "record"
}

/** Thumbs up/down: ±1 per call, cumulative. Accept numeric id or uuid. */
export function ruleFeedback(id: number | string, positive: boolean): { ok: boolean; name: string; score: number; feedback: number } {
  const db = getDb()
  const isNum = typeof id === "number" || (typeof id === "string" && /^\d+$/.test(String(id)))
  const row = isNum
    ? (db.query("SELECT * FROM rules WHERE id = ?").get(Number(id)) as Rule | undefined)
    : (db.query("SELECT * FROM rules WHERE uuid = ?").get(String(id)) as Rule | undefined)
  if (!row) return { ok: false, name: "", score: 0, feedback: 0 }
  const pk = row.id
  const fb = (row.feedback ?? 0) + (positive ? 1 : -1)
  db.query("UPDATE rules SET feedback = ?, updated_at = ? WHERE id = ?").run(fb, now(), pk)
  const score = computeScore({ ...row, feedback: fb })
  persistScore(pk, score)
  return { ok: true, name: row.rule.slice(0, 40), score, feedback: fb }
}

export function ruleStatus() {
  const rules = getDb()
    .query("SELECT * FROM rules ORDER BY score DESC, total_count DESC, updated_at DESC")
    .all() as Rule[]
  return rules.map((r) => {
    const score = r.score ?? computeScore(r)
    return { ...r, score, recommendation: recommend({ ...r, score }) }
  })
}

export function ruleDue(minCount = 2) {
  const rules = ruleStatus()
  return rules.filter((r) => r.count >= minCount && !r.written_to)
}

function globalAgentsPath(): string {
  return join(homedir(), ".config", "opencode", "AGENTS.md")
}

export function agentsPathFor(project: string | null): string {
  if (project) return join(project, "AGENTS.md")
  return globalAgentsPath()
}

export function escalate(opts: { dryRun?: boolean; minCount?: number }) {
  const due = ruleDue(opts.minCount ?? 2)
  const results: Array<{ rule: string; file: string; action: string }> = []
  for (const r of due) {
    const file = r.explicit_scope === "global" || !r.project ? globalAgentsPath() : agentsPathFor(r.project)
    results.push({ rule: r.rule, file, action: opts.dryRun ? "would-write" : "write" })
    if (opts.dryRun) continue
    writeRule(file, r.rule, r.domain)
    getDb()
      .query("UPDATE rules SET written_to = ?, count = 0, updated_at = ? WHERE id = ?")
      .run(file, now(), r.id)
  }
  return { count: results.length, results }
}

export function writeRule(file: string, rule: string, domain: string) {
  let content = ""
  if (existsSync(file)) content = readFileSync(file, "utf-8")
  const section = `## ${domain === "unknown" ? "General" : domain}`
  const lines = content.split("\n")
  let idx = lines.findIndex((l) => l.trim() === section)
  if (idx === -1) {
    content = content.replace(/\n?$/, "") + `\n${section}\n\n- ${rule}\n`
  } else {
    const bullet = `- ${rule}`
    if (lines.slice(idx + 1).includes(bullet)) return
    let insertAt = idx + 1
    while (insertAt < lines.length && lines[insertAt].startsWith("## ") === false) insertAt++
    lines.splice(insertAt, 0, bullet)
    content = lines.join("\n")
  }
  const dir = file.replace(/[\\/][^\\/]*$/, "")
  if (!existsSync(dir)) require("fs").mkdirSync(dir, { recursive: true })
  writeFileSync(file, content.replace(/\n$/, "") + "\n")
}

export function ruleConfirm(id: number, scope: "global" | "local") {
  getDb()
    .query("UPDATE rules SET written_to = ?, count = 0, updated_at = ? WHERE id = ?")
    .run(scope, now(), id)
  return { confirmed: true, id }
}

export function ruleHistory() {
  return getDb()
    .query("SELECT * FROM rules ORDER BY updated_at DESC LIMIT 100")
    .all()
}

/**
 * Auto-escalate: write high-scoring rules (score >= 6) to AGENTS.md.
 * Also auto-demote: remove rules from AGENTS.md if score < 3 and written > 30 days ago.
 * Called on curator run (idle maintenance).
 */
export function autoEscalateRules() {
  const db = getDb()
  const ts = now()
  const results: Array<{ rule: string; action: string }> = []
  // Escalate high-scoring unwritten rules
  const all = ruleStatus()
  for (const r of all) {
    if (r.score >= 6 && !r.written_to) {
      const file = r.explicit_scope === "global" || !r.project ? globalAgentsPath() : agentsPathFor(r.project)
      writeRule(file, r.rule, r.domain)
      db.query("UPDATE rules SET written_to = ?, count = 0, updated_at = ? WHERE id = ?").run(file, ts, r.id)
      results.push({ rule: r.rule.slice(0, 40), action: "escalated" })
    }
  }
  // Demote: if written > 60 days ago and score < 3, remove from AGENTS.md (soft)
  const staleAfter = 60 * 86400000
  const nowMs = Date.now()
  for (const r of all) {
    if (!r.written_to) continue
    if (r.score >= 3) continue
    const updated = r.updated_at ? new Date(r.updated_at).getTime() : 0
    if (nowMs - updated > staleAfter) {
      // Mark as not written (the AGENTS.md entry stays but won't be re-added)
      db.query("UPDATE rules SET written_to = NULL, updated_at = ? WHERE id = ?").run(ts, r.id)
      results.push({ rule: r.rule.slice(0, 40), action: "demoted" })
    }
  }
  return results
}
