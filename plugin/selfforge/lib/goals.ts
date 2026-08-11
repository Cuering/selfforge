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
    .query("SELECT * FROM checkpoints WHERE goal_id = ? AND cp = ?")
    .get(opts.goalId, opts.cp) as Checkpoint | undefined
  const status = opts.status ?? "done"
  if (existing) {
    db.query("UPDATE checkpoints SET status = ?, notes = ? WHERE id = ?").run(
      status,
      opts.notes ?? null,
      existing.id
    )
  } else {
    const st = stamp()
    db.query(
      "INSERT INTO checkpoints (uuid, origin, goal_id, cp, status, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(st.uuid, st.origin, opts.goalId, opts.cp, status, opts.notes ?? null, now())
  }
  if (opts.cp === "CP3") {
    db.query("UPDATE goals SET iteration = iteration + 1, updated_at = ? WHERE id = ?").run(
      now(),
      opts.goalId
    )
  }
  return goalCheckpoints(opts.goalId)
}

export function goalCheckpoints(goalId: number): Checkpoint[] {
  return getDb()
    .query("SELECT * FROM checkpoints WHERE goal_id = ? ORDER BY id")
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
  getDb().query("UPDATE goals SET status = 'completed', updated_at = ? WHERE id = ?").run(now(), goalId)
  return getGoal(goalId)
}

export function goalStop(goalId: number) {
  getDb().query("UPDATE goals SET status = 'stopped', updated_at = ? WHERE id = ?").run(now(), goalId)
  return getGoal(goalId)
}

export function goalAdvisory(): string | null {
  const goals = getDb()
    .query("SELECT * FROM goals WHERE deleted = 0 AND status = 'active' ORDER BY updated_at DESC LIMIT 3")
    .all() as Goal[]
  if (goals.length === 0) return null
  return goals
    .map((g) => {
      const done = goalCheckpoints(g.id).filter((c) => c.status === "done").length
      const total = goalCheckpoints(g.id).length
      return `- Goal "${g.goal}" (iter ${g.iteration}/${g.max_iterations}, CP ${done}/${total})`
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
  const ts = now()

  // 1. Completed checkpoints: remove (goal progress is captured in status already).
  const done = db
    .query("UPDATE checkpoints SET deleted = 1, created_at = ? WHERE deleted = 0 AND status = 'done'")
    .run(ts)

  // 2. Checkpoints belonging to goals that are no longer active (or were deleted).
  const orphaned = db
    .query(
      "UPDATE checkpoints SET deleted = 1, created_at = ? WHERE deleted = 0 AND goal_id IN (SELECT id FROM goals WHERE deleted = 1 OR status != 'active')"
    )
    .run(ts)

  // 3. Active goals that have already reached their max iterations: their
  //    remaining pending checkpoints are not actionable either.
  const exhausted = db
    .query(
      "UPDATE checkpoints SET deleted = 1, created_at = ? WHERE deleted = 0 AND goal_id IN (SELECT id FROM goals WHERE status = 'active' AND iteration >= max_iterations)"
    )
    .run(ts)

  const removed = Number(done.changes) + Number(orphaned.changes) + Number(exhausted.changes)
  const remaining_active = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM checkpoints c JOIN goals g ON g.id = c.goal_id WHERE c.deleted = 0 AND g.status = 'active'"
      )
      .get() as { n: number }
  ).n
  const remaining_pending = (
    db.query("SELECT COUNT(*) AS n FROM checkpoints WHERE deleted = 0 AND status = 'pending'").get() as { n: number }
  ).n
  return { removed, remaining_active, remaining_pending }
}
