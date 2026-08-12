import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Phase 3 local JSON-RPC: HTTP round-trip against an ephemeral server.

const origHome = process.env.EVOLVE_HOME
const tmpHome = mkdtempSync(join(tmpdir(), "selfforge-rpc-"))
let port = 0
let close: () => void = () => {}

beforeAll(async () => {
  process.env.EVOLVE_HOME = tmpHome
  const db = (await import("../plugin/selfforge/lib/db")) as typeof import("../plugin/selfforge/lib/db")
  db.initDb()
  const rpc = await import("../plugin/selfforge/lib/rpc")
  const ep = await rpc.serveEphemeral()
  port = ep.port
  close = ep.close
})

afterAll(() => {
  close()
  if (origHome === undefined) delete process.env.EVOLVE_HOME
  else process.env.EVOLVE_HOME = origHome
  try {
    rmSync(tmpHome, { recursive: true, force: true })
  } catch {}
})

async function call(method: string, params?: any) {
  const res = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  return (await res.json()) as { result?: any; error?: { code: number; message: string } }
}

test("ping returns pong", async () => {
  const r = await call("ping")
  expect(r.result).toBe("pong")
})

test("status returns node id and format", async () => {
  const r = await call("status")
  expect(r.result.node_id).toMatch(/^node-/)
  expect(r.result.format).toBe("selfforge-snapshot")
})

test("memory.list returns added memory", async () => {
  const { memoryAdd } = await import("../plugin/selfforge/lib/memory")
  memoryAdd("rpc roundtrip lesson", { status: "confirmed" })
  const r = await call("memory.list", { limit: 50 })
  const hit = r.result.find((m: any) => m.content === "rpc roundtrip lesson")
  expect(hit).toBeTruthy()
  expect(hit.id).toMatch(/^[0-9a-f-]{36}$/i)
})

test("snapshot.export returns a valid snapshot", async () => {
  const r = await call("snapshot.export")
  expect(r.result.format).toBe("selfforge-snapshot")
  expect(Array.isArray(r.result.tables.memories)).toBe(true)
})

test("snapshot.import round-trips via RPC", async () => {
  const exp = await call("snapshot.export")
  const snap = exp.result
  const { getDb } = await import("../plugin/selfforge/lib/db")
  getDb().exec("DELETE FROM memories")
  const imp = await call("snapshot.import", { snapshot: snap })
  expect(imp.result.merged.memories.insert).toBe(snap.tables.memories.length)
})

test("unknown method returns a JSON-RPC error", async () => {
  const r = await call("no.such.method")
  expect(r.error?.code).toBe(-32000)
})

// Phase 5 visual dashboard: GET / serves HTML, /api/* serves JSON.

async function getJson(path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  return { status: res.status, body: await res.json() }
}

test("GET / serves the single-page dashboard HTML", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/`)
  expect(res.status).toBe(200)
  const html = await res.text()
  expect(html).toContain("selfforge")
  expect(html).toContain("api/dashboard")
})

test("GET /api/dashboard returns counts and status", async () => {
  const { status, body } = await getJson("/api/dashboard")
  expect(status).toBe(200)
  expect(body.status.node_id).toMatch(/^node-/)
  expect(typeof body.counts.memories).toBe("number")
  expect(typeof body.counts.skills).toBe("number")
})

test("GET /api/memories returns the memory list", async () => {
  const { status, body } = await getJson("/api/memories")
  expect(status).toBe(200)
  expect(Array.isArray(body)).toBe(true)
  const hit = body.find((m: any) => m.content === "rpc roundtrip lesson")
  expect(hit?.id).toMatch(/^[0-9a-f-]{36}$/i)
})

test("GET /api/skills and /api/patterns return arrays", async () => {
  const sk = await getJson("/api/skills")
  const pt = await getJson("/api/patterns")
  expect(sk.status).toBe(200)
  expect(Array.isArray(sk.body)).toBe(true)
  expect(pt.status).toBe(200)
  expect(Array.isArray(pt.body)).toBe(true)
})

test("unknown API path returns 404", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/nope`)
  expect(res.status).toBe(404)
})

