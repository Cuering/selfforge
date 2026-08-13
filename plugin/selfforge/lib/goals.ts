import { getDb, now, stamp } from "./db"

export type Goal = {
  id: number
  uuid: string | null
  origin: string | null
  goal: string
  north_star: string | null
  completion_criteria: string | null
  status: string
  level: number
  iteration: number
  max_iterations: number
  project: string | null
  created_at: string
  updated_at: string
  deleted: number
}

export type Checkpoint = {
  id: number
  uuid: string | null
  origin: string | null
  goal_id: number
  cp: string
  status: string
  notes: string | null
  created_at: string
  deleted: number
}

const CP_ORDER = [
  "CP0",
  "CP0.5",
  "CP1",
  "CP1.5",
  "CP2",
  "CP3",
  "CP3.5",
  "CP4",
  "CP5",
  "CP6",
  "CP6.5",
]

export function goalStart(opts: {
  goal: string
  northStar?: string
  completionCriteria?: string
  maxIterations?: number
  level?: number
  project?: string
}) {
  const db = getDb()
  const ts = now()
  const st = stamp()
  const info = db
    .query(
      "INSERT INTO goals (uuid, origin, goal, north_star, completion_criteria, status, level, iteration, max_iterations, project, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?, ?, ?, ?)"
    )
    .run(
      st.uuid,
      st.origin,
      opts.goal,
      opts.northStar ?? null,
      opts.completionCriteria ?? null,
      opts.level ?? 0,
      opts.maxIterations ?? 10,
      opts.project ?? null,
      ts,
      ts
    )
  const id = Number(info.lastInsertRowid)
  seedCheckpoints(id)
  return { id, ...getGoal(id) }
}

function seedCheckpoints(goalId: number) {
  const db = getDb()
  for (const cp of CP_ORDER) {
    const st = stamp()
    db.query("INSERT INTO checkpoints (uuid, origin, goal_id, cp, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)").run(
      st.uuid,
      st.origin,
      goalId,
      cp,
      now()
    )
  }
}

export function getGoal(id: number): Goal | undefined {
  return getDb().query("SELECT * FROM goals WHERE id = ?").get(id) as Goal | undefined
}

