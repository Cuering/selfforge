import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "fs"
import { join } from "path"
import { getDb, getConfig, now, stamp } from "./db"
import { SKILLS_DIR, DISABLED_SKILLS_DIR } from "./db"

export type Skill = {
  id: number
  uuid: string | null
  origin: string | null
  name: string
  description: string | null
  description_en: string | null
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

/**
 * Full executable skill body (Chinese). Used when skill_create is called without
 * a body so the skill can actually drive the described task end-to-end.
 */
export function defaultSkillBody(name: string, description: string): string {
  const title = name || "skill"
  const goal = (description || "").trim() || "完成与本技能描述一致的任务"
  return `# ${title}

## 目标
${goal}

## 何时使用
- 用户请求或当前任务与上述目标一致时加载本技能。
- 不要在无关任务上调用；不确定时先用一句话确认是否匹配 description。

## 执行步骤
1. **理解任务**：用 1–3 条要点复述用户目标与验收标准；缺信息先问清再动手。
2. **检索上下文**：用 memory_search / 相关代码搜索，避免重复已有结论；遵守已注入记忆与 AGENTS 规则。
3. **按目标实施**：只做 description 范围内的改动；优先改现有文件，遵循项目惯例；不引入未声明的依赖。
4. **验证**：运行与本任务相关的测试/构建/类型检查或手工验收步骤；失败则修复后重跑。
5. **交付**：用中文简要说明改了什么、如何验证、剩余风险；需要持久化的教训再 memory_add / skill_patch。

## 硬性规则
- 不编造未验证的工具能力或文件路径。
- 不提交密钥；不自动 git commit/push，除非用户明确要求。
- 改配置/插件后说明是否需要重启才能生效。
- 零 LLM 约束的环境（如 selfforge 插件内）不得假设可直接调用模型 API。

## 验收标准
- 用户描述的任务已完成，或明确写出阻塞原因与下一步。
- 有可复查的验证结果（命令输出、页面行为或测试通过）。
- 若沉淀为技能补丁，body 中步骤仍可独立复现。
`
}

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

/** Ensure the description contains Chinese; if not, wrap with a Chinese note. */
function ensureChineseDesc(desc: string, name: string): string {
  if (/[\u4e00-\u9fff]/.test(desc)) return desc
  // Description is English/empty — wrap so the UI always shows Chinese.
  const clean = desc.trim() || `完成${name}相关任务`
  return `${clean} | 中文说明：${clean}`
}

export function skillCreate(name: string, description: string, body = "") {
  const db = getDb()
  const slug = slugify(name)
  const existing = db.query("SELECT * FROM skills WHERE name = ?").get(slug)
  if (existing) return { error: `Skill "${slug}" already exists`, id: (existing as Skill).id }
  const ts = now()
  const st = stamp()
  const desc = ensureChineseDesc(description, slug)
  const fullBody = (body && body.trim()) || defaultSkillBody(slug, desc)
  const content = FRONTMATTER(slug, desc) + fullBody
  const info = db
    .query(
      "INSERT INTO skills (uuid, origin, name, description, content, status, usage_count, fail_count, eta, trials_attempted, trials_passed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'candidate', 0, 0, 0.5, 0, 0, ?, ?)"
    )
    .run(st.uuid, st.origin, slug, desc, content, ts, ts)
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
  if (section === "description") {
    // Dual-write: dashboard/skills.list read the description COLUMN, not only content frontmatter.
    db.query("UPDATE skills SET description = ?, content = ?, updated_at = ? WHERE id = ?").run(
      content,
      newContent,
      now(),
      skill.id
    )
  } else {
    db.query("UPDATE skills SET content = ?, updated_at = ? WHERE id = ?").run(
      newContent,
      now(),
      skill.id
    )
  }
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
  // Active first, then candidate, then others; within group by usage then eta.
  const sql = `SELECT * FROM skills ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'candidate' THEN 1 WHEN 'stale' THEN 2 WHEN 'disabled' THEN 3 ELSE 4 END, usage_count DESC, eta DESC, updated_at DESC`
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

export const SKILL_STATUS_LABELS: Record<string, string> = {
  candidate: "候选",
  active: "活跃",
  disabled: "已停止",
  stale: "过期",
  archived: "已归档",
}

/** Description + status + location, for `skill info` / management UI. */
export function skillInfo(name: string) {
  const db = getDb()
  const skill = db.query("SELECT * FROM skills WHERE name = ?").get(name) as Skill | undefined
  if (!skill) return { error: `Skill "${name}" not found` }
  const active = existsSync(skillPath(name))
  const disabled = existsSync(join(DISABLED_SKILLS_DIR, name, "SKILL.md"))
  return {
    name: skill.name,
    description: skill.description,
    description_en: skill.description_en,
    status: skill.status,
    eta: skill.eta,
    usage: skill.usage_count,
    fails: skill.fail_count,
    trials: `${skill.trials_passed}/${skill.trials_attempted}`,
    optimized_at: skill.optimized_at,
    location: disabled ? join(DISABLED_SKILLS_DIR, name) : skillPath(skill.name),
    loaded_by_opencode: active && !disabled,
    content: skill.content ?? "",
  }
}

/** Start/enable a skill: move its SKILL dir back under SKILLS_DIR and un-dumb status. */
export function skillEnable(name: string) {
  const db = getDb()
  const skill = db.query("SELECT * FROM skills WHERE name = ?").get(name) as Skill | undefined
  if (!skill) return { error: `Skill "${name}" not found` }
  const disabledDir = join(DISABLED_SKILLS_DIR, name)
  const targetDir = join(SKILLS_DIR, name)
  if (existsSync(disabledDir)) {
    mkdirSync(SKILLS_DIR, { recursive: true })
    try {
      renameSync(disabledDir, targetDir)
    } catch {
      return { error: `Could not move ${disabledDir} -> ${targetDir}` }
    }
  } else if (!existsSync(targetDir) && skill.content) {
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(skillPath(name), skill.content)
  }
  const status = skill.trials_attempted >= (skillLifecycleConfig().candidateTrials as number) ? "active" : skill.status === "disabled" ? "candidate" : skill.status
  db.query("UPDATE skills SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), skill.id)
  return { enabled: true, name, status }
}

/** Stop/disable a skill: move its SKILL dir out of SKILLS_DIR so opencode stops loading it. */
export function skillDisable(name: string) {
  const db = getDb()
  const skill = db.query("SELECT * FROM skills WHERE name = ?").get(name) as Skill | undefined
  if (!skill) return { error: `Skill "${name}" not found` }
  const src = join(SKILLS_DIR, name)
  const dst = join(DISABLED_SKILLS_DIR, name)
  if (existsSync(src)) {
    mkdirSync(DISABLED_SKILLS_DIR, { recursive: true })
    try {
      renameSync(src, dst)
    } catch {
      return { error: `Could not move ${src} -> ${dst}` }
    }
  }
  db.query("UPDATE skills SET status = 'disabled', updated_at = ? WHERE id = ?").run(now(), skill.id)
  return { disabled: true, name }
}

/** Uninstall a skill completely: delete DB row + disk dir (both live and disabled). */
export function skillUninstall(name: string) {
  const db = getDb()
  const skill = db.query("SELECT * FROM skills WHERE name = ?").get(name) as Skill | undefined
  if (!skill) return { error: `Skill "${name}" not found` }
  for (const d of [join(SKILLS_DIR, name), join(DISABLED_SKILLS_DIR, name)]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
  // hard-delete row so it truly disappears from management
  try {
    db.query("DELETE FROM skills WHERE id = ?").run(skill.id)
    db.query("DELETE FROM evolution WHERE skill_id = ?").run(skill.id)
  } catch {}
  return { uninstalled: true, name }
}

/** Install a skill from a directory that contains SKILL.md(s). Scans dir/**\/SKILL.md. */
export function skillInstallFromDir(dir: string): { installed: string[]; skipped: string[] } {
  const installed: string[] = []
  const skipped: string[] = []
  const root = dir.trim()
  if (!root || !existsSync(root)) return { installed, skipped: [`directory not found: ${root}`] }

  const found: string[] = []
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name === "SKILL.md") found.push(p)
    }
  }
  walk(root)

  const db = getDb()
  for (const p of found) {
    const content = require("fs").readFileSync(p, "utf-8")
    const nameMatch = content.match(/^name:\s*(.+)$/m)
    const descMatch = content.match(/^description:\s*(.+)$/m)
    const name = slugify(nameMatch?.[1]?.trim() ?? "")
    if (!name) {
      skipped.push(`${p} (no name in frontmatter)`)
      continue
    }
    const existing = db.query("SELECT * FROM skills WHERE name = ?").get(name) as Skill | undefined
    const to = join(SKILLS_DIR, name)
    mkdirSync(to, { recursive: true })
    writeFileSync(join(to, "SKILL.md"), content)
    if (existing) {
      db.query("UPDATE skills SET description = ?, content = ?, status = 'active', deleted = 0, updated_at = ? WHERE id = ?").run(
        descMatch?.[1]?.trim() ?? existing.description,
        content,
        now(),
        existing.id
      )
      installed.push(`${name} (updated)`)
    } else {
      const ts = now()
      const st = stamp()
      db.query(
        "INSERT INTO skills (uuid, origin, name, description, content, status, usage_count, fail_count, eta, trials_attempted, trials_passed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', 0, 0, 0.5, 0, 0, ?, ?)"
      ).run(st.uuid, st.origin, name, descMatch?.[1]?.trim() ?? name, content, ts, ts)
      installed.push(name)
    }
  }
  if (found.length === 0) skipped.push(`no SKILL.md found under ${root}`)
  return { installed, skipped }
}

/** Adopt opencode's own skill directories (~/.config/opencode/skills, ~/.agents/skills) into selfforge management.
 *  MOVE semantics: each skill folder is relocated into SKILLS_DIR so the original location stops serving it. */
export function adoptOpencodeSkills(dirs: string[]): { installed: string[]; skipped: string[]; moved: string[] } {
  const installed: string[] = []
  const skipped: string[] = []
  const moved: string[] = []
  const db = getDb()
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue
      const skillDir = join(dir, entry.name)
      const p = join(skillDir, "SKILL.md")
      if (!existsSync(p)) continue
      const content = require("fs").readFileSync(p, "utf-8")
      const descMatch = content.match(/^description:\s*(.+)$/m)
      const to = join(SKILLS_DIR, entry.name)
      mkdirSync(SKILLS_DIR, { recursive: true })
      if (existsSync(to)) {
        // destination already managed: update content, keep DB row, drop the old folder
        try {
          rmSync(to, { recursive: true, force: true })
        } catch {}
      }
      let ok = false
      try {
        renameSync(skillDir, to)
        ok = true
      } catch {
        // cross-volume fallback: copy then remove
        try {
          writeFileSync(join(to, "SKILL.md"), content)
          mkdirSync(to, { recursive: true })
          writeFileSync(join(to, "SKILL.md"), content)
          rmSync(skillDir, { recursive: true, force: true })
          ok = true
        } catch {}
      }
      if (!ok) {
        skipped.push(`${entry.name} (move failed)`)
        continue
      }
      moved.push(`${entry.name} (${dir})`)
      const existing = db.query("SELECT * FROM skills WHERE name = ?").get(entry.name) as Skill | undefined
      if (existing) {
        db.query("UPDATE skills SET description = ?, content = ?, status = 'active', deleted = 0, updated_at = ? WHERE id = ?").run(
          descMatch?.[1]?.trim() ?? existing.description,
          content,
          now(),
          existing.id
        )
        installed.push(entry.name)
      } else {
        const ts = now()
        const st = stamp()
        db.query(
          "INSERT INTO skills (uuid, origin, name, description, content, status, usage_count, fail_count, eta, trials_attempted, trials_passed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', 0, 0, 0.5, 0, 0, ?, ?)"
        ).run(st.uuid, st.origin, entry.name, descMatch?.[1]?.trim() ?? entry.name, content, ts, ts)
        installed.push(entry.name)
      }
    }
  }
  return { installed, skipped, moved }
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
