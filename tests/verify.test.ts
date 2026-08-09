import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Phase 1 — skill anti-hallucination verification (ported from MemOS `core/skill/verifier.ts`):
// tool coverage + evidence resonance, both deterministic.

const origHome = process.env.EVOLVE_HOME
const tmpHome = mkdtempSync(join(tmpdir(), "selfforge-verify-"))

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

const verify = async () => (await import("../plugin/selfforge/lib/verify")) as typeof import("../plugin/selfforge/lib/verify")
const review = async () => (await import("../plugin/selfforge/lib/review")) as typeof import("../plugin/selfforge/lib/review")
const repair = async () => (await import("../plugin/selfforge/lib/repair")) as typeof import("../plugin/selfforge/lib/repair")
const db = async () => (await import("../plugin/selfforge/lib/db")) as typeof import("../plugin/selfforge/lib/db")

async function seedEvidence() {
  const d = await db()
  d.getDb().query("DELETE FROM signals").run()
  d.getDb().query("DELETE FROM session_messages").run()
  d.getDb().query("DELETE FROM session_messages_fts").run()
  // real tool invocations (ground truth)
  const r = await repair()
  r.recordSignal("success", "shell", "proj")
  r.recordSignal("success", "bun", "proj")
  r.recordSignal("success", "git", "proj")
  // conversation evidence mentioning the domain
  const rv = await review()
  const s = rv.getSession("verify-session")
  rv.bufferPush(s, { role: "user", content: "use bun test for the new runner" })
  rv.bufferPush(s, { role: "assistant", content: "I ran bun test and it passed, then committed with git" })
}

test("evidenceTools collects real tool ids from signals", async () => {
  await seedEvidence()
  const v = await verify()
  const tools = v.evidenceTools()
  expect(tools.has("shell")).toBe(true)
  expect(tools.has("bun")).toBe(true)
  expect(tools.has("git")).toBe(true)
})

test("tokensOf handles ascii and CJK bigrams", async () => {
  const v = await verify()
  const toks = v.tokensOf("run bun test 运行测试")
  expect(toks.has("bun")).toBe(true)
  expect(toks.size).toBeGreaterThan(0)
})

test("verified skill passes: declared tools map to evidence", async () => {
  await seedEvidence()
  const v = await verify()
  const body = "```\nbun test\n```\n\nUse bun test before committing."
  const res = v.verifySkillDraft({ name: "bun-test-runner", description: "run bun test", body })
  expect(res.ok).toBe(true)
  expect(res.coverage).toBeGreaterThanOrEqual(0.5)
  expect(res.resonance).toBeGreaterThanOrEqual(0.5)
})

test("hallucinated tool is flagged as unmapped (coverage drops)", async () => {
  const d = await db()
  const rv = await review()
  d.getDb().query("DELETE FROM session_messages").run()
  d.getDb().query("DELETE FROM session_messages_fts").run()
  // deployment-domain evidence (kubeadm itself never invoked -> not ground truth)
  const s = rv.getSession("deploy-session")
  rv.bufferPush(s, { role: "user", content: "deploy the cluster in production" })
  rv.bufferPush(s, { role: "assistant", content: "deployed the cluster with kubectl and helm" })
  const v = await verify()
  const body = "```\nkubeadm install everything\n```\n\nDeploy the cluster with kubeadm."
  const res = v.verifySkillDraft({ name: "cluster-deploy", description: "deploy the cluster", body })
  expect(res.evidenceCount).toBeGreaterThan(0)
  expect(res.unmapped.some((t) => t.toLowerCase().includes("kubeadm"))).toBe(true)
  expect(res.draftTools.length).toBeGreaterThan(0)
})

test("no-evidence returns not-ok with reason", async () => {
  const d = await db()
  d.getDb().query("DELETE FROM session_messages").run()
  d.getDb().query("DELETE FROM session_messages_fts").run()
  const v = await verify()
  const res = v.verifySkillDraft({ name: "nothing-yet", description: "brand new domain", body: "```\nbun x\n```" })
  expect(res.ok).toBe(false)
  expect(res.reason).toBe("no-evidence")
})

test("verifySkillDraft is deterministic on identical input", async () => {
  await seedEvidence()
  const v = await verify()
  const body = "```\nbun test\n```\n\nUse bun test."
  const a = v.verifySkillDraft({ name: "deterministic-skill", description: "run tests", body })
  const b = v.verifySkillDraft({ name: "deterministic-skill", description: "run tests", body })
  expect(a.coverage).toBe(b.coverage)
  expect(a.resonance).toBe(b.resonance)
  expect(a.ok).toBe(b.ok)
})
