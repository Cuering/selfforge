import { getDb, getConfig, now, stamp } from "./db"
import { sessionSearch } from "./review"
import { recordPattern } from "./patterns"

/**
 * Decision repair (ported from MemOS `core/feedback` + `core/decision-repair`),
 * adapted to selfforge's zero-dependency, single-SQLite runtime.
 *
 * Two orthogonal feedback surfaces:
 *  - Tool layer: every tool call succeeds/fails -> a step-level signal.
 *  - User layer: free-text feedback classified deterministically.
 *
 * Both feed `runRepair`, which persists a repair draft (preference /
 * anti-pattern) subject to a failure-burst condition and a cooldown guard.
 * No LLM: classification and synthesis are deterministic.
 */

export type FeedbackShape = "positive" | "negative" | "preference" | "instruction" | "unknown"

export type ClassifiedFeedback = {
  shape: FeedbackShape
  confidence: number
  prefer?: string
  avoid?: string
}

export type SignalKind = "success" | "failure"

export type Signal = {
  id: number
  kind: SignalKind
  tool: string | null
  context: string | null
  err_code: string | null
  created_at: string
}

export type Repair = {
  id: number
  kind: string
  trigger: string
  scope: string | null
  draft: string
  evidence: string | null
  failure_count: number
  status: string
  created_at: string
  updated_at: string
}

export function repairConfig() {
  return {
    failureThreshold: Number(getConfig("repair_failure_threshold", "3")) || 3,
    windowSteps: Number(getConfig("repair_window_steps", "10")) || 10,
    cooldownMs: Number(getConfig("repair_cooldown_ms", "86400000")) || 0,
  }
}

// --- Signals ---------------------------------------------------------------

