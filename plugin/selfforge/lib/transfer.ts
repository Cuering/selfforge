import { getDb, nodeId, clock, advanceClockTo, EVOLVE_HOME, DB_PATH } from "./db"

/**
 * Phase 3 — cross-agent / cross-platform transfer.
 *
 * A snapshot is the entire sync-able store serialized as a portable JSON
 * blob: every row of every SYNC_TABLE (with row-level uuid/origin/deleted
 * identity from Phase 0) plus the node id, Lamport clock and schema
 * version. It can be moved between machines, agents or platforms by file,
 * pipe or clipboard.
 *
 * Importing is a per-uuid last-write-wins merge: rows whose local
 * updated_at/clock is older than the snapshot row are overwritten (or
 * resurrected from a tombstone); rows the snapshot doesn't know about are
 * left untouched. This is the same merge used by Phase 4's git sync, so
 * the exchange format is identical.
 */

const SYNC_TABLES = ["memories", "skills", "rules", "goals", "checkpoints", "evolution", "observations", "user_profile", "signals", "repairs", "pattern_signatures"] as const

export type TransferRow = {
  [col: string]: unknown
}

export type Snapshot = {
  format: "selfforge-snapshot"
  version: number
  created_at: string
  node_id: string
  clock: number
  tables: Record<string, TransferRow[]>
}

export const SNAPSHOT_FORMAT = "selfforge-snapshot" as const
export const SNAPSHOT_VERSION = 1

function tableColumns(table: string): string[] {
  const rows = getDb().query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

/** Serialize the whole store into a portable snapshot. */
export function exportSnapshot(): Snapshot {
  const db = getDb()
  const tables: Record<string, TransferRow[]> = {}
  for (const t of SYNC_TABLES) {
    const cols = tableColumns(t)
    const rows = db.query(`SELECT * FROM ${t}`).all() as TransferRow[]
    tables[t] = rows.map((r) => {
      const out: TransferRow = {}
      for (const c of cols) out[c] = r[c]
      return out
    })
  }
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    created_at: new Date().toISOString(),
    node_id: nodeId(),
    clock: clock(),
    tables,
  }
}

export function exportSnapshotJson(): string {
  return JSON.stringify(exportSnapshot(), null, 2)
}

/** Per-row LWW merge decision given a snapshot row and the local row. */
export function mergeDecision(
  snap: TransferRow,
  local: TransferRow | undefined,
  snapNode: string,
  localNode: string
): "insert" | "overwrite" | "keep" | "tombstone" {
  // snapshot row is a tombstone -> local must delete too (if present)
  if ((snap.deleted as number) === 1) return local ? "tombstone" : "insert"
  if (!local) return "insert"
  // LWW: compare updated_at (ISO, lexicographically ordered); tie-break by
  // origin node id to stay deterministic across replicas.
  const sT = String(snap.updated_at ?? snap.created_at ?? "")
  const lT = String(local.updated_at ?? local.created_at ?? "")
  if (sT !== lT) return sT > lT ? "overwrite" : "keep"
  return snapNode > localNode ? "overwrite" : "keep"
}

/**
 * Import a snapshot as a per-uuid LWW merge. Mutates the local store in
 * place; returns per-table counts of {insert, overwrite, keep, tombstone}.
 */
export function importSnapshot(snap: Snapshot): Record<string, { insert: number; overwrite: number; keep: number; tombstone: number }> {
  if (snap.format !== SNAPSHOT_FORMAT) throw new Error(`bad snapshot format: ${String(snap.format)}`)
  const db = getDb()
  const snapNode = snap.node_id
  const localNode = nodeId()
  const result: Record<string, { insert: number; overwrite: number; keep: number; tombstone: number }> = {}
  for (const t of SYNC_TABLES) {
    const rows = (snap.tables?.[t] ?? []) as TransferRow[]
    result[t] = { insert: 0, overwrite: 0, keep: 0, tombstone: 0 }
    if (rows.length === 0) continue
    const cols = tableColumns(t)
    const byUuid = new Map<string, TransferRow>()
    for (const r of rows) if (r.uuid) byUuid.set(String(r.uuid), r)
    // look up every referenced uuid locally once
    const existing = new Map<string, TransferRow>()
    for (const uuid of byUuid.keys()) {
      const row = db.query(`SELECT * FROM ${t} WHERE uuid = ?`).get(uuid) as TransferRow | undefined
      if (row) existing.set(uuid, row)
    }
    const colList = cols.join(", ")
    const placeholders = cols.map(() => "?").join(", ")
    for (const [uuid, snapRow] of byUuid) {
      const local = existing.get(uuid)
      const decision = mergeDecision(snapRow, local, snapNode, localNode)
      result[t][decision]++
      if (decision === "keep") continue
      if (decision === "insert" || decision === "overwrite" || decision === "tombstone") {
        const values = cols.map((c) => {
          let v = snapRow[c]
          // ensure identity fields are stamped even if the source omitted them
          if (c === "uuid" && v == null) v = uuid
          if (c === "origin" && v == null) v = snapNode
          if (c === "created_at" && v == null) v = snap.created_at
          if (c === "updated_at" && v == null) v = snap.created_at
          return v
        })
        // delete first so INSERT is idempotent on the unique uuid index
        db.query(`DELETE FROM ${t} WHERE uuid = ?`).run(uuid)
        db.query(`INSERT INTO ${t} (${colList}) VALUES (${placeholders})`).run(...values)
      }
    }
  }
  // advance the local Lamport clock past the snapshot's, preserving monotonic
  // ordering for future stamps (a peer may have written rows at a later clock)
  advanceClockTo(Number(snap.clock ?? 0) + 1)
  return result
}

/** Read a snapshot JSON file (or throw with a readable message). */
export function loadSnapshotFile(file: string): Snapshot {
  const { readFileSync } = require("fs")
  const raw = readFileSync(file, "utf8")
  const snap = JSON.parse(raw) as Snapshot
  if (snap.format !== SNAPSHOT_FORMAT) throw new Error(`not a selfforge snapshot: ${file}`)
  return snap
}

/** Write a snapshot JSON file, returning the path. */
export function saveSnapshotFile(snap: Snapshot, file: string): string {
  const { writeFileSync } = require("fs")
  const { join } = require("path")
  const target = file.endsWith(".json") ? file : `${file}.json`
  writeFileSync(target, JSON.stringify(snap, null, 2))
  return target
}

export function transferStatus() {
  return {
    node_id: nodeId(),
    clock: clock(),
    db_path: DB_PATH,
    home: EVOLVE_HOME,
  }
}