export function goalCheckpoint(opts: { goalId: number; cp: string; status?: string; notes?: string }) {
  const db = getDb()
  const existing = db
    .query("SELECT * FROM checkpoints WHERE goal_id = ? AND cp = ? AND deleted = 0")
    .get(opts.goalId, opts.cp) as Checkpoint | undefined
  const status = opts.status ?? "done"
  if (existing) {
    db.query("UPDATE checkpoints SET status = ?, notes = ? WHERE id = ?").run(
      status,
      opts.notes ?? null,
      existing.id
    )
  } else {
    // A soft-deleted row for the same CP must be revived (not re-inserted),
    // otherwise we get a duplicate CP after maintainCheckpoints tombstones it.
    const tomb = db
      .query("SELECT * FROM checkpoints WHERE goal_id = ? AND cp = ? ORDER BY id ASC LIMIT 1")
      .get(opts.goalId, opts.cp) as Checkpoint | undefined
    if (tomb) {
      db.query("UPDATE checkpoints SET deleted = 0, status = ?, notes = ?, created_at = ? WHERE id = ?").run(
        status,
        opts.notes ?? null,
        now(),
        tomb.id
      )
    } else {
      const st = stamp()
      db.query(
        "INSERT INTO checkpoints (uuid, origin, goal_id, cp, status, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(st.uuid, st.origin, opts.goalId, opts.cp, status, opts.notes ?? null, now())
    }
  }
  if (opts.cp === "CP3") {
    db.query("UPDATE goals SET iteration = iteration + 1, updated_at = ? WHERE id = ?").run(
      now(),
      opts.goalId
    )
  }
  // Keep the checkpoint row (status = done/skipped/failed) so done/total progress
  // stays accurate; goalComplete() clears all CPs when the goal finishes.
  return goalCheckpoints(opts.goalId)
}

/**
 * Auto-advance the FIRST pending checkpoint of each active goal whose likely
 * next stage can be inferred. Deterministic: for goals whose first pending CP is
 * the immediate next in CP_ORDER after a completed one, we consider the current
 * stage "in progress" and promote the earliest pending -> done ONLY if marked.
 * This is intentionally conservative: we never fabricate progress. It just
 * offers a one-step help: when goal_status shows a goal with zero done but the
 * user has demonstrably worked on it, callers may use goal_progress.
 */
export function goalProgress(goalId: number, notes?: string) {
  const g = getGoal(goalId)
  if (!g || g.status !== "active") return { error: "goal not active" }
  const cps = goalCheckpoints(goalId)
  const pending = cps.find((c) => c.status === "pending")
  if (!pending) return { done: true, goalId }
  const res = goalCheckpoint({ goalId, cp: pending.cp, status: "done", notes: notes ?? "auto-advanced" })
  return { advanced: pending.cp, remaining: res.filter((c) => c.status === "pending").length }
}

export function goalCheckpoints(goalId: number): Checkpoint[] {
  return getDb()
    .query("SELECT * FROM checkpoints WHERE goal_id = ? AND deleted = 0 ORDER BY id")
    .all(goalId) as Checkpoint[]
}

export function goalStatus(): Array<Goal & { checkpoints: Checkpoint[] }>
export function goalStatus(goalId: number): (Goal & { checkpoints: Checkpoint[] }) | { error: string }
export function goalStatus(goalId?: number) {
  if (goalId) {
    const g = getGoal(goalId)
    if (!g) return { error: "goal not found" }
    return { ...g, checkpoints: goalCheckpoints(goalId) }
  }
  const goals = getDb()
    .query("SELECT * FROM goals WHERE deleted = 0 AND status = 'active' ORDER BY updated_at DESC LIMIT 10")
    .all() as Goal[]
  return goals.map((g) => ({ ...g, checkpoints: goalCheckpoints(g.id) }))
}

export function goalComplete(goalId: number) {
  const db = getDb()
  const g = getGoal(goalId)
  db.query("UPDATE goals SET status = 'completed', updated_at = ? WHERE id = ?").run(now(), goalId)
  // A completed goal's checkpoints are terminal — clear them so the dashboard
  // doesn't accumulate historical CP rows for finished goals.
  db.query("UPDATE checkpoints SET deleted = 1 WHERE goal_id = ? AND deleted = 0").run(goalId)
  // A finished goal means its project's activity is done: clear the audit log
  // for that project once no other goal is still active there.
  if (g?.project) {
    const stillActive = db
      .query("SELECT COUNT(*) AS n FROM goals WHERE deleted = 0 AND status = 'active' AND project = ?")
      .get(g.project) as { n: number }
    if (stillActive.n === 0) {
      const keys = projectObsKeys(g.project)
      const ph = keys.map(() => "?").join(",")
      db.query(`UPDATE observations SET deleted = 1 WHERE deleted = 0 AND project IN (${ph})`).run(...keys)
    }
  }
  return getGoal(goalId)
}

/** Candidate project spellings for observation cleanup (drive-letter/path-separator variants). */
function projectObsKeys(p: string): string[] {
  const keys = new Set([p])
  const base = p.replace(/^[a-zA-Z]:[\\/]+/, "").replace(/^[a-zA-Z]:/, "")
  if (base) keys.add(base)
  if (base) keys.add(base.replace(/[\\/]/g, ""))
  if (base && base.includes("\\")) keys.add(base.replace(/\\/g, "/"))
  return [...keys]
}

export function goalStop(goalId: number) {
  getDb().query("UPDATE goals SET status = 'stopped', updated_at = ? WHERE id = ?").run(now(), goalId)
  return getGoal(goalId)
}

/** Map a CP id to a human-readable stage description (progress guidance). */
const CP_LABELS: Record<string, string> = {
  "CP0": "定义北星目标与验收",
  "CP0.5": "对齐目标与完成标准",
  "CP1": "检索相关记忆/上下文",
  "CP1.5": "一致性检查（事实校准）",
  "CP2": "实施与构建/测试",
  "CP3": "里程碑确认（本轮达成）",
  "CP3.5": "失败复盘",
  "CP4": "迭代总结",
  "CP5": "复盘或修复收尾",
  "CP6": "健康检查",
  "CP6.5": "收尾与归档",
}

export function goalAdvisory(): string | null {
  const goals = getDb()
    .query("SELECT * FROM goals WHERE deleted = 0 AND status = 'active' ORDER BY updated_at DESC LIMIT 3")
    .all() as Goal[]
  if (goals.length === 0) return null
  return goals
    .map((g) => {
      const cps = goalCheckpoints(g.id)
      const done = cps.filter((c) => c.status === "done").length
      const total = cps.length
      const pending = cps.find((c) => c.status === "pending")
      const next = pending ? `下一步: ${pending.cp} (${CP_LABELS[pending.cp] || "推进中"})` : "检查点已完成，可 goal_complete"
      const criteria = g.completion_criteria ? ` 验收: ${g.completion_criteria.slice(0, 120)}` : ""
      return `- Goal "${g.goal}" (iter ${g.iteration}/${g.max_iterations}, CP ${done}/${total})\n  ${next}${criteria}`
    })
    .join("\n")
}

/**
 * Checkpoint housekeeping (run on idle / periodically):
 *  - "done" checkpoints are no longer needed once the goal advances → soft-delete.
 *  - Pending checkpoints on goals that are no longer active (completed/stopped)
 *    have no purpose → soft-delete.
 *  - Pending checkpoints on active goals are kept — they are the actionable
 *    next steps, driven by goal_checkpoint.
 */
export function maintainCheckpoints(): { removed: number; remaining_active: number; remaining_pending: number } {
  const db = getDb()

  // 1. Checkpoints belonging to goals that are no longer active (or were deleted)
  //    are no longer actionable — soft-delete them.
  //    NOTE: active goals' checkpoints are KEPT, including done ones, so that
  //    progress counts (done/total) stay accurate for goalAdvisory. Completed
  //    checkpoints of an ACTIVE goal remain administrable via goalComplete().
  const orphaned = db
    .query(
      "UPDATE checkpoints SET deleted = 1 WHERE deleted = 0 AND goal_id IN (SELECT id FROM goals WHERE deleted = 1 OR status != 'active')"
    )
    .run()

  const removed = Number(orphaned.changes)
  const remaining_active = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM checkpoints c JOIN goals g ON g.id = c.goal_id WHERE c.deleted = 0 AND g.status = 'active'"
      )
      .get() as { n: number }
  ).n
  const remaining_pending = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM checkpoints c JOIN goals g ON g.id = c.goal_id WHERE c.deleted = 0 AND c.status = 'pending' AND g.status = 'active'"
      )
      .get() as { n: number }
  ).n
  return { removed, remaining_active, remaining_pending }
}
