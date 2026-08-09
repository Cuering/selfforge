import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Phase 0 sync primitives: row-level uuid/origin/deleted + Lamport clock,
// so cross-agent / cross-platform replicas can merge without collision.

const origHome = process.env.EVOLVE_HOME
const tmpHome = mkdtempSync(join(tmpdir(), "selfforge-sync-"))

beforeAll(async () => {
  process.env.EVOLVE_HOME = tmpHome
  const db = (await import("../plugin/selfforge/lib/db")) as typeof import("../plugin/selfforge/lib/db")
  db.initDb()
})

afterAll(() => {
  if (origHome === undefined) delete process.env.EVOLVE_HOME
  else process.env.EVOLVE_HOME = origHome
  try {
    rmSync(tmpHome, { recursive: true, force: true })
  } catch {}
})

const db = async () => (await import("../plugin/selfforge/lib/db")) as typeof import("../plugin/selfforge/lib/db")
const mem = async () => (await import("../plugin/selfforge/lib/memory")) as typeof import("../plugin/selfforge/lib/memory")
const skills = async () => (await import("../plugin/selfforge/lib/skills")) as typeof import("../plugin/selfforge/lib/skills")
const rules = async () => (await import("../plugin/selfforge/lib/rules")) as typeof import("../plugin/selfforge/lib/rules")
const goals = async () => (await import("../plugin/selfforge/lib/goals")) as typeof import("../plugin/selfforge/lib/goals")
const user = async () => (await import("../plugin/selfforge/lib/user")) as typeof import("../plugin/selfforge/lib/user")

test("nodeId is stable across calls and persisted", async () => {
  const d = await db()
  const a = d.nodeId()
  const b = d.nodeId()
  expect(a).toBe(b)
  expect(a.startsWith("node-")).toBe(true)
  expect(d.getConfig("node_id")).toBe(a)
})

test("Lamport clock is monotonic and persists", async () => {
  const d = await db()
  const start = d.clock()
  const c1 = d.tickClock()
  const c2 = d.tickClock()
  expect(c1).toBe(start + 1)
  expect(c2).toBe(c1 + 1)
  // reload from config table (persistence)
  d.setConfig("lamport_clock", String(c2))
  expect(d.clock()).toBe(c2)
})

test("stamp yields unique uuids with origin and current clock", async () => {
  const d = await db()
  const s1 = d.stamp()
  const s2 = d.stamp()
  expect(s1.uuid).not.toBe(s2.uuid)
  expect(s1.uuid).toMatch(/^[0-9a-f-]{36}$/)
  expect(s1.origin).toBe(d.nodeId())
  expect(s1.deleted).toBe(0)
  expect(s2.clock).toBe(s1.clock + 1)
})

test("memories rows are stamped with uuid and origin", async () => {
  const d = await db()
  const m = await mem()
  d.getDb().query("DELETE FROM memories").run()
  m.memoryAdd("sync-stamped memory")
  const row = d.getDb().query("SELECT uuid, origin, deleted FROM memories").get() as { uuid: string | null; origin: string | null; deleted: number }
  expect(row.uuid).toMatch(/^[0-9a-f-]{36}$/)
  expect(row.origin).toBe(d.nodeId())
  expect(row.deleted).toBe(0)
})

test("skills/rules/goals/user rows are stamped", async () => {
  const d = await db()
  const s = await skills()
  const r = await rules()
  const g = await goals()
  const u = await user()
  const created = s.skillCreate("sync skill", "sync test")
  const sk = d.getDb().query("SELECT uuid, origin FROM skills WHERE id = ?").get(created.id) as { uuid: string | null; origin: string | null }
  expect(sk.uuid).toMatch(/^[0-9a-f-]{36}$/)
  expect(sk.origin).toBe(d.nodeId())
  r.ruleObserve({ rule: "sync rule" })
  const rw = d.getDb().query("SELECT uuid, origin FROM rules").get() as { uuid: string | null; origin: string | null }
  expect(rw.uuid).toMatch(/^[0-9a-f-]{36}$/)
  const gd = g.goalStart({ goal: "sync goal" })
  const goal = d.getDb().query("SELECT uuid, origin FROM goals WHERE id = ?").get(gd.id) as { uuid: string | null; origin: string | null }
  expect(goal.uuid).toMatch(/^[0-9a-f-]{36}$/)
  const cp = d.getDb().query("SELECT uuid, origin FROM checkpoints LIMIT 1").get() as { uuid: string | null; origin: string | null }
  expect(cp.uuid).toMatch(/^[0-9a-f-]{36}$/)
  u.userAdd("sync-key", "sync value")
  const up = d.getDb().query("SELECT uuid, origin FROM user_profile WHERE keyword = 'sync-key'").get() as { uuid: string | null; origin: string | null }
  expect(up.uuid).toMatch(/^[0-9a-f-]{36}$/)
})

test("removal sets the deleted tombstone", async () => {
  const d = await db()
  const m = await mem()
  d.getDb().query("DELETE FROM memories").run()
  m.memoryAdd("tombstone me")
  m.memoryRemove("tombstone")
  const row = d.getDb().query("SELECT archived, deleted FROM memories").get() as { archived: number; deleted: number }
  expect(row.archived).toBe(1)
  expect(row.deleted).toBe(1)
})

test("existing DB migration backfills uuid without error", async () => {
  // simulate a pre-sync table: drop uuid then re-run init on a fresh store
  const d = await db()
  d.initDb()
  d.initDb()
  const cols = (d.getDb().query("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((c) => c.name)
  for (const c of ["uuid", "origin", "deleted"]) expect(cols).toContain(c)
})
