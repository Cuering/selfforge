import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const origHome = process.env.EVOLVE_HOME
const tmpHome = mkdtempSync(join(tmpdir(), "selfforge-daily-sol-"))

beforeAll(async () => {
  process.env.EVOLVE_HOME = tmpHome
  const db = await import("../plugin/selfforge/lib/db")
  db.initDb()
})

afterAll(() => {
  if (origHome === undefined) delete process.env.EVOLVE_HOME
  else process.env.EVOLVE_HOME = origHome
  try {
    rmSync(tmpHome, { recursive: true, force: true })
  } catch {}
})

async function sum() {
  return import("../plugin/selfforge/lib/summary")
}

test("extractSolution rejects process-talk and problem echo", async () => {
  const s = await sum()
  const problem = "请检查检查点有没有重复内容并修复"
  expect(s.extractSolution("让我先查看相关代码。", problem)).toBe("")
  expect(s.extractSolution("好的，我先检查一下数据。", problem)).toBe("")
  // Echo of the problem should fail the gate
  const echo = s.extractSolution("请检查检查点有没有重复内容并修复。", problem)
  expect(echo).toBe("")
})

test("extractSolution prefers end conclusion with action keywords", async () => {
  const s = await sum()
  const asst = [
    "让我先看看检查点相关代码。",
    "数据里有同一目标的多行 CP。",
    "已改为按 goal_id 去重，只显示每个目标最新检查点；计数改为 distinct goal_id。",
  ].join("\n")
  const sol = s.extractSolution(asst, "检查点重复")
  expect(sol).toBeTruthy()
  expect(sol).toMatch(/去重|goal_id|最新/)
  expect(sol).not.toMatch(/^让我/)
})

test("extractSolution accepts code block as concrete method", async () => {
  const s = await sum()
  const asst = "可以这样启动 daemon：\n```\nnode compiled/serve-daemon.js\n```\n"
  const sol = s.extractSolution(asst, "daemon 起不来")
  expect(sol).toContain("serve-daemon")
})

test("scoreSolution requires method/action bar", async () => {
  const s = await sum()
  const bad = s.scoreSolution("这个问题比较复杂。", "修复 daemon")
  expect(bad.ok).toBe(false)
  const good = s.scoreSolution("已修复：compose 后调用 scheduleContextRefresh 热写 memory.context.md。", "记忆不更新")
  expect(good.ok).toBe(true)
  expect(good.score).toBeGreaterThanOrEqual(4)
})

test("refineSolution merges method step when available", async () => {
  const s = await sum()
  const asst =
    "根因是 String.raw 不解码 unicode。\n已改为 cooked html 模板。\n步骤：1) 改 dashboard-html.ts 2) bun build.mjs 3) 重启 daemon。"
  const r = s.refineSolution(asst, "按钮显示 \\u9519")
  expect(r.length).toBeGreaterThan(10)
  expect(r).toMatch(/已改|步骤|模板|根因/)
})