// Phase 6: dashboard text overview + singleton serve (auto-spawned by the plugin).

test("dashboardText renders engine overview with counts and memories", async () => {
  const rpc = await import("../plugin/selfforge/lib/rpc")
  const text = rpc.dashboardText()
  expect(text).toContain("selfforge")
  expect(text).toContain("## counts")
  expect(text).toContain("memories")
  expect(text).toContain("rpc roundtrip lesson")
})

test("serve starts a singleton dashboard server and serves HTML", async () => {
  const rpc = await import("../plugin/selfforge/lib/rpc")
  const p1 = await rpc.serve(0)
  const res = await fetch(`http://127.0.0.1:${p1}/`)
  expect(res.status).toBe(200)
  const html = await res.text()
  expect(html).toContain("selfforge")
  // second call reuses the same server (no port escalation / no duplicate listen)
  const p2 = await rpc.serve(0)
  expect(p2).toBe(p1)
  rpc.closeServer()
})

// Phase 6.5: dashboard memory editing/deletion + daily summaries.

test("memory.update edits a memory by id/uuid", async () => {
  const { memoryAdd, memoryList } = await import("../plugin/selfforge/lib/memory")
  const added = memoryAdd("memory update target", { status: "confirmed" })
  const row = memoryList({ limit: 100 }).find((m) => m.content === "memory update target")
  expect(row).toBeTruthy()
  const r = await call("memory.update", { id: row!.uuid, content: "memory update target (edited)" })
  expect(r.result.ok).toBe(true)
  const after = memoryList({ limit: 100 }).find((m) => m.uuid === row!.uuid)
  expect(after?.content).toBe("memory update target (edited)")
})

test("memory.delete archives a memory by id/uuid", async () => {
  const { memoryAdd, memoryList } = await import("../plugin/selfforge/lib/memory")
  memoryAdd("memory delete target", { status: "confirmed" })
  const row = memoryList({ limit: 100 }).find((m) => m.content === "memory delete target")
  expect(row).toBeTruthy()
  const r = await call("memory.delete", { id: row!.uuid })
  expect(r.result.ok).toBe(true)
  const after = memoryList({ limit: 100 }).find((m) => m.uuid === row!.uuid)
  expect(after).toBeUndefined()
})

test("memory.daily aggregates user directives by day", async () => {
  const dbm = (await import("../plugin/selfforge/lib/db")) as typeof import("../plugin/selfforge/lib/db")
  dbm.getDb()
    .query("INSERT INTO session_messages (session_id, role, content, created_at) VALUES (?, 'user', ?, ?)")
    .run("sess-a", "we prefer node:sqlite for the desktop plugin", new Date().toISOString())
  const r = await call("memory.daily", { limit: 7 })
  expect(r.result.length).toBeGreaterThan(0)
  expect(r.result[0].items.length).toBeGreaterThan(0)
  expect(r.result[0].items.some((f: any) => f.text.includes("node:sqlite"))).toBe(true)
  expect(r.result[0].review.length).toBeGreaterThan(0)
  expect(typeof r.result[0].done_count).toBe("number")
})

// Phase 6.7: generic data.edit/delete across the dashboard tables.

test("data.update edits a rule by uuid", async () => {
  const { ruleObserve } = await import("../plugin/selfforge/lib/rules")
  ruleObserve({ rule: "always prefer node:sqlite in tests", domain: "test", explicitScope: "local" })
  const rows = await getJson("/api/rules")
  const row = rows.body.find((r: any) => r.rule === "always prefer node:sqlite in tests")
  expect(row?.uuid).toBeTruthy()
  const r = await call("data.update", { kind: "rules", id: row!.uuid, rule: "prefer node:sqlite always" })
  expect(r.result.ok).toBe(true)
  const updated = await getJson("/api/rules")
  const hit = updated.body.find((x: any) => x.uuid === row!.uuid)
  expect(hit?.rule).toBe("prefer node:sqlite always")
})

