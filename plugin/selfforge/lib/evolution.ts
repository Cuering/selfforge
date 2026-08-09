import { getDb, now, stamp } from "./db"
import { Skill, skillList, markSkillOptimized, skillPatch } from "./skills"

export type Evolution = {
  id: number
  uuid: string | null
  origin: string | null
  skill_id: number
  strategy: string
  candidate: string
  rationale: string | null
  status: string
  created_at: string
  applied_at: string | null
  deleted: number
}

export function evolutionCandidates(opts?: { minUse?: number; minFail?: number }) {
  const minUse = opts?.minUse ?? 2
  const minFail = opts?.minFail ?? 1
  const db = getDb()
  const skills = db
    .query(
      "SELECT * FROM skills WHERE status = 'active' AND usage_count >= ? AND fail_count >= ?"
    )
    .all(minUse, minFail) as Skill[]
  return skills.map((s) => ({
    name: s.name,
    usage: s.usage_count,
    fails: s.fail_count,
    hasPendingCandidate: !!db
      .query("SELECT id FROM evolution WHERE skill_id = ? AND status = 'pending'")
      .get(s.id),
  }))
}

export function evolutionPropose(opts: { skill: string; strategy: string; candidate: string; rationale?: string }) {
  const db = getDb()
  const skill = db.query("SELECT * FROM skills WHERE name = ?").get(opts.skill) as Skill | undefined
  if (!skill) return { error: `Skill "${opts.skill}" not found` }
  const st = stamp()
  const info = db
    .query(
      "INSERT INTO evolution (uuid, origin, skill_id, strategy, candidate, rationale, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)"
    )
    .run(st.uuid, st.origin, skill.id, opts.strategy, opts.candidate, opts.rationale ?? null, now())
  return { id: Number(info.lastInsertRowid), skill: opts.skill, status: "pending" }
}

export function evolutionList(opts?: { status?: string }) {
  const where = opts?.status ? "WHERE e.status = ?" : ""
  const params = opts?.status ? [opts.status] : []
  return getDb()
    .query(
      `SELECT e.*, s.name AS skill_name FROM evolution e JOIN skills s ON s.id = e.skill_id ${where} ORDER BY e.created_at DESC LIMIT 50`
    )
    .all(...params) as Array<Evolution & { skill_name: string }>
}

export function evolutionStatus() {
  const db = getDb()
  const pending = db
    .query("SELECT COUNT(*) AS n FROM evolution WHERE status = 'pending'")
    .get() as { n: number }
  const applied = db
    .query("SELECT COUNT(*) AS n FROM evolution WHERE status = 'applied'")
    .get() as { n: number }
  return {
    pending: pending.n,
    applied: applied.n,
    candidates: evolutionCandidates(),
    recent: evolutionList({ status: "pending" }),
  }
}

export function evolutionApply(id: number) {
  const db = getDb()
  const evo = db.query("SELECT * FROM evolution WHERE id = ?").get(id) as Evolution | undefined
  if (!evo) return { error: "evolution record not found" }
  if (evo.status === "applied") return { error: "already applied" }
  const skill = db.query("SELECT * FROM skills WHERE id = ?").get(evo.skill_id) as Skill | undefined
  if (!skill) return { error: "skill not found" }
  skillPatch(skill.name, "body", evo.candidate)
  markSkillOptimized(skill.name)
  db.query("UPDATE evolution SET status = 'applied', applied_at = ? WHERE id = ?").run(now(), evo.id)
  return { applied: true, id: evo.id, skill: skill.name }
}

export function evolutionReject(id: number) {
  getDb().query("UPDATE evolution SET status = 'rejected' WHERE id = ?").run(id)
  return { rejected: true, id }
}

export function evolutionAdvisory(): string | null {
  const pending = evolutionList({ status: "pending" })
  if (pending.length === 0) return null
  return pending
    .map((e) => `- Skill "${e.skill_name}" has a pending evolution candidate (${e.strategy}) — review with skill_optimize/evolution_apply`)
    .join("\n")
}

export function pickEvolutionCandidate() {
  // GEPA-style: returns the skill most needing evolution (highest fail/use ratio with >=2 uses).
  const cands = evolutionCandidates()
  if (cands.length === 0) return null
  cands.sort((a, b) => b.fails / b.usage - a.fails / a.usage)
  return cands[0]
}

/** Recent applied/rejected evolution records as short "behavior criteria" for injection. */
export function evolutionCriteria(max: number = 3): Array<{ strategy: string; skill: string; date: string }> {
  const rows = getDb()
    .query(
      `SELECT e.strategy, e.created_at, s.name AS skill_name
       FROM evolution e JOIN skills s ON s.id = e.skill_id
       WHERE e.status IN ('applied', 'pending')
       ORDER BY e.created_at DESC LIMIT ?`
    )
    .all(max) as Array<{ strategy: string; created_at: string; skill_name: string }>
  return rows.map((r) => ({
    strategy: r.strategy,
    skill: r.skill_name,
    date: (r.created_at || "").slice(0, 10),
  }))
}

export { skillList }
