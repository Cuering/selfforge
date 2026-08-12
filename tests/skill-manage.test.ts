import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Phase: skill management — enable/disable (load/unload), uninstall,
// install-from-dir, info. Disabled skills must leave SKILLS_DIR (the dir
// opencode scans) so `stop` really unloads them from opencode.

const origHome = process.env.EVOLVE_HOME
const tmpHome = mkdtempSync(join(tmpdir(), "selfforge-skillmgr-"))
let skills: typeof import("../plugin/selfforge/lib/skills")
let db: typeof import("../plugin/selfforge/lib/db")

beforeAll(async () => {
  process.env.EVOLVE_HOME = tmpHome
  db = await import("../plugin/selfforge/lib/db")
  db.initDb()
  skills = await import("../plugin/selfforge/lib/skills")
})

afterAll(() => {
  if (origHome === undefined) delete process.env.EVOLVE_HOME
  else process.env.EVOLVE_HOME = origHome
  try {
    rmSync(tmpHome, { recursive: true, force: true })
  } catch {}
})

function clean() {
  db.getDb().query("DELETE FROM skills").run()
}

// Read the live dirs from the db module so the assertions match wherever the
// module was first imported (bun caches modules across test files in one run).
const onDisk = (name: string) => existsSync(join(db.SKILLS_DIR, name, "SKILL.md"))
const disabledDisk = (name: string) => existsSync(join(db.DISABLED_SKILLS_DIR, name, "SKILL.md"))

test("skillCreate writes SKILL.md under SKILLS_DIR", async () => {
  clean()
  const c = skills.skillCreate("mgr test skill", "management test")
  expect(onDisk(c.name)).toBe(true)
  expect(disabledDisk(c.name)).toBe(false)
})

test("skillDisable moves the skill out of SKILLS_DIR and marks disabled", async () => {
  clean()
  const c = skills.skillCreate("load me", "test")
  expect(onDisk(c.name)).toBe(true)
  const r = skills.skillDisable(c.name)
  expect(r.disabled).toBe(true)
  expect(onDisk(c.name)).toBe(false) // no longer loadable by opencode
  expect(disabledDisk(c.name)).toBe(true)
  const row = skills.skillList().find((s) => s.name === c.name)
  expect(row?.status).toBe("disabled")
  expect(row?.deleted).toBe(0) // disable is not delete
})

test("skillEnable restores the skill to SKILLS_DIR", async () => {
  clean()
  const c = skills.skillCreate("revive me", "test")
  skills.skillDisable(c.name)
  const r = skills.skillEnable(c.name)
  expect(r.enabled).toBe(true)
  expect(onDisk(c.name)).toBe(true)
  expect(disabledDisk(c.name)).toBe(false)
  const row = skills.skillList().find((s) => s.name === c.name)
  expect(row?.status).not.toBe("disabled")
})

test("skillUninstall removes DB row and both disk locations", async () => {
  clean()
  const c = skills.skillCreate("bye bye", "test")
  const r = skills.skillUninstall(c.name)
  expect(r.uninstalled).toBe(true)
  expect(skills.skillList().find((s) => s.name === c.name)).toBeUndefined()
  expect(onDisk(c.name)).toBe(false)
  // uninstall works even after disable
  const c2 = skills.skillCreate("bye disabled", "test")
  skills.skillDisable(c2.name)
  expect(disabledDisk(c2.name)).toBe(true)
  skills.skillUninstall(c2.name)
  expect(disabledDisk(c2.name)).toBe(false)
})

test("skillInfo reports status, location and loadability", async () => {
  clean()
  const c = skills.skillCreate("info skill", "show details")
  let info = skills.skillInfo(c.name)
  expect(info.loaded_by_opencode).toBe(true)
  expect(info.status).toBe("candidate")
  skills.skillDisable(c.name)
  info = skills.skillInfo(c.name)
  expect(info.loaded_by_opencode).toBe(false)
  expect(info.status).toBe("disabled")
  expect(skills.skillInfo("nope-missing").error).toBeTruthy()
})

test("skillInstallFromDir scans a directory tree and registers skills", async () => {
  clean()
  const src = join(tmpHome, "vendor-skills")
  mkdirSync(join(src, "vendor-a"), { recursive: true })
  mkdirSync(join(src, "nested", "vendor-b"), { recursive: true })
  writeFileSync(
    join(src, "vendor-a", "SKILL.md"),
    "---\nname: vendor-a\ndescription: vendor skill a\n---\n# vendor a\n"
  )
  writeFileSync(
    join(src, "nested", "vendor-b", "SKILL.md"),
    "---\nname: vendor-b\ndescription: vendor skill b\n---\n# vendor b\n"
  )
  // a file without frontmatter name should be skipped
  mkdirSync(join(src, "broken"), { recursive: true })
  writeFileSync(join(src, "broken", "SKILL.md"), "# no frontmatter\n")
  const res = skills.skillInstallFromDir(src)
  expect(res.installed).toContain("vendor-a")
  expect(res.installed).toContain("vendor-b")
  expect(res.skipped.length).toBeGreaterThanOrEqual(1)
  expect(onDisk("vendor-a")).toBe(true)
  const row = skills.skillList().find((s) => s.name === "vendor-a")
  expect(row?.description).toContain("vendor skill a")
})

test("skillInstallFromDir on missing dir reports skipped", async () => {
  clean()
  const res = skills.skillInstallFromDir(join(tmpHome, "nope-missing-dir"))
  expect(res.installed).toHaveLength(0)
  expect(res.skipped.length).toBeGreaterThanOrEqual(1)
})

test("adoptOpencodeSkills MOVES skill folders into SKILLS_DIR", async () => {
  clean()
  const src = join(tmpHome, "opencode-skills")
  mkdirSync(join(src, "existing-skill"), { recursive: true })
  writeFileSync(
    join(src, "existing-skill", "SKILL.md"),
    "---\nname: existing-skill\ndescription: an existing opencode skill\n---\n# existing\n"
  )
  const res = skills.adoptOpencodeSkills([src])
  expect(res.installed).toContain("existing-skill")
  expect(res.moved.length).toBeGreaterThanOrEqual(1)
  // original folder is gone (moved, not copied)
  expect(existsSync(join(src, "existing-skill"))).toBe(false)
  // now managed under SKILLS_DIR
  expect(onDisk("existing-skill")).toBe(true)
})