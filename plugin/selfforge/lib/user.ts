import { getDb, now } from "./db"

export function userAdd(keyword: string, content: string) {
  getDb()
    .query(
      "INSERT INTO user_profile (keyword, content, created_at) VALUES (?, ?, ?) ON CONFLICT(keyword) DO UPDATE SET content = excluded.content"
    )
    .run(keyword, content, now())
  return { keyword, content }
}

export function userList() {
  return getDb()
    .query("SELECT keyword, content, created_at FROM user_profile ORDER BY created_at DESC")
    .all()
}

export function userRemove(keyword: string) {
  const res = getDb().query("DELETE FROM user_profile WHERE keyword = ?").run(keyword)
  return { removed: Number(res.changes) }
}
