import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Stable dashboard daemon: ensureDashboard spawns a detached child that survives
// opencode restarts; ping-based supervision reuses an already-live server.

const origHome = process.env.EVOLVE_HOME
const tmpHome = mkdtempSync(join(tmpdir(), "selfforge-daemon-"))

let rpc: typeof import("../plugin/selfforge/lib/rpc")
let freePort = 0

function portIsOpen(p: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${p}/api/ping`, { signal: AbortSignal.timeout(500) })
    .then((res) => res.status === 200)
    .catch(() => false)
}

beforeAll(async () => {
  process.env.EVOLVE_HOME = tmpHome
  const db = await import("../plugin/selfforge/lib/db")
  db.initDb()
  rpc = await import("../plugin/selfforge/lib/rpc")
  freePort = await new Promise<number>((resolve, reject) => {
    const net = require("node:net")
    const srv = net.createServer()
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port
      srv.close(() => resolve(p))
    })
    srv.on("error", reject)
  })
})

afterAll(() => {
  try {
    rpc.stopDashboard()
  } catch {}
  if (origHome === undefined) delete process.env.EVOLVE_HOME
  else process.env.EVOLVE_HOME = origHome
  try {
    rmSync(tmpHome, { recursive: true, force: true })
  } catch {}
})

test("GET /api/ping answers pong on the ephemeral server", async () => {
  const ep = await rpc.serveEphemeral()
  try {
    const res = await fetch(`http://127.0.0.1:${ep.port}/api/ping`)
    const body = (await res.json()) as { pong: boolean; pid: number }
    expect(res.status).toBe(200)
    expect(body.pong).toBe(true)
    expect(body.pid).toBeGreaterThan(0)
  } finally {
    ep.close()
  }
})

test("ensureDashboard spawns a detached daemon that survives and serves on a stable port", async () => {
  const r = await rpc.ensureDashboard(freePort)
  expect(r.port).toBe(freePort)
  expect(r.daemon).toBe(true)

  expect(await portIsOpen(freePort)).toBe(true)

  // A state file records the daemon pid + port for reuse/stop.
  const stateFile = join(tmpHome, "dashboard.json")
  expect(existsSync(stateFile)).toBe(true)
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as { port: number; pid: number }
  expect(state.port).toBe(freePort)
  expect(state.pid).toBeGreaterThan(0)
})

test("ensureDashboard reuses an already-running daemon instead of spawning a second one", async () => {
  const before = JSON.parse(readFileSync(join(tmpHome, "dashboard.json"), "utf8")) as { pid: number }
  const r2 = await rpc.ensureDashboard(freePort)
  expect(r2.port).toBe(freePort)
  expect(r2.daemon).toBe(true)
  const after = JSON.parse(readFileSync(join(tmpHome, "dashboard.json"), "utf8")) as { pid: number }
  expect(after.pid).toBe(before.pid)
})

test("stopDashboard kills the daemon and the port goes dark", async () => {
  const r = await rpc.stopDashboard()
  expect(r.ok).toBe(true)
  // Poll until the socket is released (process kill can take a moment).
  let dark = false
  for (let i = 0; i < 40; i++) {
    if (!(await portIsOpen(freePort))) {
      dark = true
      break
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  expect(dark).toBe(true)
  expect(existsSync(join(tmpHome, "dashboard.json"))).toBe(false)
})
