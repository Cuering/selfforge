/**
 * In-memory ring buffer of dashboard / RPC runtime errors.
 * Survives across requests within one daemon process; cleared on restart.
 * Front-end error panel + /api/errors + diagnostics.list/clear use this.
 */
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
const buf: DashLogEntry[] = []
let seq = 0

export function dashLog(
  level: DashLogEntry["level"],
  source: string,
  message: string,
  extra?: { stack?: string; meta?: Record<string, unknown> }
): DashLogEntry {
  const entry: DashLogEntry = {
    id: ++seq,
    ts: new Date().toISOString(),
    level,
    source: String(source || "unknown").slice(0, 80),
    message: String(message || "").slice(0, 2000),
    stack: extra?.stack ? String(extra.stack).slice(0, 4000) : undefined,
    meta: extra?.meta,
  }
  buf.push(entry)
  while (buf.length > MAX) buf.shift()
  if (level === "error") {
    try {
      console.error(`[selfforge:${source}] ${message}`)
    } catch {}
  }
  return entry
}

export function dashLogList(limit = 50): DashLogEntry[] {
  const n = Math.max(1, Math.min(MAX, Number(limit) || 50))
  return buf.slice(-n).reverse()
}

export function dashLogClear(): { cleared: number } {
  const n = buf.length
  buf.length = 0
  return { cleared: n }
}

export function dashLogCount(): { total: number; errors: number; warns: number } {
  let errors = 0
  let warns = 0
  for (const e of buf) {
    if (e.level === "error") errors++
    else if (e.level === "warn") warns++
  }
  return { total: buf.length, errors, warns }
}
