#!/usr/bin/env node
/**
 * selfforge detached dashboard daemon.
 *
 * Serves the web dashboard + JSON-RPC on a stable localhost port, independently
 * of any opencode process. The plugin supervisor (ensureDashboard in rpc.ts)
 * spawns this detached child, probes it with GET /api/ping, and reuses it across
 * opencode restarts — so the browser dashboard stays connected and the port does
 * not drift when background housekeeping (decay/merge/maintain/vacuum) writes to
 * the same SQLite store.
 *
 * Run standalone:
 *   bun plugin/selfforge/serve-daemon.ts          (CLI, Bun)
 *   node plugins/compiled/serve-daemon.js         (desktop, Node via build)
 *
 * Env:
 *   SELFFORGE_PORT   port to bind (default 9210)
 *   EVOLVE_HOME      data dir (defaults to ~/.evolve, same as db.ts)
 */
import { homedir } from "node:os"
import { join } from "node:path"
import { writeFileSync } from "node:fs"

process.env.EVOLVE_HOME ||= join(homedir(), ".evolve")

const { initDb } = await import("./lib/db")
const { serve } = await import("./lib/rpc")

const port = Number(process.env.SELFFORGE_PORT || 9210)
const stateFile = join(process.env.EVOLVE_HOME, "dashboard.json")

initDb()

try {
  const actual = await serve(port)
  writeFileSync(stateFile, JSON.stringify({ port: actual, pid: process.pid, started_at: new Date().toISOString() }))
  console.log(`selfforge daemon: http://127.0.0.1:${actual} (pid ${process.pid})`)
} catch (err) {
  console.error("selfforge daemon failed:", (err as Error).message)
  process.exit(1)
}

// Keep the process alive until explicitly killed by stopDashboard()/SIGTERM.
process.on("SIGTERM", () => process.exit(0))
process.on("SIGINT", () => process.exit(0))