/** Record a tool-level success/failure signal. Returns the burst verdict. */
export function recordSignal(
  kind: SignalKind,
  tool: string,
  context?: string,
  errCode?: string
): { burst: boolean; failures: number; windowSize: number } {
  const db = getDb()
  const st = stamp()
  db.query(
    "INSERT INTO signals (uuid, origin, kind, tool, context, err_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(st.uuid, st.origin, kind, tool, context ?? null, errCode ?? null, now())
  return checkBurst(tool, context, errCode)
}

/** Anti-flapping burst check: failures in the last N signals with no success. */
export function checkBurst(tool: string, context?: string, errCode?: string): {
  burst: boolean
  failures: number
  windowSize: number
} {
  const cfg = repairConfig()
  const db = getDb()
  const recent = db
    .query(
      "SELECT kind, err_code, created_at FROM signals WHERE tool = ? AND context IS ? AND deleted = 0 ORDER BY id DESC LIMIT ?"
    )
    .all(tool, context ?? null, cfg.windowSteps) as Array<{ kind: string; err_code: string | null; created_at: string }>
  const failures = recent.filter((r) => r.kind === "failure").length
  const hasSuccess = recent.some((r) => r.kind === "success")
  const burst = failures >= cfg.failureThreshold && !hasSuccess
  return { burst, failures, windowSize: recent.length }
}

/** Clear the failure signal history for a scope (after a successful repair). */
export function clearSignals(tool: string, context?: string) {
  getDb()
    .query("UPDATE signals SET deleted = 1 WHERE tool = ? AND context IS ?")
    .run(tool, context ?? null)
}

// --- Classification --------------------------------------------------------

/** Strip punctuation and normalize whitespace for extracted fragments. */
function clean(fragment: string): string {
  return fragment
    .replace(/[.!?。！？]+$/g, "")
    .trim()
    .replace(/\s+/g, " ")
}

const PREFERENCE_PATTERNS: Array<{ re: RegExp; prefer: number; avoid: number }> = [
  { re: /\buse\s+(.+?)\s+instead\s+of\s+(.+?)\b[.!?]?$/i, prefer: 1, avoid: 2 },
  { re: /\bprefer\s+(.+?)\s+over\s+(.+?)\b[.!?]?$/i, prefer: 1, avoid: 2 },
  { re: /\b(?:next time|going forward|from now on)[:,]?\s+(.+?)\b[.!?]?$/i, prefer: 1, avoid: -1 },
  { re: /改用\s+(.+?)(?:而(?:不是|不用|非)\s+(.+?))?\b[。.!?]?$/, prefer: 1, avoid: 2 },
  { re: /用\s+(.+?)\s+代替\s+(.+?)\b[。.!?]?$/, prefer: 1, avoid: 2 },
  { re: /别?不要\s+(.+?)\s*[,，;；]\s*(?:改用|用)\s+(.+?)\b[。.!?]?$/, prefer: 2, avoid: 1 },
]

const NEGATIVE_PATTERNS = [
  /\b(wrong|not right|incorrect|bad|broken|doesn'?t work|not working|failed|no good|useless)\b/i,
  /不对|错了|不要这样|别这样|搞砸了|不行/,
]

const POSITIVE_PATTERNS = [
  /\b(great|thanks|thank you|perfect|excellent|nice|awesome|good job|well done|works|fixed|solved)\b/i,
  /好的|完美|搞定|太棒了|没问题|正确/,
]

const INSTRUCTION_PATTERNS = [
  /^(run|delete|create|install|remove|update|write|edit|add|change|try|use|call)\b/i,
  /\b(then|also|next)\s+(run|delete|create|install|remove|update|write|edit|add|try|use|call)\b/i,
  /^(请|麻烦|帮我|去)\s*(运行|删除|创建|安装|更新|编写|修改|添加|尝试|使用|调用)/,
]

/** Deterministic feedback classification — runs synchronously, no LLM. */
export function classifyFeedback(text: string): ClassifiedFeedback {
  if (!text || !text.trim()) return { shape: "unknown", confidence: 0.3 }
  const t = text.trim()

  for (const p of PREFERENCE_PATTERNS) {
    const m = t.match(p.re)
    if (m) {
      const prefer = p.prefer >= 0 ? clean(m[p.prefer]) : undefined
      const avoid = p.avoid >= 0 && m[p.avoid] ? clean(m[p.avoid]) : undefined
      return { shape: "preference", confidence: avoid ? 0.9 : 0.55, prefer, avoid }
    }
  }

  if (NEGATIVE_PATTERNS.some((re) => re.test(t))) {
    return { shape: "negative", confidence: 0.8 }
  }

  if (POSITIVE_PATTERNS.some((re) => re.test(t))) {
    return { shape: "positive", confidence: 0.75 }
  }

  if (INSTRUCTION_PATTERNS.some((re) => re.test(t))) {
    return { shape: "instruction", confidence: 0.5 }
  }

  return { shape: "unknown", confidence: 0.3 }
}

// --- Evidence --------------------------------------------------------------

/** Recent failure records for a scope, newest first. */
export function recentFailures(tool: string, context?: string, limit = 5): Signal[] {
  return getDb()
    .query(
      "SELECT id, kind, tool, context, err_code, created_at FROM signals WHERE tool = ? AND context IS ? AND kind = 'failure' AND deleted = 0 ORDER BY id DESC LIMIT ?"
    )
    .all(tool, context ?? null, limit) as Signal[]
}

/** Session-history evidence matching a keyword (tool name or err code). */
function evidenceFromHistory(keyword: string, limit = 5) {
  if (!keyword || keyword.length < 2) return []
  try {
    return sessionSearch(keyword, { limit }).map((h) => h.content)
  } catch {
    return []
  }
}

// --- Synthesis (template, no LLM) ------------------------------------------

export type RepairDraft = {
  preference?: string
  antiPattern?: string
  severity: "info" | "warn"
  confidence: number
}

/** Deterministic template draft grounded in the classified feedback / failures. */
export function templateDraft(
  classified: ClassifiedFeedback | undefined,
  failures: Signal[],
  tool?: string,
  errCode?: string,
  history: string[] = [],
  userText?: string
): RepairDraft | null {
  const preferText = classified?.prefer?.trim()
  const avoidText = classified?.avoid?.trim()

  let fallbackPrefer = history[0] ? trim200(history[0]) : undefined
  let fallbackAvoid = errCode ? `avoid ${tool} failing with ${errCode}` : undefined
  if (!fallbackAvoid && failures[0]?.err_code) fallbackAvoid = `avoid ${tool} failing with ${failures[0].err_code}`
  if (!fallbackAvoid && userText) fallbackAvoid = trim200(userText)
  if (!fallbackAvoid && tool && !preferText && !avoidText) fallbackAvoid = `avoid repeating failing approaches with ${tool}`

  if (!preferText && !avoidText && !fallbackPrefer && !fallbackAvoid) return null

  return {
    preference: preferText ? `Prefer: ${trim200(preferText)}` : fallbackPrefer ? `Prefer: ${trim200(fallbackPrefer)}` : undefined,
    antiPattern: avoidText ? `Avoid: ${trim200(avoidText)}` : fallbackAvoid ? `Avoid: ${trim200(fallbackAvoid)}` : undefined,
    severity: avoidText || fallbackAvoid ? "warn" : "info",
    confidence: classified?.confidence ?? (failures.length > 0 ? 0.6 : 0.4),
  }
}

function trim200(s: string): string {
  const firstLine = s.split("\n")[0] ?? s
  return firstLine.length > 200 ? firstLine.slice(0, 197) + "..." : firstLine
}

// --- Orchestration ---------------------------------------------------------

export type RunRepairInput = {
  trigger: "failure-burst" | "user.negative" | "user.preference" | "manual"
  tool?: string
  context?: string
  errCode?: string
  userText?: string
}

export type RunRepairResult =
  | { ok: true; repairId: number; draft: RepairDraft; trigger: RunRepairInput["trigger"]; skipped: false }
  | { ok: false; skipped: true; reason: string; trigger: RunRepairInput["trigger"] }

/**
 * Main repair entry. Two paths:
 *  - failure-burst: requires the anti-flap burst condition to hold.
 *  - user.negative / user.preference / manual: user text is ground truth.
 * Cooldown guards repeats; everything is persisted to `repairs`.
 */
export function runRepair(input: RunRepairInput): RunRepairResult {
  const db = getDb()
  const cfg = repairConfig()
  const { trigger, tool, context, errCode } = input

  const scope = tool ? (context ? `${tool}${context ? "|" + context : ""}` : tool) : context ?? null

  // classify user feedback when present
  let classified: ClassifiedFeedback | undefined
  if (input.userText) {
    classified = classifyFeedback(input.userText)
    if (trigger === "manual" && classified.shape === "positive") {
      return { ok: false, skipped: true, reason: "positive-feedback", trigger }
    }
  }

  // cooldown: no repeat repair for the same scope too soon
  if (scope) {
    const recent = db
      .query("SELECT created_at FROM repairs WHERE scope = ? AND status IN ('draft','accepted') AND deleted = 0 ORDER BY id DESC LIMIT 1")
      .get(scope) as { created_at: string } | undefined
    if (recent && cfg.cooldownMs > 0) {
      const age = Date.now() - new Date(recent.created_at).getTime()
      if (age < cfg.cooldownMs) {
        return { ok: false, skipped: true, reason: "cooldown", trigger }
      }
    }
  }

  // failure-burst path requires the burst condition
  if (trigger === "failure-burst" && tool) {
    const burst = checkBurst(tool, context, errCode)
    if (!burst.burst) {
      return { ok: false, skipped: true, reason: "no-burst", trigger }
    }
    // feed the pattern-signature candidate pool (zero-LLM induction source)
    recordPattern(tool, errCode, context, `burst|${tool}|${now().slice(0, 10)}`)
  }

  const failures = tool ? recentFailures(tool, context) : []
  const keyword = tool ?? errCode ?? classified?.prefer ?? classified?.avoid ?? ""
  const history = evidenceFromHistory(keyword, 5)
  const draft = templateDraft(classified, failures, tool, errCode, history, input.userText)
  if (!draft) {
    return { ok: false, skipped: true, reason: "insufficient-evidence", trigger }
  }

  const st = stamp()
  const info = db
    .query(
      "INSERT INTO repairs (uuid, origin, kind, trigger, scope, draft, evidence, failure_count, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)"
    )
    .run(
      st.uuid,
      st.origin,
      draft.antiPattern ? "anti-pattern" : "preference",
      trigger,
      scope,
      JSON.stringify(draft),
      JSON.stringify({ failures: failures.slice(0, 3), history: history.slice(0, 3) }),
      failures.length,
      st.created_at,
      st.updated_at
    )

  // only clear the burst once the repair is persisted (a failed repair keeps
  // the counter armed so the next failure re-triggers)
  if (trigger === "failure-burst" && tool) {
    clearSignals(tool, context)
  }

  return { ok: true, repairId: Number(info.lastInsertRowid), draft, trigger, skipped: false }
}

// --- Repair list / accept / reject -----------------------------------------

export function repairList(opts?: { status?: string }): Repair[] {
  const where: string[] = ["deleted = 0"]
  const params: unknown[] = []
  if (opts?.status) {
    where.push("status = ?")
    params.push(opts.status)
  }
  return getDb()
    .query(`SELECT * FROM repairs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT 50`)
    .all(...params) as Repair[]
}

export function repairAccept(id: number) {
  const db = getDb()
  const row = db.query("SELECT * FROM repairs WHERE id = ? AND deleted = 0").get(id) as Repair | undefined
  if (!row) return { error: `No repair with id ${id}` }
  const draft = JSON.parse(row.draft || "{}") as RepairDraft
  const lines = [draft.preference, draft.antiPattern].filter(Boolean)
  db.query("UPDATE repairs SET status = 'accepted', updated_at = ? WHERE id = ?").run(now(), id)
  return { accepted: true, id, guidance: lines.join("\n") }
}

export function repairReject(id: number) {
  const db = getDb()
  const row = db.query("SELECT * FROM repairs WHERE id = ? AND deleted = 0").get(id) as Repair | undefined
  if (!row) return { error: `No repair with id ${id}` }
  db.query("UPDATE repairs SET status = 'rejected', deleted = 1, updated_at = ? WHERE id = ?").run(now(), id)
  return { rejected: true, id }
}

export function repairStatus() {
  const db = getDb()
  const byStatus = db
    .query("SELECT status, COUNT(*) AS n FROM repairs WHERE deleted = 0 GROUP BY status")
    .all() as Array<{ status: string; n: number }>
  const byTrigger = db
    .query("SELECT trigger, COUNT(*) AS n FROM repairs WHERE deleted = 0 GROUP BY trigger")
    .all() as Array<{ trigger: string; n: number }>
  return {
    byStatus,
    byTrigger,
    drafts: repairList({ status: "draft" }).map((r) => ({
      id: r.id,
      trigger: r.trigger,
      scope: r.scope,
      draft: JSON.parse(r.draft || "{}"),
      failure_count: r.failure_count,
      created_at: r.created_at,
    })),
  }
}
