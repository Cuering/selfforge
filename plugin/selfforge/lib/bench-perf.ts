#!/usr/bin/env bun
/**
 * Performance benchmark for benchSearch.
 * Measures latency of Add (ingest + indexing) and Search (retrieve + entity link)
 * at increasing data scales (100, 500, 1000, 5000 chunks).
 */
import { homedir } from "node:os"
import { join } from "node:path"
process.env.EVOLVE_HOME ||= join(homedir(), ".evolve")

const { initDb, getDb } = await import("./db.ts")
initDb()

const { benchAdd, benchSearch, benchClear } = await import("./bench.ts")

const USER = "eval:perf:bench"
const SIZES = [100, 500, 1000, 5000]

function dummyChunk(i: number): string {
  const topics = ["network", "storage", "deploy", "auth", "api", "config", "monitor", "cache", "queue", "database"]
  const t = topics[i % topics.length]
  return `the ${t} team uses ${t === "auth" ? "OAuth2" : t === "database" ? "PostgreSQL" : t === "cache" ? "Redis" : t === "queue" ? "RabbitMQ" : "Kubernetes"} for ${t === "network" ? "service mesh" : t === "storage" ? "object storage" : t === "deploy" ? "CI/CD" : t === "api" ? "gateway" : t === "config" ? "secret management" : t === "monitor" ? "observability" : t === "cache" ? "caching" : t === "queue" ? "message broker" : t === "database" ? "primary store" : "workload orchestration"} in ${t === "auth" ? "project vertex" : t === "database" ? "project atlas" : t === "cache" ? "project lightning" : t === "queue" ? "project stream" : t === "network" ? "project mesh" : t === "storage" ? "project glacier" : t === "deploy" ? "project ship" : t === "api" ? "project gateway" : t === "config" ? "project vault" : t === "monitor" ? "project scope" : "project unknown"}`
}

const SEARCH_QUERIES = [
  "what is the deploy team using for CI/CD",
  "auth project OAuth2",
  "database PostgreSQL primary store",
  "monitor observability team",
  "cache Redis in project lightning",
  "queue message broker project stream",
]

async function run() {
  for (const n of SIZES) {
    benchClear(USER)
    const addStart = performance.now()
    // Add in batches of 100
    for (let i = 0; i < n; i += 100) {
      const batch = []
      for (let j = i; j < Math.min(i + 100, n); j++) batch.push({ role: "user" as const, content: dummyChunk(j) })
      benchAdd({ request_id: `perf-${n}`, messages: batch, user_id: USER, session_id: "s-perf" })
    }
    const addMs = performance.now() - addStart

    // Run 6 search queries, measure average
    let totalSearchMs = 0
    for (const q of SEARCH_QUERIES) {
      const s = performance.now()
      const res = benchSearch({ query: q, user_id: USER, top_k: 100 })
      totalSearchMs += performance.now() - s
      if (res.data.length === 0) console.log(`  WARN: empty result for "${q.slice(0, 40)}"`)
    }
    const avgSearch = totalSearchMs / SEARCH_QUERIES.length

    // Count actual rows in bench_memories
    const db = getDb()
    const count = (db.query("SELECT COUNT(*) AS n FROM bench_memories WHERE user_id = ? AND deleted = 0").get(USER) as { n: number }).n

    console.log(`${n} chunks: add=${addMs.toFixed(0)}ms  avgSearch=${avgSearch.toFixed(1)}ms  stored=${count}`)
  }
}
await run()