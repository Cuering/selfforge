import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// High-risk memory contamination fixtures (from the Agent-memory design notes):
// 1. stale memory must never override a current fact
// 2. scope must keep lessons from leaking across modules
// 3. expired memories must not be recalled
// 4. candidate memories must not reach recall or injected context
// 5. secrets / code snapshots must be rejected at write time
// 6. explicit statements bypass the candidate zone; inferred ones do not

const origHome = process.env.EVOLVE_HOME
const tmpHome = mkdtempSync(join(tmpdir(), "selfforge-fixtures-"))

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

const mem = async () => (await import("../plugin/selfforge/lib/memory")) as typeof import("../plugin/selfforge/lib/memory")
const db = async () => (await import("../plugin/selfforge/lib/db")) as typeof import("../plugin/selfforge/lib/db")

test("secrets and code snapshots are blocked at write time", async () => {
  const m = await mem()
  const r1 = m.isBlockedMemoryContent("use the token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz12345678 for pushes")
  expect(r1.blocked).toBe(true)
  const r2 = m.isBlockedMemoryContent("the api key is sk-1234567890abcdef1234567890abcdef")
  expect(r2.blocked).toBe(true)
  const r3 = m.isBlockedMemoryContent("```\nconst a = 1\nconst b = 2\n```\n" + "// file dump\n".repeat(60))
  expect(r3.blocked).toBe(true)
  const r4 = m.isBlockedMemoryContent("user prefers pnpm over npm")
  expect(r4.blocked).toBe(false)
})

test("blocked content never reaches the store via memoryAdd", async () => {
  const m = await mem()
  const before = m.memoryList({ limit: 500 }).length
  const res = m.memoryAdd("use api_key=abc123def456ghi789 for the deploy step")
  expect((res as { blocked?: boolean }).blocked).toBe(true)
  const after = m.memoryList({ limit: 500 }).length
  expect(after).toBe(before)
})

test("candidate memories are not recallable until confirmed", async () => {
  const m = await mem()
  const d = await db()
  d.getDb().query("DELETE FROM memories").run()
  m.memoryAdd("inferred: user may prefer quiet hotels for travel", { status: "candidate", confidence: 4 })
  const beforeRecall = m.memoryRecall("quiet hotels travel")
  expect(beforeRecall.length).toBe(0)
  const cands = m.memoryCandidates()
  expect(cands.length).toBe(1)
  m.memoryConfirm(cands[0].id)
  const afterRecall = m.memoryRecall("quiet hotels travel")
  expect(afterRecall.length).toBeGreaterThan(0)
})

test("expired memories are not recalled and get archived by decay", async () => {
  const m = await mem()
  const d = await db()
  d.getDb().query("DELETE FROM memories").run()
  const past = new Date(Date.now() - 1000 * 60).toISOString()
  m.memoryAdd("order 123 is still not delivered", { expires_at: past, status: "confirmed" })
  // still confirmed but expired -> excluded from recall
  const rec = m.memoryRecall("order delivered status")
  expect(rec.length).toBe(0)
  // decay archives it
  const res = m.memoryDecay({})
  expect(res.archived).toBeGreaterThan(0)
})

test("scope prevents cross-module leakage", async () => {
  const m = await mem()
  const d = await db()
  d.getDb().query("DELETE FROM memories").run()
  m.memoryAdd("payment service must start mock-bank before integration tests", {
    scope: "services/payment/**",
    status: "confirmed",
  })
  // scoped recall inside payment finds it
  const inside = m.memoryRecall("mock-bank payment integration", { scope: "services/payment/**" })
  expect(inside.length).toBeGreaterThan(0)
  // search module must not see payment's lesson
  const outside = m.memoryRecall("mock-bank payment integration", { scope: "services/search/**" })
  expect(outside.length).toBe(0)
})

test("confirmed-only injection: candidates never enter composed context", async () => {
  const m = await mem()
  const d = await db()
  d.getDb().query("DELETE FROM memories").run()
  m.memoryAdd("candidate-only lesson should not be injected", { status: "candidate" })
  m.memoryAdd("confirmed lesson is injected", { status: "confirmed" })
  const ctx = m.composeMemoryContext()
  expect(ctx).toContain("confirmed lesson is injected")
  expect(ctx).not.toContain("candidate-only lesson")
})

test("dedup merge promotes candidates to confirmed", async () => {
  const m = await mem()
  const d = await db()
  d.getDb().query("DELETE FROM memories").run()
  m.memoryAdd("always run tests before committing", { status: "candidate" })
  const r2 = m.memoryAddDedup("always run the test suite before committing code")
  expect(r2.merged).toBe(true)
  expect(r2.status).toBe("confirmed")
})
