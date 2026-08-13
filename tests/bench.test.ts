import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const origHome = process.env.EVOLVE_HOME
const tmpHome = mkdtempSync(join(tmpdir(), "selfforge-bench-"))

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

const bench = async () => (await import("../plugin/selfforge/lib/bench")) as typeof import("../plugin/selfforge/lib/bench")

test("Add persists messages synchronously and echoes ids", async () => {
  const b = await bench()
  const res = b.benchAdd({
    request_id: "eval:run_x:conv-0:chunk-0",
    messages: [
      { role: "user", timestamp: 1704067200000, content: "the user prefers dark mode in the editor" },
      { role: "assistant", content: "I will remember that preference" },
    ],
    user_id: "eval:run_x:conv-0",
    session_id: "eval:run_x:sample:0",
  })
  expect(res.success).toBe(true)
  expect(res.request_id).toBe("eval:run_x:conv-0:chunk-0")
  expect(res.user_id).toBe("eval:run_x:conv-0")
  expect(res.session_id).toBe("eval:run_x:sample:0")
  expect(res.stored).toBe(2)
})

test("Search isolates by user_id and ranks by relevance", async () => {
  const b = await bench()
  const { getDb } = await import("../plugin/selfforge/lib/db")
  // Add distinct memories for two users
  b.benchAdd({ request_id: "a1", messages: [{ role: "user", content: "user A prefers pnpm over npm" }], user_id: "userA", session_id: "sA" })
  b.benchAdd({ request_id: "b1", messages: [{ role: "user", content: "user B uses docker for deploys" }], user_id: "userB", session_id: "sB" })
  const res = await b.benchSearch({ query: "pnpm package manager", user_id: "userA", top_k: 100 })
  expect(res.data.length).toBeGreaterThan(0)
  expect(res.data[0].content).toContain("pnpm")
  // user isolation: userB's data must NOT leak into userA search
  const allContent = res.data.map((d: any) => d.content).join(" ")
  expect(allContent).not.toContain("docker")
  expect(res.data[0].score).toBeGreaterThan(0)
})

test("Search empty query returns latest memories", async () => {
  const b = await bench()
  const res = await b.benchSearch({ query: "", user_id: "userA", top_k: 10 })
  expect(Array.isArray(res.data)).toBe(true)
})

test("Search respects top_k", async () => {
  const b = await bench()
  b.benchAdd({ request_id: "m1", messages: [{ role: "user", content: "alpha beta gamma delta epsilon zeta eta theta iota kappa sigma upsilon phi chi psi omega omicron actor agent alpha" }], user_id: "userC", session_id: "sC1" })
  const res = await b.benchSearch({ query: "alpha memory", user_id: "userC", top_k: 100 })
  expect(res.data.length).toBeGreaterThan(0)
  const res2 = await b.benchSearch({ query: "alpha", user_id: "userC", top_k: 1 })
  expect(res2.data.length).toBeLessThanOrEqual(1)
})

test("benchClear marks all memories for a user deleted", async () => {
  const b = await bench()
  b.benchAdd({ request_id: "c1", messages: [{ role: "user", content: "temporary test memory" }], user_id: "userD", session_id: "sD" })
  const cleared = b.benchClear("userD")
  expect(cleared.cleared).toBeGreaterThanOrEqual(1)
  const res = await b.benchSearch({ query: "temporary", user_id: "userD" })
  expect(res.data.length).toBe(0)
})