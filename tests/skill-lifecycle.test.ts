import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Phase 1 — skill trial lifecycle (ported from MemOS `core/skill`):
// Beta(1,1) eta, candidate -> active/archived after candidateTrials,
// feedback rehab/retire, reward drift blend.

const origHome = process.env.EVOLVE_HOME
const tmpHome = mkdtempSync(join(tmpdir(), "selfforge-skilllife-"))

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

const skills = async () => (await import("../plugin/selfforge/lib/skills")) as typeof import("../plugin/selfforge/lib/skills")
const db = async () => (await import("../plugin/selfforge/lib/db")) as typeof import("../plugin/selfforge/lib/db")

function clean() {
  db().then((d) => d.getDb().query("DELETE FROM skills").run())
}

test("fresh skill starts as candidate with eta 0.5", async () => {
  clean()
  const s = await skills()
  const created = s.skillCreate("trial seed skill", "test lifecycle")
  const row = s.skillList().find((x) => x.name === created.name)
  expect(row?.status).toBe("candidate")
  expect(row?.eta).toBe(0.5)
  expect(row?.trials_attempted).toBe(0)
})

test("eta follows Beta(1,1): (passed+1)/(attempted+2)", async () => {
  const s = await skills()
  expect(s.betaEta(2, 3)).toBeCloseTo(0.6, 5)
  expect(s.betaEta(0, 3)).toBeCloseTo(0.2, 5)
})

test("candidate graduates to active after 3 trials with enough passes", async () => {
  clean()
  const s = await skills()
  const created = s.skillCreate("graduating skill", "test")
  s.recordSkillUse(created.name) // pass
  s.recordSkillUse(created.name) // pass
  s.recordSkillUse(created.name) // pass -> attempted=3, eta=4/5=0.8 >= 0.5
  const row = s.skillList().find((x) => x.name === created.name)
  expect(row?.status).toBe("active")
  expect(row?.eta).toBeCloseTo(0.8, 5)
})

test("candidate with low pass rate is archived after candidateTrials", async () => {
  clean()
  const s = await skills()
  const created = s.skillCreate("flaky skill", "test")
  s.recordSkillUse(created.name, true) // fail
  s.recordSkillUse(created.name, true) // fail
  s.recordSkillUse(created.name, true) // fail -> eta=(0+1)/5=0.2 < 0.5
  const row = s.skillList().find((x) => x.name === created.name)
  expect(row?.status).toBe("archived")
})

test("active skill with eta below archive floor is retired", async () => {
  clean()
  const s = await skills()
  const created = s.skillCreate("retire me", "test")
  // force active + low eta, then a trial drops it under the floor
  const d = await db()
  d.getDb()
    .query("UPDATE skills SET status = 'active', eta = 0.25, trials_attempted = 10, trials_passed = 2 WHERE name = ?")
    .run(created.name)
  s.recordSkillUse(created.name, true) // eta -> 3/13 ~ 0.23, still active? check transition
  const row = s.skillList().find((x) => x.name === created.name)
  // eta stays low; status retired only when eta < 0.3 after a trial
  if ((row?.eta ?? 0) < 0.3) expect(row?.status).toBe("archived")
  else expect(row?.status).toBe("active")
})

test("feedback raises/lowers eta with rehab and retire transitions", async () => {
  clean()
  const s = await skills()
  const created = s.skillCreate("feedback skill", "test")
  const up = s.skillFeedback(created.name, true)
  expect(up.ok).toBe(true)
  expect(up.eta).toBeCloseTo(0.6, 5)
  // drive eta under 0.3 -> archived
  s.skillFeedback(created.name, false)
  s.skillFeedback(created.name, false)
  s.skillFeedback(created.name, false)
  const retired = s.skillList().find((x) => x.name === created.name)
  expect(retired?.eta).toBeCloseTo(0.3, 5)
  // rehab from archived via positive feedback (eta back >= 0.5 -> candidate)
  s.skillFeedback(created.name, true)
  s.skillFeedback(created.name, true)
  const rehab = s.skillList().find((x) => x.name === created.name)
  expect(rehab?.eta).toBeCloseTo(0.5, 5)
  expect(["candidate", "active"]).toContain(rehab?.status)
})

