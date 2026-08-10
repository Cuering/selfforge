import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Metis-inspired features:
 * 1. session summary — fixed-size compressed session state
 * 2. informative write gate — redundant writes rejected
 * 3. recall evidence loop — feedback re-ranks future recalls
 * 4. tiered injection — workspace first, scoped, then general
 * 5. eval harness — deterministic recall precision benchmark
 */

const origHome = process.env.EVOLVE_HOME
const tmpHome = mkdtempSync(join(tmpdir(), "selfforge-metis-"))

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

const mem = async () => (await import("../plugin/selfforge/lib/memory")) as typeof import("../plugin/selfforge/lib/memory")
const db = async () => (await import("../plugin/selfforge/lib/db")) as typeof import("../plugin/selfforge/lib/db")
const summary = async () => (await import("../plugin/selfforge/lib/summary")) as typeof import("../plugin/selfforge/lib/summary")
const evalMod = async () => (await import("../plugin/selfforge/lib/eval")) as typeof import("../plugin/selfforge/lib/eval")

const clean = async () => {
  const d = await db()
  d.getDb().query("DELETE FROM memories").run()
  d.getDb().query("DELETE FROM recall_evidence").run()
  d.getDb().query("DELETE FROM session_summaries").run()
}

// --- Feature 1: fixed-size session state ---

test("session summary distills user directives into a compact digest", async () => {
  const s = await summary()
  const { getSession } = await import("../plugin/selfforge/lib/review")
  const sid = "sess-distill"
  getSession(sid)
  const msgs = [
    { role: "user", content: "we use pnpm instead of npm from now on" },
    { role: "assistant", content: "Done, will use pnpm going forward." },
    { role: "user", content: "remember: test suite must pass before commit" },
    { role: "user", content: "ok thanks" },
  ]
  s.summarizeSession(sid, msgs, 3)
  const row = s.getSessionSummary(sid)
  expect(row).not.toBeNull()
  expect(row!.fact_count).toBeGreaterThan(0)
  expect(row!.summary).toContain("pnpm")
  expect(row!.summary).toContain("test")
  expect(row!.covered_until_turn).toBe(3)
})

test("session summary is bounded (fixed-size state)", async () => {
  const s = await summary()
  const sid = "sess-bounded"
  const noisy = Array.from({ length: 30 }, (_, i) => ({
    role: "user" as const,
    content: `we should always use the ${i}th configuration because it is faster and more reliable`,
  }))
  s.summarizeSession(sid, noisy, 30)
  const row = s.getSessionSummary(sid)
  expect(row!.summary.length).toBeLessThan(2000)
  expect(row!.fact_count).toBeLessThanOrEqual(10)
})

test("renderSessionState emits a session-state block", async () => {
  const s = await summary()
  const sid = "sess-render"
  s.summarizeSession(sid, [{ role: "user", content: "we deploy with a separate migrate command" }], 1)
  const block = s.renderSessionState(sid)
  expect(block).toContain("## Session State")
  expect(block).toContain("migrate")
  expect(s.renderSessionState("unknown-session")).toBeNull()
})

// --- Feature 2: informative write gate ---

test("redundant confirmed writes are gated when novelty is too low", async () => {
  const m = await mem()
  await clean()
  m.memoryAdd("the payment service uses mock-bank", { status: "confirmed", scope: "services/payment/**" })
  // candidate adds only one novel token ("extra") over the existing store
  const nv = m.memoryNovelty("payment mock-bank extra")
  expect(nv.novelty).toBeLessThan(0.35)
  expect(nv.covered_by).not.toBeNull()
  const res = m.memoryAddDedup("payment mock-bank extra", { status: "confirmed" })
  expect((res as { gated?: boolean }).gated).toBe(true)
  // nothing new was inserted
  const count = m.memoryList({ limit: 500 }).length
  expect(count).toBe(1)
})

test("partially-novel content still passes the gate", async () => {
  const m = await mem()
  await clean()
  m.memoryAdd("the payment service uses mock-bank", { status: "confirmed" })
  const res = m.memoryAddDedup("payment also needs a payment-gateway stub for e2e", { status: "confirmed" })
  expect((res as { gated?: boolean }).gated).toBeUndefined()
  expect(m.memoryList({ limit: 500 }).length).toBe(2)
})

test("candidate writes bypass the novelty gate", async () => {
  const m = await mem()
  await clean()
  m.memoryAdd("the payment service uses mock-bank", { status: "confirmed" })
  // same redundancy that would gate a confirmed write (novelty 0 over the
  // existing store), but candidate is exempt and sim < 0.7 so no dedup merge
  const res = m.memoryAddDedup("payment mock-bank extra queue", { status: "candidate" })
  expect((res as { gated?: boolean }).gated).toBeUndefined()
  expect((res as { status?: string }).status).toBe("candidate")
  expect(m.memoryList({ limit: 500 }).length).toBe(2)
})

