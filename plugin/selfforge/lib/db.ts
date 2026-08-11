/// <reference path="./bun-sqlite.d.ts" />
import { randomUUID } from "crypto"
import { mkdirSync } from "fs"
import { homedir } from "os"
import { join } from "path"

type Stmt = {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number }
}

/** Cross-runtime DB interface: desktop (Node) and CLI (Bun) both expose .query(). */
export interface Database {
  exec(sql: string): void
  query(sql: string): Stmt
  close(): void
}

function createNodeDatabase(path: string): Database {
  // @ts-ignore - node:sqlite is runtime-specific (desktop Electron bundles Node 22+)
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (p: string) => {
      exec(sql: string): void
      prepare(sql: string): {
        get(...a: unknown[]): unknown
        all(...a: unknown[]): unknown[]
        run(...a: unknown[]): { changes: number; lastInsertRowid: number | bigint }
      }
      close(): void
    }
  }
  const raw = new DatabaseSync(path)
  return {
    exec: (sql: string) => raw.exec(sql),
    query: (sql: string) => raw.prepare(sql),
    close: () => raw.close(),
  }
}

function createBunDatabase(path: string): Database {
  // @ts-ignore - bun:sqlite is runtime-specific (CLI runs under Bun)
  const { Database: B } = require("bun:sqlite") as {
    Database: new (p: string, opts?: { create?: boolean }) => {
      exec(sql: string): void
      query(sql: string): Stmt
      close(): void
    }
  }
  return new B(path, { create: true })
}

function openDb(path: string): Database {
  // @ts-ignore - Bun is a global in the Bun runtime only
  if (typeof Bun !== "undefined") {
    try {
      return createBunDatabase(path)
    } catch {}
  }
  return createNodeDatabase(path)
}

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

-- session_messages_fts created in initDb (FTS5 where available, plain fallback otherwise)

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
  eta REAL DEFAULT 0.5,
  trials_attempted INTEGER DEFAULT 0,
  trials_passed INTEGER DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE,
  origin TEXT,
  kind TEXT NOT NULL,
  tool TEXT,
  context TEXT,
  err_code TEXT,
  created_at TEXT,
  deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_signals_scope ON signals (tool, context, created_at);

CREATE TABLE IF NOT EXISTS repairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE,
  origin TEXT,
  kind TEXT NOT NULL,
  trigger TEXT NOT NULL,
  scope TEXT,
  draft TEXT NOT NULL,
  evidence TEXT,
  failure_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft',
  created_at TEXT,
  updated_at TEXT,
  deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_repairs_scope ON repairs (scope, status, created_at);

CREATE TABLE IF NOT EXISTS pattern_signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE,
  origin TEXT,
  sig TEXT,
  sig_hash TEXT,
  sig_label TEXT,
  tool TEXT,
  err_code TEXT,
  context TEXT,
  episode_key TEXT,
  created_at TEXT,
  deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_patterns_hash ON pattern_signatures (sig_hash, created_at);

CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE,
  origin TEXT,
  path TEXT UNIQUE,
  name TEXT,
  fingerprint TEXT,
  scope TEXT,
  markers TEXT,
  visits INTEGER DEFAULT 1,
  first_seen TEXT,
  last_seen TEXT,
  updated_at TEXT,
  deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_workspaces_scope ON workspaces (scope, last_seen);

CREATE TABLE IF NOT EXISTS session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE,
  summary TEXT,
  fact_count INTEGER DEFAULT 0,
  covered_until_turn INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS recall_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL,
  memory_id INTEGER NOT NULL,
  hits INTEGER DEFAULT 0,
  positives INTEGER DEFAULT 0,
  negatives INTEGER DEFAULT 0,
  updated_at TEXT,
  deleted INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recall_evidence_word_mem ON recall_evidence (word, memory_id);
