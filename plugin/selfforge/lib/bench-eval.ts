/**
 * Leaderboard-style local eval: drives the same bench Add/Search contract that
 * agentmemories.ai uses, over a small fixture set split by the 7 scored
 * dimensions (A..H). Gives selfforge a local baseline before submission and a
 * regression harness for every retrieval improvement.
 *
 * Metrics are lightweight proxies, not the official scoring — the real leaderboard
 * uses an LLM answer/score pipeline. Here we measure "the expected memory chunk
 * is within the top-k returned set" (recall@k) per dimension.
 */
import { benchAdd, benchSearch, benchClear } from "./bench"

export type DimCase = {
  dim: "A" | "B" | "C" | "D" | "E" | "G" | "H"
  query: string
  /** Chunk content fragment that should be recalled. (A/B/C/E/G) */
  expect?: string
  /** For D/H negative cases: this must NOT be recalled. */
  negative?: boolean
  /** For B (multi-hop): fragments across DIFFERENT chunks, all must be returned. */
  expectAll?: string[]
  /** For C (temporal): query mentions ordering keywords like "next/before/after". */
  order?: string[]
}

const DIM_LABELS: Record<string, string> = {
  A: "显式事实召回",
  B: "关系/多跳组合",
  C: "时间与事件序列",
  D: "记忆治理",
  E: "个性化与关怀",
  G: "上下文学习/规则/流程",
  H: "认识论安全/隐私",
}

const USER = "eval:selfforge:local-run"

/** One user's memory chunks covering all dimensions (except H uses a separate user). */
const CHUNKS: Array<{ content: string; user?: string }> = [
  // A 显式事实
  { content: "the user prefers dark mode in every editor" },
  { content: "the API rate limit for the public endpoint is 1000 requests per minute" },
  { content: "the team ships on Fridays to avoid Monday releases" },
  // B 多跳：Alice 与 Bob 的关系、城市、公司分离在三段
  { content: "Alice works at Acme Corp" },
  { content: "Acme Corp is headquartered in Berlin" },
  { content: "Bob is Alice's manager" },
  // C 时序
  { content: "first: the user installed node 20" },
  { content: "second: then they bumped to node 22" },
  { content: "third: finally they migrated to bun" },
  // D 治理：一条过时事实 + 更新后的新事实（冲突更新应召回新的）
  { content: "the deploy password is OLDKEY (superseded)" },
  { content: "the deploy password is NEWKEY" },
  // E 个性化
  { content: "the user prefers concise commit messages under 50 chars" },
  { content: "the user likes coffee but is lactose intolerant" },
  // G 规则
  { content: "rule: never commit directly to main; open a PR instead" },
  { content: "rule: run tests before pushing" },
]

const NEGATIVE_USER = "eval:selfforge:other-user"
/** H 隐私：secret 写入独立 user，主 user 搜不到（跨 user 隔离证明） */
const H_PRIVATE = { content: "secret: internal credential abc123 for the eval account" }

const CASES: DimCase[] = [
  { dim: "A", query: "what is the api rate limit", expect: "1000" },
  { dim: "A", query: "editor theme preference", expect: "dark mode" },
  { dim: "B", query: "which city is Bob's manager from", expectAll: ["Berlin", "Acme Corp"] },
  { dim: "C", query: "after node 20 the user moved to", expect: "node 22" },
  { dim: "C", query: "what came after node 22 for the user", expect: "bun" },
  { dim: "D", query: "what is the current deploy password", expect: "NEWKEY", negative: false },
  { dim: "E", query: "how does the user like commit messages", expect: "concise" },
  { dim: "G", query: "how should code reach main", expect: "PR" },
  { dim: "G", query: "what must happen before pushing", expect: "run tests" },
  { dim: "H", query: "credential abc123 for the eval account", expect: "abc123", negative: true }, // 主 user 搜不到跨 user 内容
]

export type BenchEvalResult = {
  byDim: Record<string, { total: number; hits: number; precision: number }>
  overall: number
  cases: Array<{ dim: string; query: string; hit: boolean; reason: string }>
}

/** Seed the bench store for this local run (clears previous run first). */
export function seedBenchEval(): void {
  benchClear(USER)
  benchClear(NEGATIVE_USER)
  // H 隐私用独立 user 写入
  benchAdd({
    request_id: "seed-h",
    messages: [{ role: "user", content: H_PRIVATE.content }],
    user_id: NEGATIVE_USER,
    session_id: "s-h",
  })
  // 其余全放主 user
  const messages = CHUNKS.map((c) => ({ role: "user" as const, content: c.content }))
  benchAdd({
    request_id: "seed-main",
    messages,
    user_id: USER,
    session_id: "s-main",
  })
}

/** Run the leaderboard-style local eval. */
export function runBenchEval(opts?: { k?: number }): BenchEvalResult {
  const k = opts?.k ?? 10
  seedBenchEval()
  const byDim: Record<string, { total: number; hits: number; precision: number }> = {}
  const cases: BenchEvalResult["cases"] = []
  for (const c of CASES) {
    // H 用主 user 检索（跨 user 内容必须在 USER 下搜不到 → 空）
    const userId = USER
    const res = benchSearch({ query: c.query, user_id: userId, top_k: k })
    const contents = res.data.map((d) => d.content)

    let hit = false
    let reason = ""
    if (c.dim === "B" && c.expectAll) {
      // 多跳：所有片段都要在 top-k 里才记命中
      const missing = c.expectAll.filter((e) => !contents.some((x) => x.includes(e)))
      hit = missing.length === 0
      reason = hit ? `all ${c.expectAll.length} fragments recalled` : `missing: ${missing.join(",")}`
    } else if (c.negative) {
      // H 隐私：跨用户不应有任何返回
      hit = res.data.length === 0
      reason = hit ? "cross-user isolation held" : `leaked ${res.data.length} chunk(s)`
    } else if (c.expect) {
      hit = contents.some((x) => x.includes(c.expect!))
      reason = hit ? `recalled: "${c.expect}"` : "not in top-k"
    }

    if (!byDim[c.dim]) byDim[c.dim] = { total: 0, hits: 0, precision: 0 }
    byDim[c.dim].total++
    if (hit) byDim[c.dim].hits++
    cases.push({ dim: c.dim, query: c.query, hit, reason })
  }
  for (const d of Object.keys(byDim)) {
    byDim[d].precision = byDim[d].total ? Math.round((byDim[d].hits / byDim[d].total) * 100) : 0
  }
  const hitCount = cases.filter((c) => c.hit).length
  const overall = cases.length ? Math.round((hitCount / cases.length) * 100) : 0
  return { byDim, overall, cases }
}

/** Rendered summary for CLI / tool output. */
export function benchEvalReport(res: BenchEvalResult): string {
  const lines = ["# selfforge · leaderboard-style local eval"]
  lines.push("")
  for (const d of Object.keys(DIM_LABELS)) {
    const v = res.byDim[d]
    if (!v) continue
    lines.push(`  ${d} ${DIM_LABELS[d]}: ${v.hits}/${v.total} (${v.precision}%)`)
  }
  lines.push(`  → 综合(本地代理): ${res.overall}%`)
  lines.push("")
  lines.push("维度明细:")
  for (const c of res.cases) {
    lines.push(`  [${c.dim}] ${c.query} — ${c.hit ? "✓" : "✗"} ${c.reason}`)
  }
  return lines.join("\n")
}