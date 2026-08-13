#!/usr/bin/env bun
/**
 * Realistic scenario eval: multi-session conversation history mimicking
 * LoCoMo/PersonaMem style. Tests the retrieval pipeline under more natural
 * language patterns (coreference, indirect mention, implicit preference).
 */
import { homedir } from "node:os"
import { join } from "node:path"
process.env.EVOLVE_HOME ||= join(homedir(), ".evolve")
const { initDb } = await import("./db.ts")
initDb()

const { benchAdd, benchSearch, benchClear } = await import("./bench.ts")

const USER = "eval:real:user1"

type Scenario = {
  name: string
  sessions: Array<Array<{ role: string; content: string }>>
  queries: Array<{ query: string; expect: string; dim: string; note: string }>
}

const SCENARIOS: Scenario[] = [
  {
    name: "偏好演变（user changes tooling preference mid-conversation）",
    sessions: [
      [
        { role: "user", content: "I prefer using npm for package management" },
        { role: "assistant", content: "noted" },
      ],
      [
        { role: "user", content: "actually I switched to pnpm, it's faster" },
        { role: "assistant", content: "updated preference" },
      ],
      [
        { role: "user", content: "the team decided to use yarn for the new monorepo" },
        { role: "assistant", content: "recorded" },
      ],
      [
        { role: "user", content: "I like dark mode better than light mode for coding" },
        { role: "assistant", content: "ok" },
      ],
    ],
    queries: [
      { query: "what package manager does the user prefer", expect: "pnpm", dim: "E", note: "最新偏好覆盖旧偏好" },
      { query: "what does the team use for the monorepo", expect: "yarn", dim: "A", note: "团队层面 vs 个人层面" },
      { query: "does the user prefer dark mode", expect: "dark mode", dim: "E", note: "显式偏好" },
    ],
  },
  {
    name: "事实更新与多跳（设备配置变更）",
    sessions: [
      [
        { role: "user", content: "my development machine runs Ubuntu 22.04" },
        { role: "assistant", content: "logged" },
      ],
      [
        { role: "user", content: "I upgraded to Ubuntu 24.04 last week" },
        { role: "assistant", content: "updated OS version" },
      ],
      [
        { role: "user", content: "my workstation is a ThinkPad X1 Carbon" },
        { role: "assistant", content: "saved" },
      ],
      [
        { role: "user", content: "the ThinkPad is manufactured by Lenovo" },
        { role: "assistant", content: "ok" },
      ],
    ],
    queries: [
      { query: "what OS is the user currently running", expect: "Ubuntu 24.04", dim: "D", note: "新值覆盖旧值" },
      { query: "what laptop does the user use", expect: "ThinkPad X1 Carbon", dim: "A", note: "显式事实" },
      { query: "who makes the ThinkPad the user uses", expect: "Lenovo", dim: "B", note: "多跳：ThinkPad → Lenovo" },
    ],
  },
  {
    name: "时序事件链（项目部署流水线同时序）",
    sessions: [
      [
        { role: "user", content: "first I set up the CI pipeline with GitHub Actions" },
        { role: "assistant", content: "ok" },
      ],
      [
        { role: "user", content: "then I configured Docker build and push step" },
        { role: "assistant", content: "got it" },
      ],
      [
        { role: "user", content: "finally I deployed to staging via ArgoCD" },
        { role: "assistant", content: "deployment logged" },
      ],
      [
        { role: "user", content: "the staging environment is hosted on AWS EKS" },
        { role: "assistant", content: "saved" },
      ],
    ],
    queries: [
      { query: "what was the first step in the CI setup", expect: "GitHub Actions", dim: "C", note: "时序 first" },
      { query: "what happened after Docker was configured", expect: "ArgoCD", dim: "C", note: "时序 after" },
      { query: "where is the staging environment hosted", expect: "AWS EKS", dim: "A", note: "显式事实" },
      { query: "what tool was used for deployment", expect: "ArgoCD", dim: "A", note: "显式事实" },
    ],
  },
  {
    name: "跨会话实体关联（招聘流程）",
    sessions: [
      [
        { role: "user", content: "I interviewed Alice for the backend role" },
        { role: "assistant", content: "recorded" },
      ],
      [
        { role: "user", content: "Bob is the hiring manager" },
        { role: "assistant", content: "ok" },
      ],
      [
        { role: "user", content: "Alice got the offer and accepted; she will join the payments team" },
        { role: "assistant", content: "great" },
      ],
      [
        { role: "user", content: "the payments team is part of the fintech division" },
        { role: "assistant", content: "noted" },
      ],
    ],
    queries: [
      { query: "which team does Alice work on", expect: "payments", dim: "B", note: "多跳：Alice → payments team" },
      { query: "who is the hiring manager", expect: "Bob", dim: "A", note: "显式事实" },
      { query: "what division is the payments team in", expect: "fintech", dim: "B", note: "多跳：payments → fintech" },
    ],
  },
]

console.log("# selfforge · scenario-based real-world eval\n")

let totalHits = 0
let totalCases = 0
benchClear(USER)

for (const scenario of SCENARIOS) {
  // Load sessions
  for (const session of scenario.sessions) {
    const messages = session.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
    benchAdd({ request_id: "real-eval", messages, user_id: USER, session_id: `s-${scenario.name.slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}` })
  }

  console.log(`## ${scenario.name}`)
  let hits = 0
  for (const q of scenario.queries) {
    totalCases++
    const res = benchSearch({ query: q.query, user_id: USER, top_k: 10 })
    const contents = res.data.map((d) => d.content)
    const hit = contents.some((c) => c.includes(q.expect))
    if (hit) hits++
    const results = res.data.length ? res.data.slice(0, 3).map((d) => d.content.slice(0, 60)).join(" | ") : "(empty)"
    console.log(`  [${q.dim}] ${q.query}`)
    console.log(`    → ${hit ? "✓" : "✗"} expected "${q.expect}" · top: ${results}`)
  }
  totalHits += hits
  console.log(`  → ${hits}/${scenario.queries.length}\n`)
}

console.log(`**综合: ${totalHits}/${totalCases} (${Math.round(totalHits / totalCases * 100)}%)**`)