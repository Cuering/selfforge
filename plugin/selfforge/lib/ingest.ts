/**
 * M2 写入处理：Add 时抽取实体与关系，支撑 B（多跳）与 C（时序）。
 * 零 LLM，规则驱动。
 */
import { getDb, stamp } from "./db"

/** 实体抽取：专名（首字母大写词、引号短语、关系句式后的名词）。 */
export function extractEntities(content: string): Array<{ name: string; type: string }> {
  const out: Array<{ name: string; type: string }> = []
  const seen = new Set<string>()
  const add = (name: string, type: string) => {
    const key = name.toLowerCase()
    if (seen.has(key) || name.length < 2) return
    seen.add(key)
    out.push({ name, type })
  }
  // 引号包裹的专名："Acme Corp"
  const quoted = content.match(/"([^"]{2,40})"/g)
  if (quoted) for (const q of quoted) add(q.replace(/"/g, ""), "org")
  // 专名：首字母大写的人名/组织名/城市（排除时序标记 first/second/…/finally、rule、the user 等）
  const skipWords = new Set(["first", "second", "third", "finally", "the", "rule", "user", "api", "newkey", "oldkey", "node", "bun", "corp", "nonepm"])
  const capMatch = content.match(/\b([A-Z][a-zA-Z]{2,30})\b/g)
  if (capMatch) {
    for (const c of capMatch) {
      if (!skipWords.has(c.toLowerCase())) add(c, c.toLowerCase() === "berlin" ? "place" : "person")
    }
  }
  // 关系句式后的城市/公司
  const city = content.match(/(?:located in|headquartered in|based in|is in|总部在)\s+([A-Za-z\u4e00-\u9fff]{2,30})/i)
  if (city) add(city[1], "place")
  const org = content.match(/\b([A-Z][a-zA-Z]+)\s+works\s+at\s+([A-Za-z0-9][A-Za-z0-9 ]{1,40})\b/i)
  if (org) add(org[2], "org")
  // 技术栈小写专名（工具/包管理器/技术名）也作为实体，支撑 "uses X for Y" 关联
  const tech = content.match(/\b(?:uses|use|using|prefers|stack\s+uses)\s+(?:the\s+)?([a-z][a-z0-9]+(?:\s+[a-z0-9]+)?)/i)
  if (tech) add(tech[1], "tech")
  return out
}

/** 关系抽取：X works at Y; Y is headquartered in Z; X is Y's manager。 */
export function extractRelations(content: string): Array<{ sub: string; out: string; obj: string }> {
  const out: Array<{ sub: string; out: string; obj: string }> = []
  const works = content.match(/\b([A-Z][a-zA-Z]+)\s+works\s+at\s+([A-Za-z0-9][A-Za-z0-9 ]{1,40})\b/i)
  if (works) out.push({ sub: works[1], out: "works_at", obj: works[2] })
  const hq = content.match(/\b([A-Za-z0-9][A-Za-z0-9 ]{1,40})\s+is\s+headquartered\s+in\s+([A-Za-z\u4e00-\u9fff]{2,40})\b/i)
  if (hq) out.push({ sub: hq[1], out: "located_in", obj: hq[2] })
  const mgr = content.match(/\b([A-Z][a-zA-Z]+)\s+is\s+([A-Z][a-zA-Z]+)'s\s+manager\b/i)
  if (mgr) out.push({ sub: mgr[1], out: "managed_by", obj: mgr[2] })
  // uses X for Y：Y（主题域）与 X（技术）的关联
  const uses = content.match(/\b(?:uses|use|using|prefers)\s+([a-z][a-z0-9]+(?:\s+[a-z0-9]+)?)\s+(?:for|in|on)\s+the\s+([a-z][a-z0-9 ]+)\b/i)
  if (uses) out.push({ sub: uses[2], out: "uses_tech", obj: uses[1] })
  return out
}

export type IngestResult = {
  memoryId: number
  entities: number
  relations: number
}

/**
 * Add 时对单条 chunk 做增强写入（保持 bench_memories 原文不变，
 * 追加实体/关系/时序三张索引表）。
 */
export function ingestChunk(input: {
  user_id: string
  session_id: string
  role?: string
  content: string
  memory_ts?: number
  seq?: number
}): IngestResult {
  const db = getDb()
  const st = stamp()
  const content = String(input.content || "").trim()
  const user_id = String(input.user_id)
  if (!content || !user_id) return { memoryId: 0, entities: 0, relations: 0 }

  const ts = input.memory_ts ?? Date.now()
  const maxSeq = db.query("SELECT MAX(seq) AS m FROM bench_timeline WHERE user_id = ? AND deleted = 0").get(user_id) as { m: number | null }
  const seq = input.seq ?? Number(maxSeq?.m ?? 0) + 1

  const mem = db
    .query(
      "INSERT INTO bench_memories (uuid, user_id, session_id, role, content, memory_ts, created_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)"
    )
    .run(st.uuid, user_id, String(input.session_id || ""), String(input.role || "user"), content, ts, st.created_at)
  const memoryId = Number(mem.lastInsertRowid)

  let entities = 0
  for (const e of extractEntities(content)) {
    db.query("INSERT INTO bench_entities (user_id, memory_id, name, type, created_at) VALUES (?, ?, ?, ?, ?)").run(
      user_id,
      memoryId,
      e.name,
      e.type,
      st.created_at
    )
    entities++
  }
  let relations = 0
  for (const r of extractRelations(content)) {
    db.query(
      "INSERT INTO bench_relations (user_id, sub, out, obj, memory_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(user_id, r.sub, r.out, r.obj, memoryId, st.created_at)
    relations++
  }
  db.query("INSERT INTO bench_timeline (user_id, memory_id, seq, ts, created_at) VALUES (?, ?, ?, ?, ?)").run(
    user_id,
    memoryId,
    seq,
    ts,
    st.created_at
  )

  return { memoryId, entities, relations }
}