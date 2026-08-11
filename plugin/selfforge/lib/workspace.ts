import { existsSync, readFileSync, readdirSync } from "fs"
import { basename, join } from "path"
import { createHash } from "crypto"
import { getDb, getConfig, now, stamp } from "./db"
import type { Memory } from "./memory"

/**
 * Phase 2 — Work-environment awareness.
 *
 * A workspace is fingerprinted by its detectable "stack markers" (package.json,
 * pyproject.toml, go.mod, Cargo.toml, *.sln, Dockerfile, .github, etc.). The
 * fingerprint is a stable 12-hex hash of the sorted marker set, and a scope
 * key of the form `ws:<basename>:<hash>` is used to tag & retrieve
 * workspace-scoped memories without any embedding.
 *
 * Workspaces are intentionally NOT sync tables: path/fingerprint are
 * local-machine concerns, so they stay out of cross-agent replication.
 */

export type Workspace = {
  id: number
  uuid: string | null
  origin: string | null
  path: string
  name: string
  fingerprint: string
  scope: string
  markers: string | null
  visits: number
  first_seen: string
  last_seen: string
  deleted: number
}

/** Marker file/subdir -> stack label. Detected cheaply via existence checks. */
const STACK_MARKERS: Array<[string, string]> = [
  ["package.json", "node"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
  ["go.mod", "go"],
  ["Cargo.toml", "rust"],
  ["pom.xml", "java"],
  ["build.gradle", "java"],
  ["*.sln", "dotnet"],
  ["Dockerfile", "docker"],
  [".github/workflows", "ci"],
  ["Makefile", "make"],
  ["CMakeLists.txt", "cmake"],
]

function globMarker(dir: string, pat: string): boolean {
  if (!pat.includes("*")) return existsSync(join(dir, pat))
  try {
    return readdirSync(dir).some((f) => f.endsWith(pat.slice(1)))
  } catch {
    return false
  }
}

/** Detect stack markers present in a directory (single level, cheap). */
export function detectMarkers(directory: string): string[] {
  const found: string[] = []
  for (const [pat, label] of STACK_MARKERS) {
    if (globMarker(directory, pat)) found.push(label)
  }
  return found
}

/** Stable fingerprint (12-hex) from a sorted marker set. */
export function fingerprintOf(directory: string, markers?: string[]): string {
  const m = (markers ?? detectMarkers(directory)).slice().sort()
  return createHash("sha1").update(m.join("|")).digest("hex").slice(0, 12)
}

export function scopeFor(directory: string, fingerprint?: string): string {
  const fp = fingerprint ?? fingerprintOf(directory)
  return `ws:${basename(directory)}:${fp}`
}

/** Upsert a workspace visit (visits++, last_seen refresh). */
export function touchWorkspace(directory: string): Workspace {
  const db = getDb()
  const markers = detectMarkers(directory)
  const fingerprint = fingerprintOf(directory, markers)
  const scope = scopeFor(directory, fingerprint)
  const ts = now()
  const existing = db
    .query("SELECT * FROM workspaces WHERE path = ? AND deleted = 0")
    .get(directory) as Workspace | null
  if (existing) {
    db.query(
      "UPDATE workspaces SET markers = ?, fingerprint = ?, scope = ?, visits = visits + 1, last_seen = ?, updated_at = ? WHERE id = ?"
    ).run(JSON.stringify(markers), fingerprint, scope, ts, ts, existing.id)
    return { ...existing, markers: JSON.stringify(markers), fingerprint, scope, visits: existing.visits + 1, last_seen: ts }
  }
  const st = stamp()
  db.query(
    "INSERT INTO workspaces (uuid, origin, path, name, fingerprint, scope, markers, visits, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)"
  ).run(st.uuid, st.origin, directory, basename(directory), fingerprint, scope, JSON.stringify(markers), ts, ts)
  return db.query("SELECT * FROM workspaces WHERE path = ?").get(directory) as Workspace
}

/** Current workspace row for a directory (touch + return). */
export function currentWorkspace(directory: string): Workspace {
  return touchWorkspace(directory)
}

export function workspaceList(opts?: { limit?: number }): Workspace[] {
  return getDb()
    .query("SELECT * FROM workspaces WHERE deleted = 0 ORDER BY last_seen DESC LIMIT ?")
    .all(opts?.limit ?? 20) as Workspace[]
}

/** Normalize a directory path for de-duplication & display: unify separators + trailing slash + case key. */
export function normalizePath(p: string): string {
  if (!p) return ""
  let s = p.replace(/[\\/]+/g, "\\").replace(/\\+$/, "")
  // Windows drive "C:" with no slash is invalid; normalize "C:" -> "C:\\"
  if (/^[a-zA-Z]:$/.test(s)) s += "\\"
  const lower = s.toLowerCase()
  return process.platform === "win32" ? lower : s
}

/** Canonical display form: separators unified + trailing slash trimmed, case preserved. */
export function canonicalizePath(p: string): string {
  if (!p) return ""
  let s = p.replace(/[\\/]+/g, "\\").replace(/\\+$/, "")
  if (/^[a-zA-Z]:$/.test(s)) s += "\\"
  return s
}

/**
 * Merge duplicate workspace rows that refer to the same directory
 * (e.g. same path recorded with different separators / trailing slash / case).
 * The keeper keeps the max visits and most recent last_seen; the rest are
 * soft-deleted. Idempotent and safe to run on every load.
 */
export function mergeDuplicateWorkspaces(): { merged: number; total: number } {
  const db = getDb()
  const rows = db
    .query("SELECT * FROM workspaces WHERE deleted = 0 ORDER BY visits DESC, last_seen DESC")
    .all() as Workspace[]
  const byKey = new Map<string, Workspace>()
  let merged = 0
  for (const w of rows) {
    const key = normalizePath(w.path)
    if (!key) continue
    const keeper = byKey.get(key)
    if (!keeper) {
      byKey.set(key, w)
      // adopt the canonical path spelling so the surviving row is clean,
      // but only if that exact string is not held by another row (path is UNIQUE)
      const canon = canonicalizePath(w.path)
      if (canon !== w.path) {
        const taken = db.query("SELECT id FROM workspaces WHERE path = ? AND id != ?").get(canon, w.id)
        if (!taken) db.query("UPDATE workspaces SET path = ? WHERE id = ?").run(canon, w.id)
      }
      continue
    }
    // duplicate → fold visits + last_seen into the keeper, soft-delete this row
    db.query(
      "UPDATE workspaces SET visits = ?, last_seen = ?, updated_at = ? WHERE id = ?"
    ).run(keeper.visits + w.visits, w.last_seen > keeper.last_seen ? w.last_seen : keeper.last_seen, now(), keeper.id)
    db.query("UPDATE workspaces SET deleted = 1, updated_at = ? WHERE id = ?").run(now(), w.id)
    merged++
  }
  return { merged, total: rows.length }
}

export function workspaceStatus(directory?: string): {
  workspaces: Workspace[]
  current?: Workspace
  scoped_memories: number
} {
  const db = getDb()
  const workspaces = workspaceList()
  let current: Workspace | undefined
  if (directory) {
    current = touchWorkspace(directory)
  }
  const scoped = db
    .query("SELECT COUNT(*) AS n FROM memories WHERE archived = 0 AND scope IS NOT NULL AND scope LIKE 'ws:%'")
    .get() as { n: number }
  return { workspaces, current, scoped_memories: scoped.n }
}

/** Scope bias: memory whose scope matches the current workspace fingerprint ranks higher. */
export function scopeBoost(wsScope: string, m: Pick<Memory, "scope">): number {
  if (!wsScope) return 0
  if (m.scope === wsScope) return 2
  if (m.scope && m.scope.startsWith("ws:") && m.scope.split(":").slice(2).join(":") === wsScope.split(":").slice(2).join(":")) return 1
  return 0
}

export function workspaceConfig() {
  return { scopeBoostWeight: Number(getConfig("workspace_scope_boost", "2")) || 2 }
}
