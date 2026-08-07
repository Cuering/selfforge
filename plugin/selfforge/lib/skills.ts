import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "fs"
import { join } from "path"
import { getDb, now } from "./db"
import { SKILLS_DIR } from "./db"

export type Skill = {
  id: number
  name: string
  description: string | null
  content: string | null
  status: string
  usage_count: number
  fail_count: number
  optimized_at: string | null
  created_at: string
  updated_at: string
  last_used_at: string | null
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
  const content = FRONTMATTER(slug, description) + (body || `# ${slug}\n\n${description}\n`)
  const info = db
    .query(
      "INSERT INTO skills (name, description, content, status, usage_count, fail_count, created_at, updated_at) VALUES (?, ?, ?, 'active', 0, 0, ?, ?)"
    )
    .run(slug, description, content, ts, ts)
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

export function skillList(opts?: { status?: string }): Skill[] {
  const where = opts?.status ? "WHERE status = ?" : ""
  const params = opts?.status ? [opts.status] : []
  return getDb()
    .query(`SELECT * FROM skills ${where} ORDER BY usage_count DESC, updated_at DESC`)
    .all(...params) as Skill[]
}

export function skillArchive(name: string) {
  const db = getDb()
  const skill = db.query("SELECT * FROM skills WHERE name = ?").get(name) as Skill | undefined
  if (!skill) return { error: `Skill "${name}" not found` }
  db.query("UPDATE skills SET status = 'archived', updated_at = ? WHERE id = ?").run(now(), skill.id)
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

export function recordSkillUse(name: string, failed = false) {
  const db = getDb()
  const skill = db.query("SELECT * FROM skills WHERE name = ?").get(name) as Skill | undefined
  if (!skill) return
  const use = skill.usage_count + 1
  const fail = skill.fail_count + (failed ? 1 : 0)
  db.query(
    "UPDATE skills SET usage_count = ?, fail_count = ?, last_used_at = ?, updated_at = ? WHERE id = ?"
  ).run(use, fail, now(), now(), skill.id)
}

export function markSkillOptimized(name: string) {
  getDb()
    .query("UPDATE skills SET optimized_at = ?, updated_at = ? WHERE name = ?")
    .run(now(), now(), name)
}

export function skillUsage() {
  return getDb()
    .query(
      "SELECT name, usage_count, fail_count, optimized_at, last_used_at, status FROM skills WHERE status = 'active' ORDER BY usage_count DESC"
    )
    .all()
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
        db.query(
          "INSERT INTO skills (name, description, content, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)"
        ).run(entry.name, descMatch?.[1] ?? entry.name, content, now(), now())
      }
    }
  } catch {}
}