`

export function initDb(): Database {
  if (db) return db
  mkdirSync(EVOLVE_HOME, { recursive: true })
  mkdirSync(SKILLS_DIR, { recursive: true })
  mkdirSync(ARCHIVE_DIR, { recursive: true })
  mkdirSync(REVIEWS_DIR, { recursive: true })
  db = openDb(DB_PATH)
  // Multi-process safe: the dashboard daemon and the plugin may open the same
  // DB concurrently. WAL allows a reader to proceed while background housekeeping
  // (decay/merge/maintain/vacuum) writes; busy_timeout prevents SQLITE_BUSY drops.
  try {
    db.exec("PRAGMA journal_mode = WAL")
  } catch {}
  try {
    db.exec("PRAGMA busy_timeout = 10000")
  } catch {}
  db.exec(SCHEMA)
  // FTS5 is bundled with Bun but not with Node's node:sqlite; degrade gracefully.
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(content)")
  } catch {
    try {
      db.exec("CREATE TABLE IF NOT EXISTS session_messages_fts (rowid INTEGER PRIMARY KEY, content TEXT)")
    } catch {}
  }
  migrate(db)
  return db
}

/**
 * Sync-able tables carry row-level identity for cross-agent / cross-platform
 * replication (Phase 0): uuid, origin (node id) and a deleted tombstone.
 */
const SYNC_TABLES = ["memories", "skills", "rules", "goals", "checkpoints", "evolution", "observations", "user_profile", "signals", "repairs", "pattern_signatures"] as const

/** Backfill sync columns on tables created before v1.5 (additive, idempotent). */
function migrateSyncColumns(d: Database) {
  const tableCols = (table: string): Set<string> => {
    const rows = d.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return new Set(rows.map((r) => r.name))
  }
  for (const t of SYNC_TABLES) {
    const cols = tableCols(t)
    const adds: Array<[string, string]> = []
    if (!cols.has("uuid")) adds.push(["uuid", "TEXT"])
    if (!cols.has("origin")) adds.push(["origin", "TEXT"])
    if (!cols.has("deleted")) adds.push(["deleted", "INTEGER DEFAULT 0"])
    if (!cols.has("updated_at")) adds.push(["updated_at", "TEXT"])
    // NOTE: ALTER cannot add a UNIQUE column; add plain TEXT then index after backfill
    for (const [name, decl] of adds) d.exec(`ALTER TABLE ${t} ADD COLUMN ${name} ${decl}`)
    // Backfill missing uuids for rows written before the column existed.
    const missing = d.query(`SELECT id FROM ${t} WHERE uuid IS NULL`).all() as Array<{ id: number }>
    for (const row of missing) {
      d.exec(`UPDATE ${t} SET uuid = '${newUuid()}' WHERE id = ${row.id}`)
    }
    d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${t}_uuid ON ${t}(uuid)`)
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
  // v1.5 skill trial lifecycle: Beta(1,1) eta + trial counters.
  const skillCols = tableCols("skills")
  const skillAdds: Array<[string, string]> = [
    ["eta", "REAL DEFAULT 0.5"],
    ["trials_attempted", "INTEGER DEFAULT 0"],
    ["trials_passed", "INTEGER DEFAULT 0"],
  ]
  for (const [name, decl] of skillAdds) {
    if (!skillCols.has(name)) d.exec(`ALTER TABLE skills ADD COLUMN ${name} ${decl}`)
  }
  // v1.8 recall feedback loop: per-word positive/negative evidence.
  const evCols = tableCols("recall_evidence")
  if (!evCols.has("negatives")) d.exec("ALTER TABLE recall_evidence ADD COLUMN negatives INTEGER DEFAULT 0")
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

/** Jump the clock to at least `target` (used after importing a peer snapshot). */
export function advanceClockTo(target: number): number {
  if (target <= clock()) return clock()
  _clock = target
  _clockLoaded = true
  setConfig("lamport_clock", String(target))
  return _clock
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

