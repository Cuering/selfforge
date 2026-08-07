import { writeFileSync } from "fs"
import { join } from "path"
import { getDb, now, EVOLVE_HOME } from "./db"

export const CONTEXT_FILE = join(EVOLVE_HOME, "memory.context.md")

export type Memory = {
  id: number
  content: string
  source: string
  project: string | null
  strength: number
  tier: string
  created_at: string
  updated_at: string
  last_reinforced_at: string | null
  archived: number
}

function computeTier(strength: number): string {
  if (strength >= 5) return "hot"
  if (strength >= 2) return "warm"
  if (strength >= 1) return "cold"
  return "evictable"
}

export function memoryAdd(content: string, opts?: { source?: string; project?: string }) {
  const db = getDb()
  const ts = now()
  const info = db
    .query(
      "INSERT INTO memories (content, source, project, strength, tier, created_at, updated_at, last_reinforced_at, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)"
    )
    .run(
      content,
      opts?.source ?? "manual",
      opts?.project ?? null,
      1,
      computeTier(1),
      ts,
      ts,
      ts
    )
  return { id: Number(info.lastInsertRowid), content, tier: computeTier(1) }
}

export function memoryList(opts?: { archived?: boolean; tier?: string; limit?: number }): Memory[] {
  const where: string[] = []
  const params: unknown[] = []
  if (!opts?.archived) where.push("archived = 0")
  if (opts?.tier) {
    where.push("tier = ?")
    params.push(opts.tier)
  }
  const sql = `SELECT * FROM memories ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY strength DESC, last_reinforced_at DESC LIMIT ?`
  params.push(opts?.limit ?? 50)
  return getDb().query(sql).all(...params) as Memory[]
}

export function memoryStrengthen(keyword: string) {
  const db = getDb()
  const rows = db
    .query("SELECT * FROM memories WHERE archived = 0 AND content LIKE ?")
    .all(`%${keyword}%`) as Memory[]
  if (rows.length === 0) return { matched: 0, message: `No memory matches "${keyword}"` }
  const ts = now()
  for (const r of rows) {
    const newStrength = r.strength + 1
    db.query(
      "UPDATE memories SET strength = ?, tier = ?, updated_at = ?, last_reinforced_at = ? WHERE id = ?"
    ).run(newStrength, computeTier(newStrength), ts, ts, r.id)
  }
  return { matched: rows.length, ids: rows.map((r) => r.id) }
}

export function memoryWeaken(keyword: string) {
  const db = getDb()
  const rows = db
    .query("SELECT * FROM memories WHERE archived = 0 AND content LIKE ?")
    .all(`%${keyword}%`) as Memory[]
  if (rows.length === 0) return { matched: 0, message: `No memory matches "${keyword}"` }
  const ts = now()
  for (const r of rows) {
    const newStrength = Math.max(0, r.strength - 1)
    db.query(
      "UPDATE memories SET strength = ?, tier = ?, updated_at = ? WHERE id = ?"
    ).run(newStrength, computeTier(newStrength), ts, r.id)
  }
  return { matched: rows.length, ids: rows.map((r) => r.id) }
}

export function memoryRemove(keyword: string) {
  const db = getDb()
  const rows = db
    .query("SELECT * FROM memories WHERE content LIKE ?")
    .all(`%${keyword}%`) as Memory[]
  if (rows.length === 0) return { matched: 0, message: `No memory matches "${keyword}"` }
  for (const r of rows) {
    db.query("UPDATE memories SET archived = 1, updated_at = ? WHERE id = ?").run(now(), r.id)
  }
  return { archived: rows.length, ids: rows.map((r) => r.id) }
}

export function memorySummary(): { hot: number; warm: number; cold: number; evictable: number } {
  const rows = getDb()
    .query("SELECT tier, COUNT(*) AS n FROM memories WHERE archived = 0 GROUP BY tier")
    .all() as { tier: string; n: number }[]
  const out = { hot: 0, warm: 0, cold: 0, evictable: 0 }
  for (const r of rows) out[r.tier as keyof typeof out] = r.n
  return out
}

export function composeMemoryContext(): string {
  const memories = memoryList({ limit: 30 })
  const profile = getDb()
    .query("SELECT keyword, content FROM user_profile ORDER BY created_at DESC LIMIT 20")
    .all() as { keyword: string; content: string }[]
  let md = "# Evolve Memory\n\n<!-- Managed by unified-evolver. Do not edit manually. -->\n\n"
  if (profile.length > 0) {
    md += "## User Profile\n\n"
    for (const p of profile) md += `- **${p.keyword}**: ${p.content}\n`
    md += "\n"
  }
  if (memories.length === 0) {
    md += "_No persistent memories yet._\n"
    writeFileSync(CONTEXT_FILE, md)
    return md
  }
  md += "## Persistent Lessons\n\n"
  for (const m of memories) {
    md += `- [${m.tier}/${m.strength}] ${m.content}\n`
  }
  writeFileSync(CONTEXT_FILE, md)
  return md
}
