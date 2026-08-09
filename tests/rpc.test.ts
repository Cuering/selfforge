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
