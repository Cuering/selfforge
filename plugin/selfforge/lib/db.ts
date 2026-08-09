/// <reference path="./bun-sqlite.d.ts" />
import { Database } from "bun:sqlite"
import { randomUUID } from "crypto"
import { mkdirSync } from "fs"
import { homedir } from "os"
import { join } from "path"

export const EVOLVE_HOME = process.env.EVOLVE_HOME || join(homedir(), ".evolve")
export const DB_PATH = join(EVOLVE_HOME, "unified.db")
export const SKILLS_DIR = join(EVOLVE_HOME, "skills")
export const REVIEWS_DIR = join(EVOLVE_HOME, "reviews")
export const ARCHIVE_DIR = join(SKILLS_DIR, ".archive")

let db: Database | null = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE,
  origin TEXT,
  content TEXT NOT NULL,
  source TEXT DEFAULT 'manual',
  project TEXT,
  strength INTEGER DEFAULT 0,
  tier TEXT DEFAULT 'warm',
  created_at TEXT,
  updated_at TEXT,
  last_reinforced_at TEXT,
  last_accessed_at TEXT,
  access_count INTEGER DEFAULT 0,
  importance INTEGER DEFAULT 5,
  lifecycle TEXT DEFAULT 'temporary',
  type TEXT DEFAULT 'fact',
  archived INTEGER DEFAULT 0,
  scope TEXT,
  status TEXT DEFAULT 'confirmed',
  confidence INTEGER DEFAULT 8,
  expires_at TEXT,
  deleted INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project TEXT,
  turn_count INTEGER DEFAULT 0,
  last_review_turn INTEGER DEFAULT 0,
  last_idle_review INTEGER DEFAULT 0,
  buffer TEXT DEFAULT '[]',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT,
  content TEXT NOT NULL,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages (session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(content);

CREATE TABLE IF NOT EXISTS user_profile (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE,
  origin TEXT,
  keyword TEXT UNIQUE,
  content TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT,
  deleted INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE,
  origin TEXT,
  name TEXT UNIQUE,
  description TEXT,
  content TEXT,
  status TEXT DEFAULT 'active',
  usage_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  optimized_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  last_used_at TEXT,
  deleted INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE,
  origin TEXT,
  rule TEXT NOT NULL,
  project TEXT,
  domain TEXT DEFAULT 'unknown',
  explicit_scope TEXT DEFAULT 'local',
  count INTEGER DEFAULT 0,
  total_count INTEGER DEFAULT 0,
  written_to TEXT,
  created_at TEXT,
  updated_at TEXT,
  deleted INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE,
  origin TEXT,
  goal TEXT NOT NULL,
  north_star TEXT,
  completion_criteria TEXT,
  status TEXT DEFAULT 'active',
  level INTEGER DEFAULT 0,
  iteration INTEGER DEFAULT 0,
  max_iterations INTEGER DEFAULT 10,
  project TEXT,
  created_at TEXT,
  updated_at TEXT,
  deleted INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE,
  origin TEXT,
  goal_id INTEGER,
  cp TEXT,
  status TEXT,
  notes TEXT,
  created_at TEXT,
  deleted INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS evolution (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE,
  origin TEXT,
  skill_id INTEGER,
  strategy TEXT,
  candidate TEXT,
  rationale TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT,
  applied_at TEXT,
  deleted INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE,
  origin TEXT,
  type TEXT,
  payload TEXT,
  project TEXT,
  created_at TEXT,
  deleted INTEGER DEFAULT 0
);
`

export function initDb(): Database {
  if (db) return db
  mkdirSync(EVOLVE_HOME, { recursive: true })
  mkdirSync(SKILLS_DIR, { recursive: true })
  mkdirSync(ARCHIVE_DIR, { recursive: true })
  mkdirSync(REVIEWS_DIR, { recursive: true })
  db = new Database(DB_PATH, { create: true })
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/**
 * Sync-able tables carry row-level identity for cross-agent / cross-platform
 * replication (Phase 0): uuid, origin (node id) and a deleted tombstone.
 */
const SYNC_TABLES = ["memories", "skills", "rules", "goals", "checkpoints", "evolution", "observations", "user_profile"] as const

/** Backfill sync columns on tables created before v1.5 (additive, idempotent). */
function migrateSyncColumns(d: Database) {
  const tableCols = (table: string): Set<string> => {
    const rows = d.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return new Set(rows.map((r) => r.name))
  }
  for (const t of SYNC_TABLES) {
    const cols = tableCols(t)
    const adds: Array<[string, string]> = []
    if (!cols.has("uuid")) adds.push(["uuid", "TEXT UNIQUE"])
    if (!cols.has("origin")) adds.push(["origin", "TEXT"])
    if (!cols.has("deleted")) adds.push(["deleted", "INTEGER DEFAULT 0"])
    if (!cols.has("updated_at")) adds.push(["updated_at", "TEXT"])
    for (const [name, decl] of adds) d.exec(`ALTER TABLE ${t} ADD COLUMN ${name} ${decl}`)
    // Backfill missing uuids for rows written before the column existed.
    const missing = d.query(`SELECT id FROM ${t} WHERE uuid IS NULL`).all() as Array<{ id: number }>
    for (const row of missing) {
      d.exec(`UPDATE ${t} SET uuid = '${newUuid()}' WHERE id = ${row.id}`)
    }
  }
}

/** Lightweight additive migration for DBs created before v1.1. */
function migrate(d: Database) {
  const tableCols = (table: string): Set<string> => {
    const rows = d.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return new Set(rows.map((r) => r.name))
  }
  const cols = tableCols("memories")
  const adds: Array<[string, string]> = [
    ["last_accessed_at", "TEXT"],
    ["access_count", "INTEGER DEFAULT 0"],
    ["importance", "INTEGER DEFAULT 5"],
    ["lifecycle", "TEXT DEFAULT 'temporary'"],
    ["type", "TEXT DEFAULT 'fact'"],
    ["scope", "TEXT"],
    ["status", "TEXT DEFAULT 'confirmed'"],
    ["confidence", "INTEGER DEFAULT 8"],
    ["expires_at", "TEXT"],
  ]
  for (const [name, decl] of adds) {
    if (!cols.has(name)) d.exec(`ALTER TABLE memories ADD COLUMN ${name} ${decl}`)
  }
  migrateSyncColumns(d)
}

export function getDb(): Database {
  return db || initDb()
}

export function now(): string {
  return new Date().toISOString()
}

/**
 * --- Phase 0 sync primitives ---
 * Row-level identity + a Lamport clock so cross-agent / cross-platform
 * replicas can merge without collision. nodeId persists in config.
 */

/** Stable per-install node identity (persisted in config table). */
export function nodeId(): string {
  const existing = getConfig("node_id")
  if (existing) return existing
  const id = `node-${randomUUID().slice(0, 8)}`
  setConfig("node_id", id)
  return id
}

export function newUuid(): string {
  return randomUUID()
}

let _clock = 0
let _clockLoaded = false

/** Current Lamport clock value (monotonic per store). */
export function clock(): number {
  if (!_clockLoaded) {
    _clock = Number(getConfig("lamport_clock", "0")) || 0
    _clockLoaded = true
  }
  return _clock
}

/** Increment and persist the Lamport clock. Returns the new value. */
export function tickClock(): number {
  const next = clock() + 1
  _clock = next
  _clockLoaded = true
  setConfig("lamport_clock", String(next))
  return next
}

export type Stamp = {
  uuid: string
  origin: string
  created_at: string
  updated_at: string
  deleted: number
  clock: number
}

/** Stamp a new sync-able row: fresh uuid, this node's origin, current clock. */
export function stamp(): Stamp {
  const ts = now()
  return { uuid: newUuid(), origin: nodeId(), created_at: ts, updated_at: ts, deleted: 0, clock: tickClock() }
}

export function getConfig(key: string, fallback?: string): string | undefined {
  const row = getDb().query("SELECT value FROM config WHERE key = ?").get(key) as
    | { value: string }
    | undefined
  return row?.value ?? fallback
}

export function setConfig(key: string, value: string) {
  getDb()
    .query(
      "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(key, value)
}

export function logObs(type: string, payload: unknown, project?: string) {
  try {
    const st = stamp()
    getDb()
      .query(
        "INSERT INTO observations (uuid, origin, type, payload, project, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(st.uuid, st.origin, type, JSON.stringify(payload ?? {}), project ?? null, now())
  } catch {}
}

export function closeDb() {
  try {
    db?.close()
  } catch {}
}

/** Reclaim deleted space. Run infrequently (VACUUM is O(db)). */
export function vacuumDb(): { reclaimed: boolean } {
  try {
    const before = db?.query("PRAGMA freelist_count").get() as { freelist_count: number } | undefined
    db?.exec("VACUUM")
    return { reclaimed: !!before && before.freelist_count > 0 }
  } catch (err) {
    return { reclaimed: false }
  }
}