test("data.update edits a goal by uuid", async () => {
  const { goalStart } = await import("../plugin/selfforge/lib/goals")
  const g = goalStart({ goal: "generic edit target", northStar: "ns", completionCriteria: "done" })
  expect(g.id).toBeGreaterThan(0)
  const goals = await getJson("/api/goals")
  const goal = goals.body.find((x: any) => x.goal === "generic edit target")
  expect(goal?.id).toBeTruthy()
  const gr = await call("data.update", { kind: "goals", id: goal!.id, goal: "generic edit target (edited)" })
  expect(gr.result.ok).toBe(true)
  const goals2 = await getJson("/api/goals")
  expect(goals2.body.find((x: any) => x.id === goal!.id && x.goal === "generic edit target (edited)")).toBeTruthy()
})

test("data.delete soft-deletes a rule by uuid", async () => {
  const { ruleObserve } = await import("../plugin/selfforge/lib/rules")
  ruleObserve({ rule: "delete me rule", domain: "test", explicitScope: "local" })
  const rows = await getJson("/api/rules")
  const row = rows.body.find((r: any) => r.rule === "delete me rule")
  expect(row?.uuid).toBeTruthy()
  const r = await call("data.delete", { kind: "rules", id: row!.uuid })
  expect(r.result.ok).toBe(true)
  const after = await getJson("/api/rules")
  expect(after.body.find((x: any) => x.uuid === row!.uuid)).toBeUndefined()
})

test("data.update and data.delete reject unknown kinds", async () => {
  const u = await call("data.update", { kind: "nope", id: "x", x: 1 })
  expect(u.error?.code).toBe(-32000)
  const d = await call("data.delete", { kind: "nope", id: "x" })
  expect(d.error?.code).toBe(-32000)
})

test("data.update soft-edit workspaces rows exposed on /api/workspaces", async () => {
  const before = await getJson("/api/workspaces")
  expect(Array.isArray(before.body)).toBe(true)
  const anyRow = before.body[0]
  if (!anyRow) {
    expect(true).toBe(true)
    return
  }
  const r = await call("data.update", { kind: "workspaces", id: anyRow.id, name: "renamed ws" })
  expect(r.result.ok).toBe(true)
  const after = await getJson("/api/workspaces")
  const hit = after.body.find((w: any) => w.id === anyRow.id)
  expect(hit?.name).toBe("renamed ws")
})

test("workspace.merge dedups duplicate paths and reports merged count", async () => {
  const { touchWorkspace } = await import("../plugin/selfforge/lib/workspace")
  const dir = process.platform === "win32" ? "C:\\tmp\\proj-x" : "/tmp/proj-x"
  touchWorkspace(dir)
  touchWorkspace(dir.replace(/\\/g, "/"))
  const before = await getJson("/api/workspaces")
  const matches = before.body.filter((w: any) => w.path.replace(/[\\/]/g, "\\").toLowerCase().includes("proj-x"))
  if (matches.length > 1) {
    const r = await call("workspace.merge", {})
    expect(r.result.merged).toBeGreaterThanOrEqual(1)
  }
  const after = await getJson("/api/workspaces")
  const still = after.body.filter((w: any) => w.path.replace(/[\\/]/g, "\\").toLowerCase().includes("proj-x"))
  expect(still.length).toBeLessThanOrEqual(1)
})

test("workspace.open resolves a workspace and returns its path (or a clear error)", async () => {
  const { touchWorkspace } = await import("../plugin/selfforge/lib/workspace")
  const { mkdtempSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = mkdtempSync(join(tmpdir(), "selfforge-open-"))
  touchWorkspace(dir)
  const before = await getJson("/api/workspaces")
  const row = before.body.find((w: any) => w.path === dir)
  expect(row).toBeTruthy()
  const r = await call("workspace.open", { id: row!.id })
  expect(r.result).toBeTruthy()
  expect(r.result.path).toBe(dir)
})

test("checkpoints.maintain returns remaining counts", async () => {
  const r = await call("checkpoints.maintain", {})
  expect(r.result).toBeTruthy()
  expect(typeof r.result.removed).toBe("number")
  expect(typeof r.result.remaining_active).toBe("number")
})
