import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const origHome = process.env.EVOLVE_HOME
const tmpHome = mkdtempSync(join(tmpdir(), "selfforge-test-"))

beforeAll(async () => {
  process.env.EVOLVE_HOME = tmpHome
  // modules cache EVOLVE_HOME at import time, so import fresh here
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

test("db schema is idempotent", async () => {
  const db = (await import("../plugin/selfforge/lib/db")) as typeof import("../plugin/selfforge/lib/db")
  db.initDb()
  db.initDb()
  const tables = db.getDb().query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  const names = tables.map((t) => t.name)
  for (const t of ["config", "memories", "user_profile", "skills", "rules", "goals", "checkpoints", "evolution", "observations", "sessions", "session_messages"]) {
    expect(names).toContain(t)
  }
  const fts = db.getDb().query("SELECT name FROM sqlite_master WHERE type='table' AND name='session_messages_fts'").all()
  expect(fts.length).toBe(1)
})

test("memory add / list / strengthen / recall", async () => {
  const db = (await import("../plugin/selfforge/lib/db")) as typeof import("../plugin/selfforge/lib/db")
  db.getDb().query("DELETE FROM memories").run()
  const m = (await import("../plugin/selfforge/lib/memory")) as typeof import("../plugin/selfforge/lib/memory")
  m.memoryAdd("User prefers TypeScript over JavaScript for all new projects")
  m.memoryAdd("Deploy uses GitHub Actions with pnpm caching")
  const all = m.memoryList({ limit: 10 })
  expect(all.length).toBe(2)
  const rec = m.memoryRecall("TypeScript JavaScript projects")
  expect(rec.length).toBeGreaterThan(0)
  expect(rec[0].content).toContain("TypeScript")
  m.memoryStrengthen("TypeScript")
  const rec2 = m.memoryRecall("TypeScript", { minScore: 1 })
  expect(rec2.length).toBeGreaterThan(0)
})

test("memoryAddDedup merges near-duplicates", async () => {
  const db = (await import("../plugin/selfforge/lib/db")) as typeof import("../plugin/selfforge/lib/db")
  db.getDb().query("DELETE FROM memories").run()
  const m = (await import("../plugin/selfforge/lib/memory")) as typeof import("../plugin/selfforge/lib/memory")
  m.memoryAdd("always run tests before committing")
  const r2 = m.memoryAddDedup("always run the test suite before committing code")
  expect(r2.merged).toBe(true)
  expect(m.memoryList({ limit: 10 }).length).toBe(1)
  const r3 = m.memoryAddDedup("completely unrelated fact about coffee")
  expect(r3.merged).toBe(false)
})

test("memoryDecay decays strength and archives very old ones", async () => {
  const db = (await import("../plugin/selfforge/lib/db")) as typeof import("../plugin/selfforge/lib/db")
  db.getDb().query("DELETE FROM memories").run()
  const m = (await import("../plugin/selfforge/lib/memory")) as typeof import("../plugin/selfforge/lib/memory")
  m.memoryAdd("stale lesson that will decay")
  const row = db.getDb().query("SELECT * FROM memories").get() as { id: number; last_reinforced_at: string; strength: number }
  // age it well beyond the archive threshold (strength 1, 120+ days inactive)
  const old = new Date(Date.now() - 130 * 86400000).toISOString()
  db.getDb().query("UPDATE memories SET last_reinforced_at = ?, last_accessed_at = ? WHERE id = ?").run(old, old, row.id)
  const res = m.memoryDecay({ archiveDays: 120, demoteDays: 30 })
  // strength 1 + 130d -> archived (not merely decayed)
  const after = db.getDb().query("SELECT archived, strength FROM memories WHERE id = ?").get(row.id) as { archived: number; strength: number }
  expect(after.archived).toBe(1)
})

test("memoryStrengthen promotes lifecycle after enough accesses", async () => {
  const db = (await import("../plugin/selfforge/lib/db")) as typeof import("../plugin/selfforge/lib/db")
  db.getDb().query("DELETE FROM memories").run()
  const m = (await import("../plugin/selfforge/lib/memory")) as typeof import("../plugin/selfforge/lib/memory")
  m.memoryAdd("frequently revisited important lesson")
  const id = (db.getDb().query("SELECT id FROM memories").get() as { id: number }).id
  for (let i = 0; i < 16; i++) m.memoryStrengthen("frequently revisited")
  // temporary -> active at 15 accesses; 16 accesses stays active (permanent needs 30)
  const after = db.getDb().query("SELECT lifecycle, access_count FROM memories WHERE id = ?").get(id) as { lifecycle: string; access_count: number }
  expect(after.access_count).toBeGreaterThanOrEqual(16)
  expect(after.lifecycle).toBe("active")
})

test("memoryBrief reports distribution and health", async () => {
  const db = (await import("../plugin/selfforge/lib/db")) as typeof import("../plugin/selfforge/lib/db")
  db.getDb().query("DELETE FROM memories").run()
  const m = (await import("../plugin/selfforge/lib/memory")) as typeof import("../plugin/selfforge/lib/memory")
  m.memoryAdd("prefers git over svn", { type: "preference" })
  m.memoryAdd("use pnpm workspaces", { type: "instruction", importance: 8 })
  const brief = m.memoryBrief()
  expect(brief.active).toBe(2)
  expect(brief.byType["preference"]).toBe(1)
  expect(brief.byType["instruction"]).toBe(1)
  expect(brief.addedToday).toBe(2)
})

test("social-closer filter", async () => {
  const r = (await import("../plugin/selfforge/lib/review")) as typeof import("../plugin/selfforge/lib/review")
  expect(r.isTrivial("thanks")).toBe(true)
  expect(r.isTrivial("👍👍")).toBe(true)
  expect(r.isTrivial("ok")).toBe(true)
  expect(r.isTrivial("")).toBe(true)
  expect(r.isTrivial("Please refactor the auth module to use OAuth2")).toBe(false)
})

test("session buffer + FTS5 session search", async () => {
  const db = (await import("../plugin/selfforge/lib/db")) as typeof import("../plugin/selfforge/lib/db")
  db.getDb().query("DELETE FROM sessions").run()
  db.getDb().query("DELETE FROM session_messages").run()
  db.getDb().query("DELETE FROM session_messages_fts").run()
  const r = (await import("../plugin/selfforge/lib/review")) as typeof import("../plugin/selfforge/lib/review")
  const s = r.getSession("test-session")
  r.bufferPush(s, { role: "user", content: "we decided to use Postgres for the new analytics service" })
  r.bufferPush(s, { role: "assistant", content: "Postgres it is, with pgvector for embeddings" })
  const hits = r.sessionSearch("Postgres analytics")
  expect(hits.length).toBeGreaterThan(0)
  const miss = r.sessionSearch("unrelated-unique-topic-xyz")
  expect(miss.length).toBe(0)
})

test("skill create/list/usage", async () => {
  const s = (await import("../plugin/selfforge/lib/skills")) as typeof import("../plugin/selfforge/lib/skills")
  const created = s.skillCreate("Run Tests Before Commit", "Always run tests before committing")
  expect(created.name).toBe("run-tests-before-commit")
  s.recordSkillUse(created.name)
  const list = s.skillList()
  expect(list.find((x) => x.name === created.name)?.usage_count).toBe(1)
})

test("goal lifecycle CP0 -> complete", async () => {
  const g = (await import("../plugin/selfforge/lib/goals")) as typeof import("../plugin/selfforge/lib/goals")
  const start = g.goalStart({ goal: "ship v2", northStar: "users happy", completionCriteria: "tests green" })
  expect(start.status).toBe("active")
  g.goalCheckpoint({ goalId: start.id, cp: "CP0", status: "done" })
  g.goalCheckpoint({ goalId: start.id, cp: "CP3", status: "done" })
  const status = g.goalStatus(start.id)
  expect(status.status).toBe("active")
  g.goalComplete(start.id)
  expect(g.goalStatus(start.id).status).toBe("completed")
})

test("rule observe -> escalate dryRun", async () => {
  const rl = (await import("../plugin/selfforge/lib/rules")) as typeof import("../plugin/selfforge/lib/rules")
  const observed = rl.ruleObserve({ rule: "always use spaces not tabs", domain: "code-style" })
  expect(observed.recommendation).toBe("write-project")
  rl.ruleObserve({ rule: "always use spaces not tabs", domain: "code-style" })
  const status = rl.ruleStatus()
  expect(status.find((r) => r.rule.includes("spaces"))?.total_count).toBe(2)
  const esc = rl.escalate({ dryRun: true })
  expect(esc.results.length).toBeGreaterThan(0)
})
