import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "fs"
import { join } from "path"
import { getDb, getConfig, now, stamp } from "./db"
import { SKILLS_DIR } from "./db"

export type Skill = {
  id: number
  uuid: string | null
  origin: string | null
  name: string
  description: string | null
  content: string | null
  status: string
  usage_count: number
  fail_count: number
  eta: number
  trials_attempted: number
  trials_passed: number
  optimized_at: string | null
  created_at: string
  updated_at: string
  last_used_at: string | null
  deleted: number
}

export const SKILL_STATUSES = ["candidate", "active", "stale", "archived"] as const
export type SkillStatus = (typeof SKILL_STATUSES)[number]

/**
 * Trial lifecycle (ported from MemOS `core/skill`):
 * - fresh skills start as `candidate` with eta = Beta(1,1) prior midpoint 0.5.
 * - every trial (use) updates eta = (passed+1)/(attempted+2).
 * - after `candidateTrials` attempts the skill graduates to `active` if
 *   eta >= minEtaForRetrieval, else it is `archived`.
 * - active skills with eta < archiveEta are archived; archived skills can
 *   rehab on positive feedback (eta >= minEtaForRetrieval).
 * - reward drift: eta' = clamp01(0.7*eta + 0.3*magnitude) blends, not overwrites.
 */
export function betaEta(passed: number, attempted: number): number {
  return (passed + 1) / (attempted + 2)
}

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

export function skillLifecycleConfig() {
  return {
    candidateTrials: Number(getConfig("skill_candidate_trials", "3")) || 3,
    minEtaForRetrieval: Number(getConfig("skill_min_eta_retrieval", "0.5")) || 0.5,
    archiveEta: Number(getConfig("skill_archive_eta", "0.3")) || 0.3,
    etaDelta: Number(getConfig("skill_eta_delta", "0.1")) || 0.1,
  }
}

/** Record a skill trial (pass or fail) and apply the lifecycle transition. */
export function recordSkillUse(name: string, failed = false) {
  const db = getDb()
  const skill = db.query("SELECT * FROM skills WHERE name = ?").get(name) as Skill | undefined
  if (!skill) return
  const cfg = skillLifecycleConfig()
  const attempted = skill.trials_attempted + 1
  const passed = skill.trials_passed + (failed ? 0 : 1)
  const eta = betaEta(passed, attempted)
  let status = skill.status
  if (status === "candidate" && attempted >= cfg.candidateTrials) {
    status = eta >= cfg.minEtaForRetrieval ? "active" : "archived"
  } else if (status === "active" && eta < cfg.archiveEta) {
    status = "archived"
  } else if (status === "stale" && !failed) {
    status = "active"
  }
  const ts = now()
  db.query(
    "UPDATE skills SET usage_count = ?, fail_count = ?, trials_attempted = ?, trials_passed = ?, eta = ?, status = ?, last_used_at = ?, updated_at = ? WHERE id = ?"
  ).run(
    skill.usage_count + 1,
    skill.fail_count + (failed ? 1 : 0),
    attempted,
    passed,
    eta,
    status,
    ts,
    ts,
    skill.id
  )
}

/** Apply a reward signal to a skill: eta' = clamp01(0.7*eta + 0.3*magnitude). */
export function applySkillReward(name: string, magnitude: number) {
  const db = getDb()
  const skill = db.query("SELECT * FROM skills WHERE name = ?").get(name) as Skill | undefined
  if (!skill) return
  const cfg = skillLifecycleConfig()
  const eta = clamp01(0.7 * skill.eta + 0.3 * magnitude)
  let status = skill.status
  if (status === "active" && eta < cfg.archiveEta) status = "archived"
  db.query("UPDATE skills SET eta = ?, status = ?, updated_at = ? WHERE id = ?").run(eta, status, now(), skill.id)
}

/** User thumbs feedback: eta ± etaDelta, with rehab / retire transitions. */
export function skillFeedback(name: string, positive: boolean) {
  const db = getDb()
  const skill = db.query("SELECT * FROM skills WHERE name = ?").get(name) as Skill | undefined
  if (!skill) return { error: `Skill "${name}" not found` }
  const cfg = skillLifecycleConfig()
  const eta = clamp01(skill.eta + (positive ? cfg.etaDelta : -cfg.etaDelta))
  let status = skill.status
  if (status === "archived" && eta >= cfg.minEtaForRetrieval) {
    status = "candidate"
  } else if ((status === "active" || status === "candidate") && eta < cfg.archiveEta) {
    status = "archived"
  }
  db.query("UPDATE skills SET eta = ?, status = ?, updated_at = ? WHERE id = ?").run(eta, status, now(), skill.id)
  return { ok: true, name, eta, status }
}

const FRONTMATTER = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  provenance: unified-evolver\n---\n`

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

export function skillPath(name: string): string {
  return join(SKILLS_DIR, name, "SKILL.md")
}

export function skillCreate(name: string, description: string, body = "") {
  const db = getDb()
  const slug = slugify(name)
  const existing = db.query("SELECT * FROM skills WHERE name = ?").get(slug)
  if (existing) return { error: `Skill "${slug}" already exists`, id: (existing as Skill).id }
  const ts = now()
  const st = stamp()
  const content = FRONTMATTER(slug, description) + (body || `# ${slug}\n\n${description}\n`)
  const info = db
    .query(
      "INSERT INTO skills (uuid, origin, name, description, content, status, usage_count, fail_count, eta, trials_attempted, trials_passed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'candidate', 0, 0, 0.5, 0, 0, ?, ?)"
    )
    .run(st.uuid, st.origin, slug, description, content, ts, ts)
  const dir = join(SKILLS_DIR, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(skillPath(slug), content)
  return { id: Number(info.lastInsertRowid), name: slug, path: skillPath(slug) }
}

