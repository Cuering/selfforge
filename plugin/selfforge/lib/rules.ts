import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { getDb, now } from "./db"

export type Rule = {
  id: number
  rule: string
  project: string | null
  domain: string
  explicit_scope: string
  count: number
  total_count: number
  written_to: string | null
  created_at: string
  updated_at: string
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
    const info = db
      .query(
        "INSERT INTO rules (rule, project, domain, explicit_scope, count, total_count, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)"
      )
      .run(opts.rule, opts.project ?? null, domain, scope, ts, ts)
    rule = {
      id: Number(info.lastInsertRowid),
      rule: opts.rule,
      project: opts.project ?? null,
      domain,
      explicit_scope: scope,
      count: 1,
      total_count: 1,
      written_to: null,
      created_at: ts,
      updated_at: ts,
    }
  }
  return { rule, recommendation: recommend(rule) }
}

function recommend(rule: Rule): string {
  if (rule.explicit_scope === "global") return "escalate-global"
  if (rule.explicit_scope === "local") return "write-project"
  if (rule.count >= 2) return "write-project"
  return "record"
}

export function ruleStatus() {
  const rules = getDb()
    .query("SELECT * FROM rules ORDER BY total_count DESC, updated_at DESC")
    .all() as Rule[]
  return rules.map((r) => ({ ...r, recommendation: recommend(r) }))
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
