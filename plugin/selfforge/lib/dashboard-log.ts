/**
 * Persistent call logging + in-memory error ring buffer.
 * Call logs are appended to ~/.evolve/call-log.jsonl (JSON Lines, non-cached).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { EVOLVE_HOME } from "./db"

const LOG_DIR = EVOLVE_HOME
const LOG_FILE = join(LOG_DIR, "call-log.jsonl")

export type CallRecord = {
  id: number
  ts: string
  type: string
  method: string
  detail?: string
}

let seq = 0
let callCounter = 0

/** Call counters per data type (memories, skills, rules, goals, etc.). */
const callCounters = new Map<string, number>()
const recentBuf: CallRecord[] = []
const MAX_RECENT = 200

// --- Error ring buffer (in-memory, same as before) ---

export type DashLogEntry = {
  id: number
  ts: string
  level: "error" | "warn" | "info"
  source: string
  message: string
  stack?: string
  meta?: Record<string, unknown>
}

const MAX = 200
const errBuf: DashLogEntry[] = []
let errSeq = 0

export function dashLog(
  level: DashLogEntry["level"],
  source: string,
  message: string,
  extra?: { stack?: string; meta?: Record<string, unknown> }
): DashLogEntry {
  const entry: DashLogEntry = {
    id: ++errSeq,
    ts: new Date().toISOString(),
    level,
    source: String(source || "unknown").slice(0, 80),
    message: String(message || "").slice(0, 2000),
    stack: extra?.stack ? String(extra.stack).slice(0, 4000) : undefined,
    meta: extra?.meta,
  }
  errBuf.push(entry)
  while (errBuf.length > MAX) errBuf.shift()
  if (level === "error") {
    try {
      console.error(`[selfforge:${source}] ${message}`)
    } catch {}
  }
  return entry
}

export function dashLogList(limit = 50): DashLogEntry[] {
  const n = Math.max(1, Math.min(MAX, Number(limit) || 50))
  return errBuf.slice(-n).reverse()
}

export function dashLogClear(): { cleared: number } {
  const n = errBuf.length
  errBuf.length = 0
  return { cleared: n }
}

export function dashLogCount(): { total: number; errors: number; warns: number } {
  let errors = 0
  let warns = 0
  for (const e of errBuf) {
    if (e.level === "error") errors++
    else if (e.level === "warn") warns++
  }
  return { total: errBuf.length, errors, warns }
}

// --- Persistent call logging (JSONL file) ---

/** Ensure log dir exists. */
function ensureLogDir(): void {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
  } catch {}
}

/** Record a data-type operation call and persist to JSONL. */
export function recordCall(type: string, method: string, detail?: string): void {
  callCounter++
  callCounters.set(type, (callCounters.get(type) || 0) + 1)
  const rec: CallRecord = {
    id: callCounter,
    ts: new Date().toISOString(),
    type,
    method,
    detail: detail ? String(detail).slice(0, 200) : undefined,
  }
  recentBuf.push(rec)
  while (recentBuf.length > MAX_RECENT) recentBuf.shift()
  // Append to persistent log file
  try {
    ensureLogDir()
    appendFileSync(LOG_FILE, JSON.stringify(rec) + "\n", "utf8")
  } catch {}
}

/** Read the call log file for persistent stats. */
function readPersistedLogs(): CallRecord[] {
  try {
    if (!existsSync(LOG_FILE)) return []
    const raw = readFileSync(LOG_FILE, "utf8")
    return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as CallRecord)
  } catch { return [] }
}

/** Get call stats: counters, recent, per-day breakdown. */
export function getCallStats(): {
  counters: Record<string, number>
  recent: CallRecord[]
  byDay: Record<string, Record<string, number>>
  totalCalls: number
} {
  const counters: Record<string, number> = {}
  for (const [k, v] of callCounters) counters[k] = v
  const byDay: Record<string, Record<string, number>> = {}
  // Read persisted logs for full stats
  try {
    const all = readPersistedLogs()
    for (const r of all) {
      const day = (r.ts || "").slice(0, 10)
      if (!day) continue
      if (!byDay[day]) byDay[day] = {}
      byDay[day][r.type] = (byDay[day][r.type] || 0) + 1
    }
  } catch {}
  return {
    counters,
    recent: recentBuf.slice(-50).reverse(),
    byDay,
    totalCalls: callCounter,
  }
}

export function resetCallStats(): void {
  callCounters.clear()
  recentBuf.length = 0
  callCounter = 0
  try {
    writeFileSync(LOG_FILE, "", "utf8")
  } catch {}
}