// --- Feature 3: recall evidence loop ---

test("recall records per-word hit evidence", async () => {
  const m = await mem()
  await clean()
  m.memoryAdd("user prefers pnpm over npm for installing packages", { status: "confirmed" })
  m.memoryRecall("pnpm install packages")
  const rows = (await db()).getDb().query("SELECT * FROM recall_evidence").all()
  // "pnpm", "install", "packages" each recorded a hit against the recalled memory
  expect(rows.length).toBeGreaterThan(0)
  const words = rows.map((r: any) => r.word)
  expect(words).toContain("pnpm")
})

test("recallFeedback records evidence and strengthens the underlying memory", async () => {
  const m = await mem()
  await clean()
  m.memoryAdd("always run tests before committing", { status: "confirmed", importance: 8 })
  const rec = m.memoryRecall("run tests before commit")
  expect(rec.length).toBeGreaterThan(0)
  const strengthBefore = rec[0].strength
  const fb = m.recallFeedback(rec[0].id, true)
  expect(fb.ok).toBe(true)
  expect(fb.matched).toBeGreaterThan(0)
  const ev = (await db())
    .getDb()
    .query("SELECT * FROM recall_evidence WHERE memory_id = ? AND positives > 0")
    .all(rec[0].id)
  expect(ev.length).toBeGreaterThan(0)
  // positive feedback feeds the decay model too (strengthenById)
  const after = m.memoryRecall("run tests before commit")
  expect(after[0].strength).toBeGreaterThanOrEqual(strengthBefore)
})

test("negative feedback shifts the evidence weight down", async () => {
  const m = await mem()
  await clean()
  m.memoryAdd("user prefers pnpm over npm for installing packages", { status: "confirmed" })
  m.memoryRecall("pnpm install packages")
  const rec = m.memoryRecall("pnpm install packages")
  const id = rec[0].id
  const fb = m.recallFeedback(id, false)
  expect(fb.ok).toBe(true)
  const row = (await db())
    .getDb()
    .query("SELECT * FROM recall_evidence WHERE memory_id = ? AND word = 'pnpm'")
    .get(id) as { hits: number; negatives: number; positives: number }
  expect(row.negatives).toBeGreaterThan(0)
  expect(row.hits).toBeGreaterThanOrEqual(2)
})

// --- Feature 4: tiered injection fusion ---

test("composeMemoryContext tiers workspace lessons first", async () => {
  const m = await mem()
  const d = await db()
  d.getDb().query("DELETE FROM memories").run()
  const { touchWorkspace, fingerprintOf, scopeFor } = await import("../plugin/selfforge/lib/workspace")
  const proj = join(tmpHome, "tiered-app")
  const { mkdirSync, writeFileSync } = await import("node:fs")
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, "package.json"), "{}")
  touchWorkspace(proj)
  const wsScope = scopeFor(proj, fingerprintOf(proj))
  m.memoryAdd("workspace rule: use pnpm in this app", { status: "confirmed", scope: wsScope })
  m.memoryAdd("general rule: always update docs", { status: "confirmed" })
  m.memoryAdd("scoped rule: payment uses mock-bank", { status: "confirmed", scope: "services/payment/**" })

  const ctx = m.composeMemoryContext({ wsScope })
  // workspace tier exists and appears before general
  expect(ctx).toContain("## Current Workspace")
  expect(ctx).toContain("## Scoped Lessons")
  expect(ctx).toContain("## General Lessons")
  expect(ctx.indexOf("## Current Workspace")).toBeLessThan(ctx.indexOf("## General Lessons"))
  expect(ctx).toContain("use pnpm in this app")
})

test("composeMemoryContext can fuse a session state block", async () => {
  const m = await mem()
  const s = await summary()
  const sid = "sess-fuse"
  s.summarizeSession(sid, [{ role: "user", content: "we should cache builds in CI" }], 1)
  const ctx = m.composeMemoryContext({ includeSession: sid })
  expect(ctx).toContain("## Session State")
  expect(ctx).toContain("cache builds")
})

// --- Feature 5: eval harness ---

test("recall eval benchmark reaches high precision on the fixture set", async () => {
  const e = await evalMod()
  const m = await mem()
  await clean()
  const res = e.runRecallEval({ k: 3 })
  expect(res.total).toBeGreaterThan(0)
  expect(res.hits).toBeGreaterThanOrEqual(4)
  expect(res.negatives_blocked).toBe(1)
  expect(res.precision).toBeGreaterThanOrEqual(0.8)
  // fixture set was seeded
  expect(m.memoryList({ limit: 500 }).length).toBeGreaterThanOrEqual(6)
})

test("negative eval cases are not recalled", async () => {
  const e = await evalMod()
  await clean()
  const res = e.runRecallEval({ k: 3, cases: [{ query: "we use yarn in this repo", expect: "yarn", negative: true }] })
  expect(res.negatives_blocked).toBe(1)
  expect(res.precision).toBe(1)
})
