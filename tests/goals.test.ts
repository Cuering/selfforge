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

test("goalStatus reflects live checkpoints only (no tombstones)", () => {
  const g = goals.goalStart({ goal: "cp dedupe test", northStar: "ns", completionCriteria: "done" })
  // mark CP0/CP0.5 done, then maintain tombstones them
  goals.goalCheckpoint({ goalId: g.id, cp: "CP0", status: "done", notes: "x" })
  goals.goalCheckpoint({ goalId: g.id, cp: "CP0.5", status: "done", notes: "y" })
  const m = goals.maintainCheckpoints()
  expect(m.removed).toBeGreaterThan(0)
  const st = goals.goalStatus(g.id)
  expect(st).toBeTruthy()
  if ("error" in st) throw new Error(String(st.error))
  const cps = st.checkpoints
  const cp0 = cps.find((c: any) => c.cp === "CP0")
  // Tombstoned rows must not leak into goalStatus
  expect(cp0).toBeUndefined()
  expect(cps.some((c: any) => c.deleted === 1)).toBe(false)
})

test("re-logging a tombstoned CP revives it, does not duplicate", () => {
  const g = goals.goalStart({ goal: "cp revive test", northStar: "ns", completionCriteria: "done" })
  goals.goalCheckpoint({ goalId: g.id, cp: "CP1", status: "done", notes: "first" })
  goals.maintainCheckpoints() // tombstones the done CP1
  const before = goals.goalCheckpoints(g.id).length
  expect(goals.goalCheckpoints(g.id).find((c: any) => c.cp === "CP1")).toBeUndefined()

  goals.goalCheckpoint({ goalId: g.id, cp: "CP1", status: "done", notes: "revived" })
  const after = goals.goalCheckpoints(g.id)
  const cp1s = after.filter((c: any) => c.cp === "CP1")
  expect(cp1s.length).toBe(1) // revived, not duplicated
  expect(cp1s[0].notes).toBe("revived")
  expect(cp1s[0].deleted).toBe(0)
  expect(after.length).toBe(before + 1)
})

test("maintainCheckpoints preserves created_at timestamps", () => {
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
  expect(after.deleted).toBe(1)
})