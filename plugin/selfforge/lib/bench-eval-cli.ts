#!/usr/bin/env bun
/**
 * Local leaderboard-style eval CLI.
 * Usage:  bun lib/bench-eval-cli.ts [--k 10]
 */
import { homedir } from "node:os"
import { join } from "node:path"

process.env.EVOLVE_HOME ||= join(homedir(), ".evolve")
const db = await import("./db.ts")
db.initDb()

const { runBenchEval, benchEvalReport } = await import("./bench-eval.ts")
const kArg = process.argv.indexOf("--k")
const k = kArg >= 0 ? Number(process.argv[kArg + 1]) || 10 : 10

const res = runBenchEval({ k })
console.log(benchEvalReport(res))