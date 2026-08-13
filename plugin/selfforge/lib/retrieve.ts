/**
 * M1 检索增强：同义扩展 + 类型加权 + 相关度门槛。
 * 由 bench.ts 的 benchSearch 调用，替代内联评分。
 */
import { getDb } from "./db"

/** 最小相关度门槛：低于此值的候选不返回（H 隐私：低相关不再凑数泄漏）。 */
export const MIN_SCORE = 0.28

/** 中文/英文同义词扩展表（零 LLM，词典驱动）。 */
const SYNONYMS: Record<string, string[]> = {
  // 英文
  package_manager: ["pnpm", "npm", "yarn", "bun"],
  install: ["install", "installed", "setup", "added"],
  test: ["test", "tests", "testing", "check"],
  commit: ["commit", "commits", "push", "pushed", "merge", "merged", "PR"],
  run: ["run", "runs", "start", "launch", "execute"],
  city: ["city", "headquartered", "located", "based"],
  manager: ["manager", "supervisor", "boss", "lead", "managed by"],
  theme: ["theme", "dark mode", "light mode", "color scheme", "editor"],
  rate: ["rate", "limit", "per minute", "requests"],
  // 中文
  安装: ["安装", "装", "install", "setup"],
  测试: ["测试", "test", "tests", "check", "验证"],
  提交: ["提交", "commit", "push", "推送", "merge", "合并"],
  运行: ["运行", "run", "启动", "start", "执行"],
  城市: ["城市", "总部", "位于", "in", "headquartered"],
  老板: ["老板", "经理", "manager", "lead", "supervisor"],
  项目: ["项目", "工程", "project", "repo", "仓库"],
}

/** 生成 query 的扩展 token 集合（原词 + 同义词）。 */
export function expandQuery(query: string): Set<string> {
  const q = tokenize(query)
  const out = new Set(q)
  for (const t of q) {
    const syns = SYNONYMS[t]
    if (syns) for (const s of syns) out.add(s.toLowerCase())
  }
  return out
}

const STOPWORDS = new Set([
  "the", "for", "and", "are", "with", "from", "that", "this", "was", "were", "what", "which",
  "how", "who", "when", "where", "does", "do", "is", "of", "to", "in", "a", "an", "it", "at",
  "on", "use", "used", "using", "should", "not", "but", "also", "than", "then", "要", "的", "了",
  "和", "是", "吗", "呢", "什么", "哪个", "如何", "怎么", "应该", "还",
])

export function tokenize(s: string): Set<string> {
  return new Set(
    (s || "")
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t))
  )
}

function phraseScore(query: string, content: string): number {
  const q = (query || "").trim().toLowerCase()
  const c = (content || "").toLowerCase()
  if (!q) return 0
  return c.includes(q) ? 1 : 0
}

/** 判断一条记忆是否是偏好（E）或规则（G），返回加分。 */
export function typeBoost(content: string): { pref: number; rule: number } {
  const c = (content || "").toLowerCase()
  let pref = 0
  let rule = 0
  // E: 明确偏好/喜欢/希望/倾向
  if (/prefer|prefers|preference|likes|to use|preferred/.test(c) || /喜欢|偏好|希望|倾向/.test(c)) pref = 0.3
  // G: 明确规则前缀 / 命令式
  if (/^(rule|always|never|must|should|禁止|必须|规则|要求)/i.test(c.trim())) rule = 0.3
  // 通用命令式：以 force-only 动词开头的主祈使句
  if (/^(run|add|use|keep|open|deploy|apply|update|clean|执行|运行|使用|添加|保持|打开|部署|应用)/i.test(c.trim())) rule = 0.15
  return { pref, rule }
}

export type Retrieved = { id: string; content: string; score: number; created_at?: string }

/**
 * 增强检索：
 * 1) 词重叠（用扩展 query）
 * 2) 短语精确
 * 3) 近因
 * 4) 类型加分（E 偏好 / G 规则）
 * 5) 相关度门槛 MIN_SCORE（低相关不返回 → H 不泄漏弱相关）
 */
export function retrieve(input: {
  query: string
  user_id: string
  top_k?: number
  rows: Array<{ id: number; uuid: string; content: string; memory_ts: number; created_at: string }>
}): { data: Retrieved[] } {
  const query = String(input.query || "")
  const top_k = Math.max(1, Math.min(100, Number(input.top_k) || 100))
  if (!input.user_id) return { data: [] }

  if (!query) {
    // 空 query：返回最新（兜底）
    const out = input.rows
      .slice(-top_k)
      .reverse()
      .map((r) => ({ id: r.uuid, content: r.content, score: 0, created_at: r.created_at }))
    return { data: out }
  }

  const expanded = expandQuery(query)
  // C 时序意图：查询含 after/before/next/之前/然后 → 提高同会话相邻/后续 chunk 权重
  const temporalIntent = /(after|before|next|then|之后|之前|然后|接下来|finally|后来)/i.test(query)
  const scored = input.rows.map((r) => {
    const tokens = tokenize(r.content)
    let hits = 0
    for (const t of expanded) if (tokens.has(t)) hits++
    const overlap = expanded.size ? hits / expanded.size : 0
    const phrase = phraseScore(query, r.content)
    const recency = Math.max(0, Math.min(1, (Date.now() - (r.memory_ts || 0)) / 86400000 / 30))
    const { pref, rule } = typeBoost(r.content)
    let score = 0
    // 主题相关性是前提：必须命中至少一个词/短语，才在此之上加类型分与近因。
    if (overlap > 0 || phrase > 0) {
      score = overlap * 0.7 + phrase * 0.15 + (1 - recency) * 0.05 + pref + rule
    } else {
      // 零词命中也无短语 → 完全无关（即使规则/偏好句也不该进）
      score = 0
    }
    // C 轻时序：意图词命中时序标记（first/second/third/finally/先/最后/然后/后来）加分
    if (score > 0 && temporalIntent && /(first|second|third|finally|随后|随后|接着|先|后|然后)/i.test(r.content)) score += 0.25
    return { r, score }
  })
  const passing = scored.filter((s) => s.score >= MIN_SCORE)
  // H 隐私：低相关候选绝不兜底返回（跨 user 弱匹配会泄漏）。真实弱相关宁可丢。
  passing.sort((a, b) => b.score - a.score || b.r.id - a.r.id)
  const data = passing
    .slice(0, top_k)
    .map(({ r, score }) => ({ id: r.uuid, content: r.content, score: Math.round(score * 100) / 100, created_at: r.created_at }))
  return { data }
}