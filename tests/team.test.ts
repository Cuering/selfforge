import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Phase 4 team shared memory: git repo as shared truth, converge on LWW merge.

const origHome = process.env.EVOLVE_HOME
const tmpHome = mkdtempSync(join(tmpdir(), "selfforge-team-"))
const repoA = join(tmpHome, "team-a")
const repoB = join(tmpHome, "team-b")
const sharedRepo = join(tmpHome, "shared.git")

function git(dir: string, args: string[]): string {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process")
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim()
}

function initBare(): void {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process")
  execFileSync("git", ["init", "-q", "--bare", sharedRepo], { encoding: "utf8" })
}

beforeAll(async () => {
  process.env.EVOLVE_HOME = tmpHome
  const db = (await import("../plugin/selfforge/lib/db")) as typeof import("../plugin/selfforge/lib/db")
  db.initDb()
  initBare()
  // repo A: a fresh clone of the bare repo
  git(sharedRepo, ["init", "-q"]) // no-op on bare; keep for symmetry
})

afterAll(() => {
  if (origHome === undefined) delete process.env.EVOLVE_HOME
  else process.env.EVOLVE_HOME = origHome
  try {
    rmSync(tmpHome, { recursive: true, force: true })
  } catch {}
})

test("teamInit creates a repo with an initial snapshot commit", async () => {
  const { teamInit } = await import("../plugin/selfforge/lib/sync")
  const res = teamInit(repoA, { remote: sharedRepo })
  expect(existsSync(join(repoA, "snapshot.json"))).toBe(true)
  expect(res.commit).toBeTruthy()
  expect(res.repo).toBe(repoA)
})

test("teamSync pushes the initial snapshot to the shared remote", async () => {
  const { teamSync } = await import("../plugin/selfforge/lib/sync")
  const res = teamSync({ repo: repoA, remote: "origin", branch: "main" })
  expect(res.error).toBeUndefined()
  expect(res.pushed).toBe(true)
})

test("a second node clone + sync converges (LWW merge)", async () => {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process")
  execFileSync("git", ["clone", "-q", sharedRepo, repoB], { encoding: "utf8" })

  // node A adds a memory and syncs it up
  process.env.EVOLVE_HOME = tmpHome
  const syncA = await import("../plugin/selfforge/lib/sync")
  const db = (await import("../plugin/selfforge/lib/db")) as typeof import("../plugin/selfforge/lib/db")
  const { memoryAdd } = await import("../plugin/selfforge/lib/memory")
  memoryAdd("team shared lesson alpha", { status: "confirmed" })
  syncA.teamSync({ repo: repoA, branch: "main" })

  // node B syncs (pulls alpha in), adds its own, syncs back up
  const syncB = await import("../plugin/selfforge/lib/sync")
  syncB.teamSync({ repo: repoB, branch: "main" })
  memoryAdd("team shared lesson beta", { status: "confirmed" })
  syncB.teamSync({ repo: repoB, branch: "main" })

  // node A syncs again — must now see both lessons
  syncA.teamSync({ repo: repoA, branch: "main" })
  const { memoryList } = await import("../plugin/selfforge/lib/memory")
  const contents = memoryList({ limit: 99 }).map((m) => m.content)
  expect(contents).toContain("team shared lesson alpha")
  expect(contents).toContain("team shared lesson beta")
})

test("tombstone propagates across nodes via team sync", async () => {
  const syncA = await import("../plugin/selfforge/lib/sync")
  const { memoryList, memoryRemove } = await import("../plugin/selfforge/lib/memory")
  const alpha = memoryList({ limit: 99 }).find((m) => m.content === "team shared lesson alpha")
  expect(alpha).toBeTruthy()
  memoryRemove("team shared lesson alpha")
  syncA.teamSync({ repo: repoA, branch: "main" })

  const syncB = await import("../plugin/selfforge/lib/sync")
  syncB.teamSync({ repo: repoB, branch: "main" })
  const contents = memoryList({ limit: 99 }).map((m) => m.content)
  expect(contents).not.toContain("team shared lesson alpha")
})

test("teamStatus reports the configured repo", async () => {
  const { teamStatus } = await import("../plugin/selfforge/lib/sync")
  const st = teamStatus()
  expect(typeof st.local_node).toBe("string")
  expect(typeof st.snapshot_version).toBe("number")
})

test("teamSync on an unconfigured home reports a clear error", async () => {
  const db = (await import("../plugin/selfforge/lib/db")) as typeof import("../plugin/selfforge/lib/db")
  db.getDb().exec("DELETE FROM config WHERE key = 'team_repo'")
  const { teamSync } = await import("../plugin/selfforge/lib/sync")
  const res = teamSync({})
  expect(res.error).toBeTruthy()
})