export function skillPatch(name: string, section: string, content: string) {
  const db = getDb()
  const skill = db.query("SELECT * FROM skills WHERE name = ?").get(name) as Skill | undefined
  if (!skill) return { error: `Skill "${name}" not found` }
  const base = skill.content || ""
  let newContent: string
  if (section === "description") {
    const m = base.match(/^(---\n)/)
    newContent = base.replace(/description:.*/, `description: ${content}`)
    if (newContent === base) newContent = m ? `${m[1]}description: ${content}\n` + base.slice(3) : base
  } else if (section === "body") {
    newContent = base.replace(/(---\n)([\s\S]*)$/, (_a, fm: string, rest: string) => {
      const body = rest.includes("# ") ? rest : `# ${name}\n\n`
      return fm + body.replace(/^([\s\S]*?)(?=\n## |$)/, content) + (content.endsWith("\n") ? "" : "\n")
    })
  } else {
    newContent = base + `\n## ${section}\n\n${content}\n`
  }
  db.query("UPDATE skills SET content = ?, updated_at = ? WHERE id = ?").run(
    newContent,
    now(),
    skill.id
  )
  writeFileSync(skillPath(name), newContent)
  return { patched: true, name, section }
}

export function skillList(opts?: { status?: string; includeDeleted?: boolean }): Skill[] {
  const where: string[] = []
  const params: unknown[] = []
  if (opts?.status) {
    where.push("status = ?")
    params.push(opts.status)
  }
  if (!opts?.includeDeleted) where.push("deleted = 0")
  const sql = `SELECT * FROM skills ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY usage_count DESC, updated_at DESC`
  return getDb().query(sql).all(...params) as Skill[]
}

/** Skills eligible for retrieval: candidate/active, not retired, above eta floor. */
export function skillVisible(): Skill[] {
  const cfg = skillLifecycleConfig()
  return getDb()
    .query(
      "SELECT * FROM skills WHERE deleted = 0 AND status IN ('candidate','active') AND eta >= ? ORDER BY eta DESC, usage_count DESC"
    )
    .all(cfg.minEtaForRetrieval) as Skill[]
}

export function skillArchive(name: string) {
  const db = getDb()
  const skill = db.query("SELECT * FROM skills WHERE name = ?").get(name) as Skill | undefined
  if (!skill) return { error: `Skill "${name}" not found` }
  db.query("UPDATE skills SET status = 'archived', deleted = 1, updated_at = ? WHERE id = ?").run(now(), skill.id)
  const src = join(SKILLS_DIR, name)
  const dst = join(SKILLS_DIR, ".archive", name)
  try {
    if (existsSync(src)) {
      if (existsSync(dst)) renameSync(dst, dst + "-" + Date.now())
      renameSync(src, dst)
    }
  } catch {}
  return { archived: true, name }
}

export function markSkillOptimized(name: string) {
  getDb()
    .query("UPDATE skills SET optimized_at = ?, updated_at = ? WHERE name = ?")
    .run(now(), now(), name)
}

export function skillUsage() {
  return getDb()
    .query(
      "SELECT name, status, eta, trials_attempted, trials_passed, usage_count, fail_count, optimized_at, last_used_at FROM skills WHERE deleted = 0 ORDER BY usage_count DESC"
    )
    .all()
}

/** Lifecycle summary: counts by status + trial cohort (candidates nearing graduation). */
export function skillStatus() {
  const db = getDb()
  const counts = db
    .query("SELECT status, COUNT(*) AS n FROM skills WHERE deleted = 0 GROUP BY status")
    .all() as Array<{ status: string; n: number }>
  const cfg = skillLifecycleConfig()
  const candidates = db
    .query(
      "SELECT name, eta, trials_attempted, trials_passed FROM skills WHERE deleted = 0 AND status = 'candidate' ORDER BY trials_attempted DESC LIMIT 10"
    )
    .all() as Array<{ name: string; eta: number; trials_attempted: number; trials_passed: number }>
  return {
    counts,
    candidateTrials: cfg.candidateTrials,
    minEtaForRetrieval: cfg.minEtaForRetrieval,
    candidates: candidates.map((c) => ({
      ...c,
      graduated: c.trials_attempted >= cfg.candidateTrials,
    })),
    visible: skillVisible().length,
  }
}

export function syncSkillsToDisk() {
  // Reconcile: skills marked active but missing on disk -> write; disk-only SKILL.md -> register.
  const db = getDb()
  for (const s of skillList()) {
    if (s.status !== "active") continue
    const p = skillPath(s.name)
    if (!existsSync(p) && s.content) {
      mkdirSync(join(SKILLS_DIR, s.name), { recursive: true })
      writeFileSync(p, s.content)
    }
  }
  try {
    for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue
      const p = join(SKILLS_DIR, entry.name, "SKILL.md")
      if (!existsSync(p)) continue
      const existing = db.query("SELECT * FROM skills WHERE name = ?").get(entry.name)
      if (!existing) {
        const content = require("fs").readFileSync(p, "utf-8")
        const descMatch = content.match(/^description:\s*(.+)$/m)
        const st = stamp()
        db.query(
          "INSERT INTO skills (uuid, origin, name, description, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)"
        ).run(st.uuid, st.origin, entry.name, descMatch?.[1] ?? entry.name, content, now(), now())
      }
    }
  } catch {}
}