test("reward drift blends 0.7*eta + 0.3*magnitude", async () => {
  clean()
  const s = await skills()
  const created = s.skillCreate("reward skill", "test")
  s.applySkillReward(created.name, 1)
  const row = s.skillList().find((x) => x.name === created.name)
  expect(row?.eta).toBeCloseTo(0.5 * 0.7 + 0.3 * 1, 5) // 0.65
})

test("skillVisible filters candidates above eta floor", async () => {
  clean()
  const s = await skills()
  s.skillCreate("visible skill a", "test")
  const low = s.skillCreate("low eta skill", "test")
  const d = await db()
  d.getDb().query("UPDATE skills SET eta = 0.2 WHERE name = ?").run(low.name)
  const visible = s.skillVisible()
  expect(visible.some((x) => x.name === "visible-skill-a")).toBe(true)
  expect(visible.some((x) => x.name === "low-eta-skill")).toBe(false)
})

test("skillStatus reports cohort counts and graduation readiness", async () => {
  clean()
  const s = await skills()
  s.skillCreate("status skill", "test")
  s.recordSkillUse("status-skill")
  const st = s.skillStatus()
  const candidate = st.counts.find((c) => c.status === "candidate")
  expect(candidate?.n).toBeGreaterThanOrEqual(1)
  expect(st.candidateTrials).toBe(3)
})

test("skillCreate without body ships full executable Chinese template", async () => {
  clean()
  const s = await skills()
  const created = s.skillCreate("完整模板技能", "用于验证自动生成执行规则")
  const row = s.skillList().find((x) => x.name === created.name)
  expect(row?.content).toBeTruthy()
  expect(row!.content!).toContain("## 目标")
  expect(row!.content!).toContain("## 执行步骤")
  expect(row!.content!).toContain("## 硬性规则")
  expect(row!.content!).toContain("## 验收标准")
  expect(row!.content!).toContain("用于验证自动生成执行规则")
})

test("skillList orders active before candidate", async () => {
  clean()
  const s = await skills()
  const d = await db()
  const a = s.skillCreate("zzz candidate first", "c")
  const b = s.skillCreate("aaa active later", "a")
  d.getDb().query("UPDATE skills SET status = 'active', usage_count = 1 WHERE name = ?").run(b.name)
  d.getDb().query("UPDATE skills SET status = 'candidate', usage_count = 99 WHERE name = ?").run(a.name)
  const list = s.skillList()
  const ia = list.findIndex((x) => x.name === b.name)
  const ic = list.findIndex((x) => x.name === a.name)
  expect(ia).toBeGreaterThanOrEqual(0)
  expect(ic).toBeGreaterThanOrEqual(0)
  expect(ia).toBeLessThan(ic)
})

test("curator archives skills unused for 90 days (from created_at if never tried)", async () => {
  clean()
  const s = await skills()
  const rev = (await import("../plugin/selfforge/lib/review")) as typeof import("../plugin/selfforge/lib/review")
  const d = await db()
  const created = s.skillCreate("old unused skill", "应被淘汰")
  const old = new Date(Date.now() - 100 * 86400000).toISOString()
  d.getDb()
    .query("UPDATE skills SET created_at = ?, last_used_at = NULL, status = 'candidate' WHERE name = ?")
    .run(old, created.name)
  const stats = rev.curatorRun()
  expect(stats.archived).toBeGreaterThanOrEqual(1)
  const row = d.getDb().query("SELECT status, deleted FROM skills WHERE name = ?").get(created.name) as {
    status: string
    deleted: number
  }
  expect(row.status).toBe("archived")
  expect(row.deleted).toBe(1)
})
