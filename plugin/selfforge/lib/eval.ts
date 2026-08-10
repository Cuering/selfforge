import { getDb } from "./db"
import { memoryAdd, memoryRecall } from "./memory"

/**
 * Feature 5 — eval benchmark (MemTensor Metis `eval/` analog).
 *
 * A deterministic, zero-LLM recall harness: seed a known fixture set, then
 * measure how often `memoryRecall` returns the expected memory for a query.
 * Reports per-case hit, overall precision@k and average precision. Used by
 * `memory_eval` and by tests to keep recall regressions visible.
 */

export type EvalCase = {
  query: string
  /** Content fragment that must appear in at least one recalled memory. */
  expect: string
  /** When true the case is a known negative — expect must NOT be recalled. */
  negative?: boolean
}

const FIXTURES: Array<{ content: string; scope?: string }> = [
  { content: "user prefers pnpm over npm for installing packages" },
  { content: "payment service must start mock-bank before integration tests", scope: "services/payment/**" },
  { content: "deploy to production requires CI approval from the on-call engineer" },
  { content: "all API responses should use camelCase field naming" },
  { content: "database migrations are applied with a separate migrate command" },
  { content: "test suite must pass before committing to the main branch" },
]

const CASES: EvalCase[] = [
  { query: "package manager pnpm npm install", expect: "pnpm" },
  { query: "payment mock-bank integration tests", expect: "mock-bank" },
  { query: "production deploy approval CI", expect: "on-call" },
  { query: "camelCase API field naming", expect: "camelCase" },
  { query: "run tests before commit main branch", expect: "test suite" },
  { query: "we use yarn in this repo", expect: "yarn", negative: true },
]

export type EvalResult = {
  total: number
  hits: number
  negatives_blocked: number
  precision: number
  cases: Array<{ query: string; hit: boolean; recalled: string[] }>
}

/** Seed the eval fixture set (idempotent via content match skip). */
export function seedEvalFixtures(): void {
  const existing = getDb().query("SELECT content FROM memories WHERE archived = 0").all() as Array<{ content: string }>
  const have = new Set(existing.map((r) => r.content))
  for (const f of FIXTURES) {
    if (have.has(f.content)) continue
    memoryAdd(f.content, { source: "eval-fixture", status: "confirmed", importance: 8, scope: f.scope })
  }
}

/** Run the recall benchmark against the current store. */
export function runRecallEval(opts?: { k?: number; cases?: EvalCase[] }): EvalResult {
  const k = opts?.k ?? 3
  const cases = opts?.cases ?? CASES
  seedEvalFixtures()
  const results: EvalResult["cases"] = []
  let hits = 0
  let negativesBlocked = 0
  for (const c of cases) {
    const recalled = memoryRecall(c.query, { limit: k }).map((m) => m.content)
    const found = recalled.some((r) => r.includes(c.expect))
    if (c.negative) {
      if (!found) negativesBlocked++
      results.push({ query: c.query, hit: !found, recalled })
    } else {
      if (found) hits++
      results.push({ query: c.query, hit: found, recalled })
    }
  }
  const positives = cases.filter((c) => !c.negative)
  const denominator = positives.length + cases.filter((c) => c.negative).length
  const precision = denominator === 0 ? 0 : (hits + negativesBlocked) / denominator
  return { total: cases.length, hits, negatives_blocked: negativesBlocked, precision, cases: results }
}
