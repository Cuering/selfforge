import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Phase 1 — decision repair (ported from MemOS `core/feedback` + `core/decision-repair`):
// deterministic feedback classification, failure-burst detection, cooldown, template drafts.

const origHome = process.env.EVOLVE_HOME
const tmpHome = mkdtempSync(join(tmpdir(), "selfforge-repair-"))

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

const repair = async () => (await import("../plugin/selfforge/lib/repair")) as typeof import("../plugin/selfforge/lib/repair")
const db = async () => (await import("../plugin/selfforge/lib/db")) as typeof import("../plugin/selfforge/lib/db")

function cleanSignals() {
  db().then((d) => d.getDb().query("DELETE FROM signals").run())
}
function cleanRepairs() {
  db().then((d) => d.getDb().query("DELETE FROM repairs").run())
}

test("classifyFeedback: preference 'use X instead of Y'", async () => {
  const r = await repair()
  const c = r.classifyFeedback("use pip instead of npm")
  expect(c.shape).toBe("preference")
  expect(c.prefer).toBe("pip")
  expect(c.avoid).toBe("npm")
})

test("classifyFeedback: 'prefer X over Y'", async () => {
  const r = await repair()
  const c = r.classifyFeedback("prefer pnpm over npm")
  expect(c.shape).toBe("preference")
  expect(c.prefer).toBe("pnpm")
  expect(c.avoid).toBe("npm")
})

test("classifyFeedback: negative", async () => {
  const r = await repair()
  expect(r.classifyFeedback("that's wrong, don't do that").shape).toBe("negative")
  expect(r.classifyFeedback("不要这样").shape).toBe("negative")
})

test("classifyFeedback: positive", async () => {
  const r = await repair()
  expect(r.classifyFeedback("great, that works, thanks!").shape).toBe("positive")
  expect(r.classifyFeedback("完美").shape).toBe("positive")
})

test("classifyFeedback: instruction and unknown", async () => {
  const r = await repair()
  expect(r.classifyFeedback("run npm install").shape).toBe("instruction")
  expect(r.classifyFeedback("the weather today").shape).toBe("unknown")
})

test("failure-burst: 3 failures with no success triggers repair", async () => {
  cleanSignals()
  cleanRepairs()
  const r = await repair()
  r.recordSignal("failure", "shell", "proj", "EXIT_CODE_1")
  r.recordSignal("failure", "shell", "proj", "EXIT_CODE_1")
  const res = r.runRepair({ trigger: "failure-burst", tool: "shell", context: "proj" })
  expect(res.ok).toBe(false) // only 2 failures < threshold 3
  r.recordSignal("failure", "shell", "proj", "EXIT_CODE_1")
  const res2 = r.runRepair({ trigger: "failure-burst", tool: "shell", context: "proj" })
  expect(res2.ok).toBe(true)
  if (res2.ok) {
    const draft = res2.draft
    expect(draft.antiPattern).toBeDefined()
    expect(draft.antiPattern).toContain("EXIT_CODE_1")
  }
})

test("anti-flap: success inside the window prevents a burst", async () => {
  cleanSignals()
  cleanRepairs()
  const r = await repair()
  r.recordSignal("failure", "shell", "proj")
  r.recordSignal("success", "shell", "proj")
  r.recordSignal("failure", "shell", "proj")
  const burst = r.checkBurst("shell", "proj")
  expect(burst.burst).toBe(false) // has a success in the window
  const res = r.runRepair({ trigger: "failure-burst", tool: "shell", context: "proj" })
  expect(res.ok).toBe(false)
  if (!res.ok) expect(res.reason).toBe("no-burst")
})

test("user.negative trigger bypasses burst and persists a repair", async () => {
  cleanRepairs()
  const r = await repair()
  const res = r.runRepair({ trigger: "user.negative", tool: "shell", userText: "this is wrong, don't use that flag" })
  expect(res.ok).toBe(true)
  if (res.ok) {
    const list = r.repairList({ status: "draft" })
    expect(list.length).toBeGreaterThan(0)
  }
})

test("cooldown blocks a repeat repair for the same scope", async () => {
  cleanRepairs()
  const d = await db()
  d.setConfig("repair_cooldown_ms", "86400000")
  const r = await repair()
  const first = r.runRepair({ trigger: "manual", tool: "shell", context: "proj" })
  expect(first.ok).toBe(true)
  const second = r.runRepair({ trigger: "manual", tool: "shell", context: "proj" })
  expect(second.ok).toBe(false)
  if (!second.ok) expect(second.reason).toBe("cooldown")
})

test("repairAccept returns guidance; repairReject tombstones", async () => {
  cleanRepairs()
  const r = await repair()
  const created = r.runRepair({ trigger: "manual", tool: "git", context: "proj", errCode: "CONFLICT" })
  expect(created.ok).toBe(true)
  if (created.ok) {
    const acc = r.repairAccept(created.repairId)
    expect(acc.accepted).toBe(true)
    expect(acc.guidance).toContain("CONFLICT")
    const rej = r.repairReject(created.repairId)
    expect(rej.rejected).toBe(true)
  }
})

test("repairStatus reports counts", async () => {
  cleanRepairs()
  const r = await repair()
  const st = r.repairStatus()
  expect(Array.isArray(st.byStatus)).toBe(true)
  expect(Array.isArray(st.drafts)).toBe(true)
})
