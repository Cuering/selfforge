import { getDb, now, stamp } from "./db"
import { scheduleContextRefresh } from "./memory"

export type UserProfile = {
  id: number
  uuid: string | null
  origin: string | null
  keyword: string
  content: string
  created_at: string
  updated_at: string | null
  deleted: number
}

export function userAdd(keyword: string, content: string) {
  const db = getDb()
  const existing = db.query("SELECT * FROM user_profile WHERE keyword = ?").get(keyword) as UserProfile | undefined
  const ts = now()
  if (existing) {
    db.query(
      "UPDATE user_profile SET content = ?, updated_at = ?, deleted = 0 WHERE id = ?"
    ).run(content, ts, existing.id)
    scheduleContextRefresh()
    return { keyword, content, id: existing.id, uuid: existing.uuid }
  }
  const st = stamp()
  const info = db
    .query(
      "INSERT INTO user_profile (uuid, origin, keyword, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(st.uuid, st.origin, keyword, content, ts, ts)
  scheduleContextRefresh()
  return { keyword, content, id: Number(info.lastInsertRowid), uuid: st.uuid }
}

export function userList() {
  return getDb()
    .query("SELECT keyword, content, created_at FROM user_profile WHERE deleted = 0 ORDER BY created_at DESC")
    .all()
}

export function userRemove(keyword: string) {
  const res = getDb()
    .query("UPDATE user_profile SET deleted = 1, updated_at = ? WHERE keyword = ? AND deleted = 0")
    .run(now(), keyword)
  if (Number(res.changes) > 0) scheduleContextRefresh()
  return { removed: Number(res.changes) }
}
