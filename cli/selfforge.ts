#!/usr/bin/env bun
/**
 * selfforge CLI — cross-agent / cross-platform transfer & management.
 *
 * Usage:
 *   bun cli/selfforge.ts status [--home <dir>]
 *   bun cli/selfforge.ts export <file.json> [--home <dir>]
 *   bun cli/selfforge.ts import <file.json> [--home <dir>] [--dry-run]
 *   bun cli/selfforge.ts serve --port <n> [--home <dir>]
 *
 * The core engine has zero opencode dependency, so this CLI works on any
 * machine with bun, pointing at an explicit EVOLVE_HOME (defaults to
 * ~/.evolve or $EVOLVE_HOME — same default as the plugin's db.ts).
 */
import { homedir } from "os"
import { join } from "path"
import { existsSync } from "fs"

const [sub] = process.argv.slice(2)
const args = process.argv.slice(3)

function opt(name: string, fallback: string): string {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

function resolveHome(): string {
  const env = opt("--home", process.env.EVOLVE_HOME || "")
  if (env) return env
  return join(homedir(), ".evolve")
}

function help() {
  console.log(
    `selfforge CLI — cross-agent memory transfer & local JSON-RPC

Usage:
  selfforge status                Show node id, Lamport clock, DB path
  selfforge export <file.json>    Write a portable snapshot
  selfforge import <file.json>    Merge a snapshot (per-uuid LWW)
  selfforge serve --port <n>      Run a local JSON-RPC endpoint
  selfforge team init <dir>       Init a team repo (optionally --remote <url>)
  selfforge team sync [<dir>]     Pull, merge, re-export, push
  selfforge eval [--k <n>]        Run the recall precision benchmark

Options:
  --home <dir>   Override EVOLVE_HOME (default ~/.config/opencode)
  --dry-run      With import, preview the merge without applying it
`
  )
}

async function main() {
  const home = resolveHome()
  // core modules read EVOLVE_HOME at import time — set it before importing
  process.env.EVOLVE_HOME = home
  const db = await import("../plugin/selfforge/lib/db")
  db.initDb()

  switch (sub) {
    case "status": {
      const { transferStatus } = await import("../plugin/selfforge/lib/transfer")
      console.log(JSON.stringify({ ...transferStatus(), home }, null, 2))
      break
    }
    case "export": {
      const file = args.find((a) => !a.startsWith("--"))
      if (!file) return help()
      const { exportSnapshot, saveSnapshotFile } = await import("../plugin/selfforge/lib/transfer")
      const out = saveSnapshotFile(exportSnapshot(), file)
      console.log(`exported to ${out}`)
      break
    }
    case "import": {
      const file = args.find((a) => !a.startsWith("--"))
      if (!file) return help()
      const { loadSnapshotFile, importSnapshot } = await import("../plugin/selfforge/lib/transfer")
      const snap = loadSnapshotFile(file)
      if (args.includes("--dry-run")) {
        const { mergeDecision } = await import("../plugin/selfforge/lib/transfer")
        const { nodeId } = await import("../plugin/selfforge/lib/db")
        const localNode = nodeId()
        const summary: Record<string, Record<string, number>> = {}
        for (const [t, rows] of Object.entries(snap.tables)) {
          summary[t] = { insert: 0, overwrite: 0, keep: 0, tombstone: 0 }
          for (const row of rows ?? []) {
            if (!row.uuid) continue
            const local = db
              .getDb()
              .query(`SELECT * FROM ${t} WHERE uuid = ?`)
              .get(String(row.uuid)) as Record<string, unknown> | undefined
            const d = mergeDecision(row, local, snap.node_id, localNode)
            summary[t][d as "insert"]++
          }
        }
        console.log(JSON.stringify({ dry_run: true, would_merge: summary }, null, 2))
      } else {
        const res = importSnapshot(snap)
        console.log(JSON.stringify({ merged: res }, null, 2))
      }
      break
    }
    case "team": {
      const sub2 = args[0]
      const { teamInit, teamSync, teamStatus } = await import("../plugin/selfforge/lib/sync")
      if (sub2 === "init") {
        const dir = args[1]
        if (!dir) return help()
        const remote = opt("--remote", "")
        console.log(JSON.stringify(teamInit(dir, remote ? { remote } : undefined), null, 2))
      } else if (sub2 === "sync") {
        const dir = args[1]
        const res = teamSync(dir ? { repo: dir } : undefined)
        console.log(JSON.stringify(res, null, 2))
      } else {
        console.log(JSON.stringify(teamStatus(), null, 2))
      }
      break
    }
    case "eval": {
      const { runRecallEval } = await import("../plugin/selfforge/lib/eval")
      const k = Number(opt("--k", "3"))
      console.log(JSON.stringify(runRecallEval({ k }), null, 2))
      break
    }
    case "serve": {
      const { serve } = await import("../plugin/selfforge/lib/rpc")
      const port = Number(opt("--port", "9210"))
      await serve(port)
      break
    }
    default:
      help()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
