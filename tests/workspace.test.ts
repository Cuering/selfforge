import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const origHome = process.env.EVOLVE_HOME
let tmp: string
let proj: string

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "selfforge-ws-"))
  process.env.EVOLVE_HOME = tmp
  proj = join(tmp, "myapp")
  const { initDb } = await import("../plugin/selfforge/lib/db")
  initDb()
  const { mkdirSync } = await import("node:fs")
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, "package.json"), "{}")
  writeFileSync(join(proj, "Dockerfile"), "FROM node\n")
})

afterAll(() => {
  if (origHome === undefined) delete process.env.EVOLVE_HOME
  else process.env.EVOLVE_HOME = origHome
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {}
})

describe("workspace fingerprint", () => {
  it("detects stack markers from the directory", async () => {
    const { detectMarkers } = await import("../plugin/selfforge/lib/workspace")
    const markers = detectMarkers(proj)
    expect(markers).toContain("node")
    expect(markers).toContain("docker")
  })

  it("produces a stable fingerprint and ws: scope key", async () => {
    const { fingerprintOf, scopeFor } = await import("../plugin/selfforge/lib/workspace")
    const fp = fingerprintOf(proj)
    expect(fp).toMatch(/^[0-9a-f]{12}$/)
    expect(fingerprintOf(proj)).toBe(fp)
    expect(scopeFor(proj, fp)).toBe(`ws:myapp:${fp}`)
  })

  it("touchWorkspace upserts visits and tracks last_seen", async () => {
    const { touchWorkspace } = await import("../plugin/selfforge/lib/workspace")
    const a = touchWorkspace(proj)
    const b = touchWorkspace(proj)
    expect(b.id).toBe(a.id)
    expect(b.visits).toBeGreaterThanOrEqual(a.visits + 1)
    expect(b.scope).toMatch(/^ws:myapp:/)
  })

  it("lists workspaces ordered by recency", async () => {
    const { touchWorkspace, workspaceList } = await import("../plugin/selfforge/lib/workspace")
    touchWorkspace(proj)
    const list = workspaceList()
    expect(list.length).toBeGreaterThanOrEqual(1)
    expect(list[0].name).toBe("myapp")
  })
})

describe("fingerprint-scoped retrieval", () => {
  it("scopeBoost rewards memories matching the current workspace", async () => {
    const { scopeBoost } = await import("../plugin/selfforge/lib/workspace")
    const ws = `ws:myapp:abcd1234abcd`
    expect(scopeBoost(ws, { scope: ws })).toBe(2)
    expect(scopeBoost(ws, { scope: "other" })).toBe(0)
  })

  it("memoryRecall applies the ws boost so matching-scope memories rank first", async () => {
    const { touchWorkspace, workspaceList } = await import("../plugin/selfforge/lib/workspace")
    touchWorkspace(proj)
    const ws = workspaceList()[0]
    const { memoryAdd, memoryRecall } = await import("../plugin/selfforge/lib/memory")
    const { getDb } = await import("../plugin/selfforge/lib/db")
    getDb().exec("DELETE FROM memories")
    const other = memoryAdd("frozzle quux baz config lives in settings panel", {
      scope: "other",
      importance: 9,
      status: "confirmed",
    })
    const scoped = memoryAdd("frozzle quux baz deploy uses npm build", {
      scope: ws.scope,
      importance: 5,
      status: "confirmed",
    })
    const withBoost = memoryRecall("frozzle quux baz", { wsScope: ws.scope, limit: 3 })
    const noBoost = memoryRecall("frozzle quux baz", { limit: 3 })
    // with boost, the workspace-scoped memory must outrank the unscoped one
    expect(withBoost[0]?.id).toBe(scoped.id)
    expect(withBoost.map((m) => m.id).indexOf(scoped.id)).toBeLessThan(
      withBoost.map((m) => m.id).indexOf(other.id)
    )
    for (const m of [other, scoped]) getDb().query("DELETE FROM memories WHERE id = ?").run(m.id)
  })
})

describe("workspace de-dup / merge", () => {
  it("normalizePath unifies separators, trailing slash and case", async () => {
    const { normalizePath } = await import("../plugin/selfforge/lib/workspace")
    if (process.platform === "win32") {
      expect(normalizePath("D:/opencode")).toBe("d:\\opencode")
      expect(normalizePath("D:\\opencode\\")).toBe("d:\\opencode")
      expect(normalizePath("D:\\Opencode")).toBe("d:\\opencode")
      expect(normalizePath("C:")).toBe("c:\\")
    } else {
      expect(normalizePath("/a/b/")).toBe("/a/b")
    }
  })

  it("mergeDuplicateWorkspaces folds duplicate rows for the same directory into one keeper", async () => {
    const { getDb } = await import("../plugin/selfforge/lib/db")
    const { mergeDuplicateWorkspaces, workspaceList } = await import("../plugin/selfforge/lib/workspace")
    const db = getDb()
    // simulate the same dir recorded under different separators
    const rows = db
      .query("INSERT INTO workspaces (uuid, origin, path, name, fingerprint, scope, visits, first_seen, last_seen) VALUES ('m1', 'n', ?, 'proj', 'fp', 'ws:proj:fp', 2, '2026-01-01', '2026-01-01')")
      .run("D:/my/proj")
    const rows2 = db
      .query("INSERT INTO workspaces (uuid, origin, path, name, fingerprint, scope, visits, first_seen, last_seen) VALUES ('m2', 'n', ?, 'proj', 'fp', 'ws:proj:fp', 5, '2026-01-01', '2026-01-03')")
      .run("D:\\my\\proj\\")
    const res = mergeDuplicateWorkspaces()
    expect(res.merged).toBeGreaterThanOrEqual(1)
    const active = workspaceList()
    // both rows must collapse to a single active workspace
    expect(active.filter((w) => w.path.toLowerCase().includes("my") && w.path.toLowerCase().includes("proj")).length).toBe(1)
    const keeper = active.find((w) => w.path.replace(/[\\/]/g, "\\").toLowerCase() === "d:\\my\\proj")
    expect(keeper).toBeTruthy()
    expect(keeper!.visits).toBe(7)
    expect(keeper!.last_seen).toBe("2026-01-03")
  })
})
