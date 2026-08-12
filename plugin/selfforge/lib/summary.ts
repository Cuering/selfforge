import { getDb, getConfig, now } from "./db"
import { isTrivial, truncate } from "./review"

/**
 * Feature 1 — fixed-size session state (MemTensor Metis analog).
 *
 * Metis compresses an interaction history into a compact native state so a
 * later query does not need to replay the original text. selfforge mirrors
 * that with `session_summaries`: after a conversation is distilled (or on
 * demand), the session's key user directives, decisions and open items are
 * reduced to a bounded digest that can be injected instead of replaying raw
 * transcript. Zero-LLM: facts are selected by declarative/preference signal
 * heuristics, truncated, deduped and capped.
 */

export type SessionSummaryRow = {
  id: number
  session_id: string
  summary: string
  fact_count: number
  covered_until_turn: number
  created_at: string
  updated_at: string
}

/** Declarative/preference signals that mark a sentence as a durable directive. */
const FACT_SIGNALS = [
  /\bi (?:want|prefer|need|like|use|always|never|should|would|tend|decide|decided|want to)\b/i,
  /\bwe (?:use|should|don't|do not|always|never|prefer|stick to|will use|deploy|ship|build|run|install)\b/i,
  /\b(?:prefer|preferred|usually|instead of|rather than|as a rule|remember|remember that|note that|important)\b/i,
  /(?:决定|偏好|喜欢|不喜欢|不要|应该|必须|记住|习惯|以后|采用|优先|避免|更新|修复|修改|调整|删除|增加|新增|创建|生成|检查|验证|测试|确认|清理|同步|提交|推送|改用|换成|替换|重启|启动|配置|统一|建议|希望|需要|要求|请|务必|注意|继续|打开|关闭|改为|改成|保留)/,
  /\b(?:requirement|constraint|convention|standard|must|always|never)\b/i,
]

function sentenceSplit(text: string): string[] {
  return (text || "")
    .replace(/\r/g, "")
    .split(/(?<=[。！？.!?;；])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Extract durable directive sentences from a single message. */
export function extractFacts(content: string): string[] {
  const out: string[] = []
  for (const s of sentenceSplit(content)) {
    if (s.length < 8 || s.length > 200) continue
    if (isTrivial(s)) continue
    if (FACT_SIGNALS.some((re) => re.test(s))) {
      out.push(truncate(s, 160))
      if (out.length >= 8) break
    }
  }
  return out
}

/** Dedupe near-identical facts (normalized lowercase). */
function dedupeFacts(facts: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const f of facts) {
    const key = f.toLowerCase().replace(/\s+/g, " ").trim()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}

/** Process-talk / acknowledgment — never a solution. */
const SOL_SKIP =
  /^(用户说|让我|请先|好的|明白|收到|正在|需要确认|让我检查|我先|我来|您|好[的吧]|可以|没问题|了解|这个|现在|首先|试试|看看|确认|先看|先查|稍等|等等|接下来|下面我|我来看|我会|我将|准备|开始)/i

/** Result / method signals that indicate real work product. */
const SOL_ACTION =
  /已修复|已修改|已改为|已完成|已添加|已删除|已更新|已创建|已生成|已解决|已实现|已改为|改成|改为|根因|原因是|修复为|写法是|步骤[：:]|方法[：:]|流程[：:]|方案[：:]|命令[：:]|路径[：:]|配置[：:]|使用\s|调用\s|执行\s|运行\s|fixed|changed|updated|created|added|removed|implemented|resolved|because|root cause|via\s|using\s/i

const SOL_METHOD =
  /步骤|方法|流程|方案|①|②|③|1[\.、)]|2[\.、)]|→|->|=>|先.+再|然后|接着|通过|把.+改[为成]|在.+中|文件|函数|模块|接口|参数|命令|脚本|路径|配置|rebuild|restart|sync|compose|hook|RPC|API/i

const CODE_BLOCK = /```[\s\S]*?```/g

/** Tokenize for overlap / quality checks (CJK + latin). */
function solTokens(s: string): Set<string> {
  return new Set(
    (s || "")
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .filter((t) => t.length > 1)
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / new Set([...a, ...b]).size
}

function cjkRatio(s: string): number {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  return s.length ? cjk / s.length : 0
}

export type SolutionQuality = {
  ok: boolean
  score: number
  reasons: string[]
  text: string
}

/**
 * Score whether a candidate solution is reusable method/result content.
 * Gate: score >= 4 and not pure process-talk / problem-echo.
 */
export function scoreSolution(candidate: string, problem?: string): SolutionQuality {
  const text = (candidate || "").trim()
  const reasons: string[] = []
  if (!text || text.length < 10) return { ok: false, score: 0, reasons: ["too_short"], text: "" }
  if (text.length > 220) return { ok: false, score: 0, reasons: ["too_long"], text: "" }
  if (isTrivial(text)) return { ok: false, score: 0, reasons: ["trivial"], text: "" }
  if (SOL_SKIP.test(text)) return { ok: false, score: 0, reasons: ["process_talk"], text: "" }

  let score = 1
  if (SOL_ACTION.test(text)) {
    score += 3
    reasons.push("action")
  }
  if (SOL_METHOD.test(text)) {
    score += 2
    reasons.push("method")
  }
  if (/```|`[^`]+`|\/[\w./-]+|\w+\.\w+\(/.test(text)) {
    score += 2
    reasons.push("concrete_ref")
  }
  if (cjkRatio(text) >= 0.25) {
    score += 1
    reasons.push("cjk")
  }
  // Penalize pure restatement of the user problem.
  if (problem) {
    const sim = jaccard(solTokens(text), solTokens(problem))
    if (sim >= 0.55) {
      score -= 4
      reasons.push("echo_problem")
    } else if (sim >= 0.4) {
      score -= 2
      reasons.push("near_echo")
    }
  }
  // "让我先…" buried mid-sentence still process-ish
  if (/让我|我先看|正在检查|需要确认/.test(text) && !SOL_ACTION.test(text)) {
    score -= 3
    reasons.push("hedge")
  }
  const ok = score >= 4 && !reasons.includes("echo_problem")
  return { ok, score, reasons, text: truncate(text, 140) }
}

type Scored = { text: string; score: number; idx: number; fromCode?: boolean }

/**
 * Extract a short, quality-gated solution from an assistant reply.
 * Prefer end-of-reply conclusions with method/action signal; reject process-talk
 * and problem-echo. Returns "" if nothing meets the quality bar (caller may omit).
 */
export function extractSolution(text: string, problem?: string): string {
  if (!text) return ""
  const sentences = sentenceSplit(text)
  const scored: Scored[] = []

  for (let i = 0; i < sentences.length; i++) {
    const raw = sentences[i].trim()
    if (raw.length < 10 || raw.length > 220) continue
    if (isTrivial(raw)) continue
    if (SOL_SKIP.test(raw)) continue
    const q = scoreSolution(raw, problem)
    // Keep near-misses for fallback ranking, but weight by quality score.
    // Position bias: later sentences slightly preferred (conclusion at end).
    const posBoost = sentences.length <= 1 ? 0 : (i / (sentences.length - 1)) * 1.5
    scored.push({ text: q.text || truncate(raw, 140), score: q.score + posBoost, idx: i })
  }

  // Code blocks: first non-empty line is often the concrete command/path.
  const codeMatch = text.match(CODE_BLOCK)
  if (codeMatch) {
    for (const block of codeMatch) {
      const lines = block.split("\n").slice(1, -1).map((l) => l.trim()).filter(Boolean)
      const line = lines.find((l) => l.length >= 6 && l.length <= 200 && !/^```/.test(l))
      if (!line) continue
      const q = scoreSolution(line, problem)
      // Code is concrete even without prose action words.
      const codeScore = Math.max(q.score, 4) + 2
      scored.push({ text: truncate(line, 140), score: codeScore, idx: sentences.length + 1, fromCode: true })
    }
  }

  if (scored.length === 0) return ""
  scored.sort((a, b) => b.score - a.score || b.idx - a.idx)
  const best = scored[0]
  const final = scoreSolution(best.text, problem)
  // Strict gate: must pass quality OR be a code line with decent score.
  if (final.ok || (best.fromCode && best.score >= 4)) return final.text || best.text
  // Soft accept high-scoring near-misses (score>=5 before gate) with method signal
  if (best.score >= 5.5 && SOL_METHOD.test(best.text)) return best.text
  return ""
}

/**
 * Build a compact "方法+步骤" line from the best 1–2 quality sentences + optional code.
 * Used by daily.refine. Still zero-LLM.
 */
export function refineSolution(asst: string, problem?: string): string {
  if (!asst) return ""
  const primary = extractSolution(asst, problem)
  const sentences = sentenceSplit(asst)
  const extras: string[] = []
  for (let i = sentences.length - 1; i >= 0 && extras.length < 2; i--) {
    const t = sentences[i].trim()
    if (!t || t === primary) continue
    const q = scoreSolution(t, problem)
    if (!q.ok) continue
    if (primary && jaccard(solTokens(primary), solTokens(q.text)) >= 0.5) continue
    extras.push(q.text)
  }
  // Prefer a code line as step if primary is prose-only.
  if (primary && !/`|\/\w|\.\w+\(/.test(primary)) {
    const codeMatch = asst.match(CODE_BLOCK)
    if (codeMatch) {
      const line = codeMatch[0].split("\n")[1]?.trim()
      if (line && line.length >= 6 && line.length <= 160) extras.unshift(truncate(line, 100))
    }
  }
  if (!primary && extras.length === 0) return ""
  if (!primary) return extras[0] || ""
  if (extras.length === 0) return primary
  const merged = `${primary} → ${extras[0]}`
  return truncate(merged, 180)
}

/** Cap summary output so injected state is bounded (Metis fixed-size state). */
function capSummary(facts: string[]): { summary: string; fact_count: number } {
  const maxFacts = Number(getConfig("session_summary_max_facts", "10")) || 10
  const maxLen = Number(getConfig("session_summary_max_chars", "1200")) || 1200
  const capped = facts.slice(0, maxFacts)
  let text = ""
  for (let i = 0; i < capped.length; i++) {
    const line = `${i + 1}. ${capped[i]}`
    if (text.length + line.length + 1 > maxLen) break
    text += (text ? "\n" : "") + line
  }
  return { summary: text, fact_count: capped.length }
}

/**
 * Distill a session's buffered messages into a compact summary and upsert it.
 * `coveredUntilTurn` records how far the digest has consumed, so later calls
 * can rebuild incrementally.
 */
export function summarizeSession(
  sessionId: string,
  messages: Array<{ role: string; content: string }>,
  coveredUntilTurn?: number
): SessionSummaryRow {
  const facts: string[] = []
  for (const msg of messages) {
    if (msg.role !== "user") continue
    if (isTrivial(msg.content)) continue
    facts.push(...extractFacts(msg.content))
  }
  const uniq = dedupeFacts(facts)
  const { summary, fact_count } = capSummary(uniq)
  const ts = now()
  const db = getDb()
  const existing = getSessionSummary(sessionId)
  const turn = coveredUntilTurn ?? existing?.covered_until_turn ?? 0
  if (existing) {
    db.query(
      "UPDATE session_summaries SET summary = ?, fact_count = ?, covered_until_turn = ?, updated_at = ? WHERE session_id = ?"
    ).run(summary, fact_count, turn, ts, sessionId)
  } else {
    db.query(
      "INSERT INTO session_summaries (session_id, summary, fact_count, covered_until_turn, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(sessionId, summary, fact_count, turn, ts, ts)
  }
  return getSessionSummary(sessionId) as SessionSummaryRow
}

export function getSessionSummary(sessionId: string): SessionSummaryRow | null {
  return (getDb().query("SELECT * FROM session_summaries WHERE session_id = ?").get(sessionId) as SessionSummaryRow | undefined) ?? null
}

export function sessionSummaryList(opts?: { limit?: number }): SessionSummaryRow[] {
  return getDb()
    .query("SELECT * FROM session_summaries ORDER BY updated_at DESC LIMIT ?")
    .all(opts?.limit ?? 20) as SessionSummaryRow[]
}

/** Render a session summary as an injectable compact state block. */
export function renderSessionState(sessionId: string): string | null {
  const s = getSessionSummary(sessionId)
  if (!s || !s.summary) return null
  return `## Session State\n\n<!-- fixed-size session summary (distilled, not a transcript replay) -->\n${s.summary}\n`
}

/** Skills/领域分类规则:用于把一条事项归入可读的中文主题。 */
const KIND_RULES: Array<[string, RegExp]> = [
  ["文档/GitHub", /readme|github|文档|README|仓库|发布|issues?/i],
  ["界面/UI", /界面|标签|按钮|排版|布局|面板|主题|颜色|视图|显示|拖动|滚动|图标|UI/i],
  ["数据/清理", /删除|清理|测试数据|合并|重命名|移除|去重|清理脏/i],
  ["记忆/复盘", /记忆|总结|每日总结|观测|复盘|review|蒸馏|要点/i],
  ["功能/能力", /功能|检查|验证|生成|插件|安装|加载|构建|测试|运行|支持|适配|兼容|修复/i],
  ["工作区", /工作区|目录|文件夹|workspace|路径/i],
  ["目标/检查点", /目标|检查点|goals?|checkpoint|进行中/i],
  ["迁移/同步", /迁移|同步|导入|导出|team|snapshot|节点/i],
  ["其他", /.*/s],
]

function classifyKind(text: string): string {
  for (const [kind, re] of KIND_RULES) if (re.test(text)) return kind
  return "其他"
}

const DONE_RE =
  /已完成|已修复|已提交|已推送|已生成|已删除|已更新|已实现|已添加|已同步|已清理|已处理|已补充|已解决|完成|搞定|成功|done|fixed|pushed|committed|merged|implemented|已就绪/i
const PENDING_RE = /未完成|还没|有待|还需要|尚未|失败|报错|无法|卡住|仍然|待办|想问|还需要|还会|有问题|请修复|请检查|仍然后/i

/** 从 assistant 回复推断该事项的落实状态。 */
function statusOf(assistantText: string): "done" | "pending" | "info" {
  if (!assistantText) return "info"
  if (DONE_RE.test(assistantText)) return "done"
  if (PENDING_RE.test(assistantText)) return "pending"
  return "info"
}

export type DailyItem = {
  text: string
  kind: string
  status: "done" | "pending" | "info"
}

export type DailySummary = {
  day: string
  session_count: number
  fact_count: number
  done_count: number
  pending_count: number
  review: string
  kind_breakdown: Array<{ kind: string; count: number }>
  items: DailyItem[]
}

/**
 * Extract the last assistant reply from each session as a summary item.
 * Uses the final assistant message (the summarizing conclusion/result).
 */
/**
 * Extract the last 1-2 conclusion sentences from the assistant's final reply.
 * Walks sentences from the end, picks the first non-trivial, non-process-talk
 * sentences.  This is the most reliable heuristic for "the AI's final summary".
 */
function extractConclusion(text: string): string {
  const sentences = sentenceSplit(text)
  const picks: string[] = []
  for (let i = sentences.length - 1; i >= 0 && picks.length < 2; i--) {
    const s = sentences[i].trim()
    if (s.length < 8 || isTrivial(s)) continue
    if (/^让我|我来|我先|请先|好的|明白|收到|正在|需要/.test(s)) continue
    picks.push(s)
  }
  if (picks.length === 0) return ""
  const result = picks.length > 1 ? picks.reverse().join(" → ") : picks[0]
  return truncate(result.replace(/\s+/g, " ").trim(), 300)
}

/** Strong completion markers — a message carrying one is a real conclusion. */
const STRONG_DONE_RE =
  /已完成|已修复|已改为|已解决|已提交|已推送|已生成|已删除|已更新|已实现|已添加|已同步|已创建|已设|完成|搞定|成功|done|fixed|pushed|committed|merged|implemented|总结|结论|答案|已就绪|已改|已修|已收尾/i

/**
 * For each session, pick the most recent assistant message that carries a
 * strong completion marker (a real conclusion). If the last message itself
 * has none, walk back to find the latest conclusion-marked one. Then extract
 * its last conclusion sentences.
 */
function extractFinalAssistants(
  rows: Array<{ id: number; session_id: string; role: string; content: string; created_at: string }>
): Map<string, Array<{ session_id: string; text: string }>> {
  const byDay = new Map<string, Array<{ session_id: string; text: string }>>()
  // rows are ordered by id DESC (newest first). Collect all assistant msgs per session.
  const sessions = new Map<string, { day: string; msgs: string[] }>()
  const dayOfSession = new Map<string, string>()
  for (const r of rows) {
    const day = (r.created_at || "").slice(0, 10)
    if (!day) continue
    dayOfSession.set(r.session_id, day)
    if (r.role !== "assistant") continue
    const cur = sessions.get(r.session_id) || { day, msgs: [] }
    cur.msgs.push(r.content)
    sessions.set(r.session_id, cur)
  }
  for (const [sid, info] of sessions) {
    const day = info.day || dayOfSession.get(sid) || ""
    if (!day) continue
    // newest first (push order = descending). Find first conclusion-marked msg.
    let source = info.msgs[0] || ""
    for (const m of info.msgs) {
      if (STRONG_DONE_RE.test(m)) {
        source = m
        break
      }
    }
    if (!source || isTrivial(source)) continue
    const text = extractConclusion(source)
    if (text.length < 10) continue
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day)!.push({ session_id: sid, text })
  }
  return byDay
}

/**
 * Aggregate per-day digests showing the assistant's final summary reply
 * from each session. Reads the raw message store, finds the last assistant
 * message per session, and presents it as the daily summary item.
 */
export function dailySummaries(opts?: { limit?: number }): DailySummary[] {
  const db = getDb()
  const rows = db
    .query(
      "SELECT id, session_id, role, content, created_at FROM session_messages ORDER BY id DESC LIMIT 4000"
    )
    .all() as Array<{ id: number; session_id: string; role: string; content: string; created_at: string }>
  const byDay = extractFinalAssistants(rows)
  const out: DailySummary[] = []
  for (const [day, entries] of byDay.entries()) {
    const items: DailyItem[] = []
    const seen = new Set<string>()
    for (const e of entries) {
      const key = e.text.toLowerCase().slice(0, 60)
      if (seen.has(key)) continue
      seen.add(key)
      items.push({
        text: truncate(e.text, 300),
        kind: classifyKind(e.text),
        status: statusOf(e.text),
      })
    }
    if (items.length === 0) continue
    const done = items.filter((i) => i.status === "done").length
    const pending = items.filter((i) => i.status === "pending").length
    const kindMap = new Map<string, number>()
    for (const it of items) kindMap.set(it.kind, (kindMap.get(it.kind) ?? 0) + 1)
    const kindBreakdown = [...kindMap.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b2) => b2.count - a.count)
      .slice(0, 5)
    const topKinds = kindBreakdown
      .slice(0, 3)
      .map((k) => `「${k.kind}」×${k.count}`)
      .join("、")
    const review = `共 ${items.length} 条会话结论,集中在 ${topKinds || "一般"}。已落实 ${done} 条、待跟进 ${pending} 条。`
    const sessionIds = new Set(entries.map((e) => e.session_id))
    out.push({
      day,
      session_count: sessionIds.size,
      fact_count: items.length,
      done_count: done,
      pending_count: pending,
      review,
      kind_breakdown: kindBreakdown,
      items: items.slice(0, 20),
    })
  }
  out.sort((a, b) => (a.day < b.day ? 1 : -1))
  const limit = opts?.limit ?? 14
  return out.filter((x) => x.day).slice(0, limit)
}
