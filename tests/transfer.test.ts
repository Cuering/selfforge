import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Phase 3 cross-agent transfer: portable snapshot + per-uuid LWW merge.

const origHome = process.env.EVOLVE_HOME
const tmpHome = mkdtempSync(join(tmpdir(), "selfforge-transfer-"))

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

test("exportSnapshot serializes sync tables with identity", async () => {
  const { exportSnapshot } = await import("../plugin/selfforge/lib/transfer")
  const { memoryAdd } = await import("../plugin/selfforge/lib/memory")
  memoryAdd("zzz-transfer-unique-marker-88 lesson", { importance: 6, status: "confirmed" })
  const snap = exportSnapshot()
  expect(snap.format).toBe("selfforge-snapshot")
  expect(snap.node_id).toMatch(/^node-/)
  expect(Array.isArray(snap.tables.memories)).toBe(true)
  const rows = snap.tables.memories.filter((r) => String(r.content).includes("zzz-transfer-unique-marker-88"))
  expect(rows).toHaveLength(1)
  expect(rows[0].uuid).toMatch(/^[0-9a-f-]{36}$/i)
  expect(rows[0].origin).toBe(snap.node_id)
  expect(rows[0].deleted).toBe(0)
})

test("LWW merge decision: newer wins, older kept, tombstone deletes", async () => {
  const { mergeDecision } = await import("../plugin/selfforge/lib/transfer")
  // local is newer -> keep
  expect(
    mergeDecision(
      { deleted: 0, updated_at: "2026-01-01T00:00:00Z" },
      { deleted: 0, updated_at: "2026-01-02T00:00:00Z" },
      "node-a",
      "node-b"
    )
  ).toBe("keep")
  // snapshot is newer -> overwrite
  expect(
    mergeDecision(
      { deleted: 0, updated_at: "2026-01-03T00:00:00Z" },
      { deleted: 0, updated_at: "2026-01-02T00:00:00Z" },
      "node-a",
      "node-b"
    )
  ).toBe("overwrite")
  // equal timestamp -> tie-break by node id
  expect(
    mergeDecision(
      { deleted: 0, updated_at: "2026-01-02T00:00:00Z" },
      { deleted: 0, updated_at: "2026-01-02T00:00:00Z" },
      "node-a",
      "node-b"
    )
  ).toBe("keep")
  // snapshot tombstone -> delete local
  expect(
    mergeDecision(
      { deleted: 1, updated_at: "2026-01-02T00:00:00Z" },
      { deleted: 0, updated_at: "2026-01-02T00:00:00Z" },
      "node-a",
      "node-b"
    )
  ).toBe("tombstone")
  // no local row -> insert
  expect(mergeDecision({ deleted: 0, updated_at: "2026-01-01T00:00:00Z" }, undefined, "node-a", "node-b")).toBe("insert")
})

test("round-trip snapshot -> import keeps local rows and adds new ones", async () => {
  const { exportSnapshot, importSnapshot } = await import("../plugin/selfforge/lib/transfer")
  const { memoryAdd } = await import("../plugin/selfforge/lib/memory")
  const { getDb } = await import("../plugin/selfforge/lib/db")

  // isolate this test: exactly one known memory in an otherwise empty table
  getDb().exec("DELETE FROM memories")
  memoryAdd("roundtrip-marker lesson", { status: "confirmed" })
  const snap = exportSnapshot()
  const n = snap.tables.memories.length
  expect(n).toBeGreaterThanOrEqual(1)

  // fresh import into an empty table: the marker row comes back as an insert
  getDb().exec("DELETE FROM memories")
  const res = importSnapshot(snap)
  expect(res.memories.insert).toBe(n)
  expect((getDb().query("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c).toBe(n)

  // importing the same snapshot again: all keeps (idempotent)
  const again = importSnapshot(snap)
  expect(again.memories.insert).toBe(0)
  expect(again.memories.keep).toBe(n)
})

test("snapshot import advances the Lamport clock past the peer", async () => {
  const { exportSnapshot, importSnapshot } = await import("../plugin/selfforge/lib/transfer")
  const { clock } = await import("../plugin/selfforge/lib/db")
  const snap = exportSnapshot()
  // emulate a peer snapshot with a far-future clock
  snap.clock = clock() + 1000
  importSnapshot(snap)
  expect(clock()).toBeGreaterThanOrEqual(snap.clock)
})
