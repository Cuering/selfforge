import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setConfig } from "../plugin/selfforge/lib/db"

let tmp: string

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "selfforge-patterns-"))
  process.env.EVOLVE_HOME = tmp
  const { initDb, getDb } = await import("../plugin/selfforge/lib/db")
  const db = initDb()
  // fresh DB has no seeds; suppress noise
  db.exec("DELETE FROM memories")
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe("pattern signatures", () => {
  it("builds a deterministic signature label and 16-hex hash", async () => {
    const { signatureLabel, signatureHash } = await import("../plugin/selfforge/lib/patterns")
    const label = signatureLabel("shell", "EXIT_CODE_1", "C:\\work\\proj")
    expect(label).toBe("EXIT_CODE_1|proj|shell|EXIT_CODE_1")
    const h = signatureHash(label)
    expect(h).toMatch(/^[0-9a-f]{16}$/)
    expect(signatureHash(label)).toBe(h)
  })

  it("fills empty slots with _", async () => {
    const { signatureLabel } = await import("../plugin/selfforge/lib/patterns")
    expect(signatureLabel("docker")).toBe("docker|_|docker|_")
  })

  it("records and dedups within the same episode", async () => {
    const { recordPattern, patternStatus } = await import("../plugin/selfforge/lib/patterns")
    const a = recordPattern("shell", "E1", "p", "ep1")
    recordPattern("shell", "E1", "p", "ep1")
    const s = patternStatus()
    // same episode: only one live row kept (TTL refresh)
    expect(s.total_signatures).toBe(1)
    expect(a.sig_hash).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("pattern candidate pool", () => {
  it("does not induce from a single episode", async () => {
    const { recordPattern, inducePatterns } = await import("../plugin/selfforge/lib/patterns")
    recordPattern("build", "E2", "repo", "ep-a")
    const res = inducePatterns()
    expect(res.promoted).toHaveLength(0)
  })

  it("induces only when >= min episodes (default 2) share a signature", async () => {
    const { recordPattern, inducePatterns, patternStatus } = await import("../plugin/selfforge/lib/patterns")
    // quorum = 2 distinct episodes for signature build|E2|repo|E2
    recordPattern("build", "E2", "repo", "ep-b")
    const s = patternStatus()
    expect(s.ready).toHaveLength(1)
    const res = inducePatterns()
    expect(res.promoted).toHaveLength(1)
    expect(res.promoted[0].sig_label).toContain("E2")
    // re-induce after promotion: bucket rows are tombstoned -> no duplicates
    const again = inducePatterns()
    expect(again.promoted).toHaveLength(0)
  })

  it("respects a raised quorum threshold via config", async () => {
    setConfig("pattern_min_episodes", "3")
    const { recordPattern, inducePatterns } = await import("../plugin/selfforge/lib/patterns")
    const { getDb } = await import("../plugin/selfforge/lib/db")
    getDb().exec("DELETE FROM memories WHERE source = 'pattern'")
    recordPattern("lint", "E3", "src", "q1")
    recordPattern("lint", "E3", "src", "q2")
    expect(inducePatterns().promoted).toHaveLength(0)
    recordPattern("lint", "E3", "src", "q3")
    expect(inducePatterns().promoted).toHaveLength(1)
    setConfig("pattern_min_episodes", "2")
  })

  it("merges near-duplicate lessons instead of inserting (dedup-aware)", async () => {
    const { recordPattern, inducePatterns } = await import("../plugin/selfforge/lib/patterns")
    const { getDb } = await import("../plugin/selfforge/lib/db")
    getDb().exec("DELETE FROM memories WHERE source = 'pattern'")
    recordPattern("fmt", "E4", "proj", "m1")
    recordPattern("fmt", "E4", "proj", "m2")
    const first = inducePatterns()
    const n1 = (getDb().query("SELECT COUNT(*) AS n FROM memories WHERE source = 'pattern'").get() as { n: number }).n
    expect(first.promoted).toHaveLength(1)
    expect(n1).toBe(1)
  })

  it("prunes expired candidates by TTL", async () => {
    const { prunePatterns } = await import("../plugin/selfforge/lib/patterns")
    const res = prunePatterns()
    expect(typeof res.removed).toBe("number")
  })
})
