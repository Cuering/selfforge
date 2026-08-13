import { test, expect, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Regression: checkpoints must not surface duplicates or tombstones.
// - goalCheckpoints filters deleted=0 (no ghost rows in goalStatus/advisory).
// - goalCheckpoint revives a tombstoned row instead of inserting a new one.
// - maintainCheckpoints preserves created_at (day aggregation must not shift).

const tmpHome = mkdtempSync(join(tmpdir(), "selfforge-goals-"))
process.env.EVOLVE_HOME = tmpHome

const dbMod = await import("../plugin/selfforge/lib/db")
dbMod.initDb()

const goals = await import("../plugin/selfforge/lib/goals")

afterAll(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true })
  } catch {}
})

test("goalStatus reflects live checkpoints with accurate done/pending progress", () => {
  const g = goals.goalStart({ goal: "cp dedupe test", northStar: "ns", completionCriteria: "done" })
  // mark CP0/CP0.5 done — they are KEPT so done/total progress stays accurate.
  goals.goalCheckpoint({ goalId: g.id, cp: "CP0", status: "done", notes: "x" })
  goals.goalCheckpoint({ goalId: g.id, cp: "CP0.5", status: "done", notes: "y" })
  const st = goals.goalStatus(g.id)
  expect(st).toBeTruthy()
  if ("error" in st) throw new Error(String(st.error))
  const cps = st.checkpoints
  const done = cps.filter((c: any) => c.status === "done")
  // Completed CPs remain surfaced (progress), not auto-cleared.
  expect(done.length).toBeGreaterThanOrEqual(2)
  expect(cps.some((c: any) => c.deleted === 1)).toBe(false)
  // goalAdvisory shows accurate done/total
  const adv = goals.goalAdvisory()
  expect(adv).toBeTruthy()
  expect(adv).toMatch(/CP 2\//)
})

test("goalProgress advances the next pending checkpoint to done", () => {
  const g = goals.goalStart({ goal: "cp progress test", northStar: "ns", completionCriteria: "done" })
  const res = goals.goalProgress(g.id, "finished analysis")
  expect(res.advanced).toBe("CP0")
  const cps = goals.goalCheckpoints(g.id)
  expect(cps.find((c: any) => c.cp === "CP0")?.status).toBe("done")
  const res2 = goals.goalProgress(g.id)
  expect(res2.advanced).toBe("CP0.5")
})

test("maintainCheckpoints preserves created_at and keeps active goals' checkpoints", () => {
  const g = goals.goalStart({ goal: "cp timeline test", northStar: "ns", completionCriteria: "done" })
  goals.goalCheckpoint({ goalId: g.id, cp: "CP2", status: "done", notes: "t" })
  const db = dbMod.getDb()
  const row = db.query("SELECT created_at FROM checkpoints WHERE goal_id = ? AND cp = 'CP2'").get(g.id) as {
    created_at: string
  }
  const original = row.created_at
  goals.maintainCheckpoints()
  const after = db
    .query("SELECT created_at, deleted FROM checkpoints WHERE goal_id = ? AND cp = 'CP2'")
    .get(g.id) as { created_at: string; deleted: number }
  expect(after.created_at).toBe(original) // never rewritten
  // Active goal checkpoints are KEPT (deleted stays 0) for accurate progress
  expect(after.deleted).toBe(0)
})

test("goalComplete clears the project's observations when the last active goal finishes", async () => {
  const db = dbMod.getDb()
  db.query(
    "INSERT INTO observations (uuid, origin, type, payload, project, created_at) VALUES ('u-' || hex(randomblob(8)), 'n', 'test_obs', '{}', 'C:\\projX\\sub', datetime('now'))"
  ).run()
  db.query(
    "INSERT INTO observations (uuid, origin, type, payload, project, created_at) VALUES ('u-' || hex(randomblob(8)), 'n', 'test_obs2', '{}', 'projX/sub', datetime('now'))"
  ).run()
  const g = goals.goalStart({ goal: "obs purge test", northStar: "ns", completionCriteria: "done", project: "C:\\projX\\sub" })
  expect(
    (db.query("SELECT COUNT(*) AS n FROM observations WHERE deleted = 0 AND type LIKE 'test_obs%'").get() as { n: number }).n
  ).toBe(2)
  goals.goalComplete(g.id)
  // drive-letter and path variants of the project are both cleared
  const remaining = db
    .query("SELECT COUNT(*) AS n FROM observations WHERE deleted = 0 AND type LIKE 'test_obs%'")
    .get() as { n: number }
  expect(remaining.n).toBe(0)
})