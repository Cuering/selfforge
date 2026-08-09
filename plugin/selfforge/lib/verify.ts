import { getDb } from "./db"
import { sessionSearch } from "./review"

/**
 * Skill anti-hallucination verification (ported from MemOS `core/skill/verifier.ts`).
 * Two deterministic checks, no LLM:
 *
 * 1. **Tool coverage** — every tool/command name declared in the skill body
 *    must appear in ground-truth evidence. In selfforge the ground truth is
 *    the structured `signals.tool` set (real tool ids the agent actually
 *    invoked) plus command tokens in session history. Catches invented
 *    tool/command names — the most common LLM distillation hallucination.
 *
 * 2. **Evidence resonance** — at least `minResonance` of the evidence
 *    messages share >= 2 tokens with the skill body. Prevents a skill whose
 *    narrative contradicts / drifts from the examples it came from.
 *
 * Returns a verdict; the caller decides how to act (advisory vs blocking).
 */

const RESONANCE_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "will", "then",
  "into", "when", "what", "where", "your", "user", "agent", "null", "true",
  "false", "none", "let", "new", "old", "use", "used", "have", "has", "its",
  "not", "any", "can", "does", "only", "just", "like", "please", "step",
  "steps", "body", "title", "summary", "task", "tasks", "run", "see", "end",
  "our", "their", "them", "being", "make", "made", "thing", "things",
])

/** Tokenize like MemOS: ascii tool-like tokens + CJK bigrams. */
export function tokensOf(s: string): Set<string> {
  const out = new Set<string>()
  const asciiMatches = (s || "").toLowerCase().match(/[a-z0-9_][a-z0-9_./-]{2,}/g) ?? []
  for (const m of asciiMatches) {
    if (RESONANCE_STOPWORDS.has(m)) continue
    out.add(m)
  }
  const cjkRuns = (s || "").match(/[\u4e00-\u9fff\u3040-\u30ff\u3400-\u4dbf]{2,}/g) ?? []
  for (const run of cjkRuns) {
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
  }
  return out
}

/**
 * Ground-truth tool set: distinct `tool` ids from the signals table (the
 * agent really called these) plus command first-tokens from recent session
 * messages (shell-like commands like `apk`, `bun`).
 */
export function evidenceTools(limit = 200): Set<string> {
  const out = new Set<string>()
  try {
    const rows = getDb()
      .query("SELECT DISTINCT tool FROM signals WHERE tool IS NOT NULL AND tool != '' AND deleted = 0 ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<{ tool: string }>
    for (const r of rows) out.add(r.tool.toLowerCase())
  } catch {}
  return out
}

/** Command-level names from evidence text (first token of code-fenced lines). */
export function evidenceCommandTokens(history: string[]): Set<string> {
  const out = new Set<string>()
  for (const h of history) {
    const fences = h.match(/```(?:[\s\S]*?)```/g) ?? []
    for (const f of fences) {
      for (const line of f.split("\n")) {
        const first = line.trim().split(/\s+/)[0]?.toLowerCase()
        if (first && first.length >= 2 && !first.startsWith("```")) out.add(first)
      }
    }
  }
  return out
}

/**
 * Draft tool candidates from a SKILL.md body: first token of every
 * non-comment code-fenced line + known tool-id patterns in prose.
 */
export function draftTools(body: string): string[] {
  const out = new Set<string>()
  const fences = body.match(/```[\s\S]*?```/g) ?? []
  for (const f of fences) {
    const lines = f.split("\n").slice(1)
    for (const line of lines) {
      const t = line.trim()
      if (!t || t.startsWith("#") || t.startsWith("//") || t.startsWith(":") || t.startsWith("```")) continue
      const first = t.split(/\s+/)[0]?.toLowerCase()
      if (first && first.length >= 2) out.add(first)
    }
  }
  // tool-id patterns in prose: `bun run`, `npm i`, or tool(name)
  const prose = body.replace(/```[\s\S]*?```/g, "")
  const ids = prose.match(/\b[a-z][a-z0-9_.-]{2,}\b/g) ?? []
  for (const id of ids) {
    const low = id.toLowerCase()
    if (low.includes(".") || KNOWN_TOOL_IDS.has(low)) out.add(low)
  }
  return [...out]
}

/** Curated known tool ids (used to lift prose tool references). */
const KNOWN_TOOL_IDS = new Set([
  "shell", "edit", "read", "write", "glob", "grep", "bash", "task", "skill",
  "bash", "webfetch", "websearch", "browser", "bun", "node", "npm", "npx",
  "yarn", "pnpm", "git", "docker", "curl", "wget", "python", "pip", "pip3",
  "cargo", "go", "rustc", "java", "mvn", "gradle", "ruby", "gem", "php",
  "composer", "make", "cmake", "apt", "apt-get", "apk", "yum", "brew",
  "sqlite3", "psql", "mysql", "redis-cli", "ffmpeg", "rg", "jq",
])

export type VerifyResult = {
  ok: boolean
  coverage: number
  resonance: number
  draftTools: string[]
  unmapped: string[]
  reason?: string
  evidenceCount: number
}

export function verifySkillDraft(opts: {
  name: string
  description?: string
  body: string
  minResonance?: number
  evidenceLimit?: number
}): VerifyResult {
  const minResonance = opts.minResonance ?? 0.5

  // gather evidence: recent session messages matching the skill's keywords
  const keywords = [opts.name, opts.description]
    .filter(Boolean)
    .join(" ")
    .split(/[\s-]+/)
    .filter((w) => w.length >= 3)
    .slice(0, 3)
  let history: string[] = []
  const query = keywords.join(" ") || opts.name
  if (query.trim().length >= 2) {
    history = sessionSearch(query, { limit: opts.evidenceLimit ?? 8 }).map((h) => h.content)
  }
  const evidence = [...new Set(history)]

  if (evidence.length === 0) {
    return {
      ok: false,
      coverage: 0,
      resonance: 0,
      draftTools: [],
      unmapped: [],
      reason: "no-evidence",
      evidenceCount: 0,
    }
  }

  // tool coverage
  const groundTools = evidenceTools()
  const cmdTools = evidenceCommandTokens(evidence)
  const allGround = new Set<string>([...groundTools, ...cmdTools])
  const declared = draftTools(opts.body || "")
  const unmapped: string[] = []
  for (const t of declared) {
    if (!allGround.has(t) && !KNOWN_TOOL_IDS.has(t)) unmapped.push(t)
  }
  // coverage = matched declared tools / declared tools (unmapped penalises)
  const coverage = declared.length === 0 ? 1 : 1 - unmapped.length / declared.length

  // evidence resonance
  const needle = [opts.name, opts.description, opts.body].filter(Boolean).join(" ").toLowerCase()
  const draftTok = tokensOf(needle)
  if (draftTok.size === 0) {
    return { ok: false, coverage, resonance: 0, draftTools: declared, unmapped, reason: "no-tokens", evidenceCount: evidence.length }
  }
  let hit = 0
  for (const e of evidence) {
    const toks = tokensOf(e)
    let overlap = 0
    for (const tok of draftTok) if (toks.has(tok)) overlap += 1
    if (overlap >= 2) hit += 1
  }
  const resonance = hit / evidence.length

  const ok = coverage >= 0.5 && resonance >= minResonance
  return {
    ok,
    coverage,
    resonance,
    draftTools: declared,
    unmapped,
    reason: ok ? undefined : `coverage=${coverage.toFixed(2)}, resonance=${resonance.toFixed(2)}`,
    evidenceCount: evidence.length,
  }
}
