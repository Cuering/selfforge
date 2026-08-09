import { tool } from "@opencode-ai/plugin"
import { exportSnapshotJson, importSnapshot, saveSnapshotFile, loadSnapshotFile, transferStatus, exportSnapshot } from "../transfer"
import { logObs } from "../db"

export const transferTools = {
  transfer_export: tool({
    description:
      "Export the entire memory store as a portable selfforge snapshot (JSON file). Use to move knowledge to another machine, agent or platform. The snapshot carries per-row uuid/origin/deleted identity and can be re-imported elsewhere.",
    args: {
      file: tool.schema.string().optional().describe("Output path; defaults to <EVOLVE_HOME>/snapshot.json"),
    },
    async execute(args, ctx) {
      const snap = exportSnapshot()
      const file = args.file ?? `${process.env.EVOLVE_HOME || "."}/snapshot-${Date.now()}.json`
      saveSnapshotFile(snap, file)
      logObs("transfer_export", { file, tables: Object.keys(snap.tables) }, ctx.directory)
      return {
        output: JSON.stringify(
          {
            ok: true,
            file,
            node_id: snap.node_id,
            clock: snap.clock,
            rows: Object.fromEntries(Object.entries(snap.tables).map(([t, rows]) => [t, rows.length])),
          },
          null,
          2
        ),
      }
    },
  }),

  transfer_import: tool({
    description:
      "Import a selfforge snapshot file as a per-uuid last-write-wins merge. Rows newer than local copies overwrite them; tombstones delete local rows; unchanged rows are kept. Safe to run repeatedly.",
    args: {
      file: tool.schema.string().describe("Path to a selfforge snapshot JSON file"),
    },
    async execute(args, ctx) {
      const snap = loadSnapshotFile(args.file)
      const res = importSnapshot(snap)
      logObs("transfer_import", { file: args.file, res }, ctx.directory)
      return { output: JSON.stringify({ ok: true, file: args.file, merged: res }, null, 2) }
    },
  }),

  transfer_preview: tool({
    description:
      "Show what importing a snapshot would do WITHOUT applying it (dry-run). Returns per-table decision counts.",
    args: { file: tool.schema.string().describe("Path to a selfforge snapshot JSON file") },
    async execute(args) {
      const snap = loadSnapshotFile(args.file)
      const { mergeDecision } = await import("../transfer")
      const { getDb } = await import("../db")
      const localNode = (await import("../db")).nodeId()
      const db = getDb()
      const tables: string[] = Object.keys(snap.tables)
      const out: Record<string, Record<string, number>> = {}
      for (const t of tables) {
        const counts = { insert: 0, overwrite: 0, keep: 0, tombstone: 0 }
        for (const row of snap.tables[t] ?? []) {
          if (!row.uuid) continue
          const local = db.query(`SELECT * FROM ${t} WHERE uuid = ?`).get(String(row.uuid)) as Record<string, unknown> | undefined
          const d = mergeDecision(row, local, snap.node_id, localNode)
          counts[d as "insert"]++
        }
        out[t] = counts
      }
      return { output: JSON.stringify({ ok: true, file: args.file, would_merge: out }, null, 2) }
    },
  }),

  transfer_status: tool({
    description: "Show transfer/identity info: node id, Lamport clock, DB path.",
    args: {},
    async execute() {
      return { output: JSON.stringify(transferStatus(), null, 2) }
    },
  }),
}
