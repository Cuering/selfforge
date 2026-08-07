import { getDb, now } from "./db"

export type Goal = {
  id: number
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
}

export type Checkpoint = {
  id: number
  goal_id: number
  cp: string
  status: string
  notes: string | null
  created_at: string
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
  const info = db
    .query(
      "INSERT INTO goals (goal, north_star, completion_criteria, status, level, iteration, max_iterations, project, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, 0, ?, ?, ?, ?)"
    )
    .run(
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
    db.query("INSERT INTO checkpoints (goal_id, cp, status, created_at) VALUES (?, ?, 'pending', ?)").run(
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
    db.query(
      "INSERT INTO checkpoints (goal_id, cp, status, notes, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(opts.goalId, opts.cp, status, opts.notes ?? null, now())
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

export function goalStatus(goalId?: number) {
  if (goalId) {
    const g = getGoal(goalId)
    if (!g) return { error: "goal not found" }
    return { ...g, checkpoints: goalCheckpoints(goalId) }
  }
  const goals = getDb()
    .query("SELECT * FROM goals WHERE status = 'active' ORDER BY updated_at DESC LIMIT 10")
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
    .query("SELECT * FROM goals WHERE status = 'active' ORDER BY updated_at DESC LIMIT 3")
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
