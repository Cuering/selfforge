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

/** Extract a short solution sentence from an assistant reply. */
function extractSolution(text: string): string {
  if (!text) return ""
  for (const s of sentenceSplit(text)) {
    const t = s.trim()
    if (t.length < 8 || t.length > 200) continue
    if (isTrivial(t)) continue
    return truncate(t, 140)
  }
  return ""
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

export type DailyItem = { problem: string; solution: string; kind: string; status: "done" | "pending" | "info" }

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
 * Aggregate per-day digests into a structured review (local calendar day),
 * newest first. Reads the raw message store directly so a day's review shows
 * even if the review pipeline never ran. Sorts each day's facts by their kind
 * and infers a done/pending status from the assistant replies so the panel
 * reads like a real retrospective instead of a paste of inputs.
 */
export function dailySummaries(opts?: { limit?: number }): DailySummary[] {
  const db = getDb()
  const rows = db
    .query(
      "SELECT id, session_id, role, content, created_at FROM session_messages ORDER BY id DESC LIMIT 4000"
    )
    .all() as Array<{ id: number; session_id: string; role: string; content: string; created_at: string }>
  const byDay = new Map<string, { sessions: Set<string>; pairs: Array<{ user: string; asst: string }> }>()
  // Pair each user message with the next assistant reply (same session, later id).
  const ordered = [...rows].sort((a, b) => a.id - b.id)
  const lone = new Map<string, { sid: string; day: string; content: string }>()
  for (const r of ordered) {
    const day = (r.created_at || "").slice(0, 10)
    if (!day) continue
    let bucket = byDay.get(day)
    if (!bucket) {
      bucket = { sessions: new Set(), pairs: [] }
      byDay.set(day, bucket)
    }
    bucket.sessions.add(r.session_id)
    if (r.role === "user") {
      lone.set(r.session_id, { sid: r.session_id, day, content: r.content })
    } else if (r.role === "assistant") {
      const prior = lone.get(r.session_id)
      bucket.pairs.push({ user: prior?.content ?? "", asst: r.content })
      if (prior) lone.delete(r.session_id)
    }
  }
  // Flush user messages that never got an assistant reply (still worth showing).
  for (const { day, content } of lone.values()) {
    byDay.get(day)?.pairs.push({ user: content, asst: "" })
  }
  const out: DailySummary[] = []
  for (const [day, b] of byDay.entries()) {
    const items: DailyItem[] = []
    const seen = new Set<string>()
    for (const p of b.pairs) {
      if (p.user) {
        const solution = extractSolution(p.asst)
        for (const f of extractFacts(p.user)) {
          const key = f.toLowerCase().replace(/\s+/g, " ").trim()
          if (seen.has(key)) continue
          seen.add(key)
          items.push({ problem: f, solution, kind: classifyKind(f), status: statusOf(p.asst) })
        }
      }
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
    const review = `共 ${items.length} 条事项,集中在 ${topKinds || "一般"}。已落实 ${done} 条、待跟进 ${pending} 条、其余 ${items.length - done - pending} 条为新信息。`
    out.push({
      day,
      session_count: b.sessions.size,
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
