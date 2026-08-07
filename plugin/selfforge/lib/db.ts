/// <reference path="./bun-sqlite.d.ts" />
import { Database } from "bun:sqlite"
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
  content TEXT NOT NULL,
  source TEXT DEFAULT 'manual',
  project TEXT,
  strength INTEGER DEFAULT 0,
  tier TEXT DEFAULT 'warm',
  created_at TEXT,
  updated_at TEXT,
  last_reinforced_at TEXT,
  archived INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_profile (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT UNIQUE,
  content TEXT NOT NULL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  description TEXT,
  content TEXT,
  status TEXT DEFAULT 'active',
  usage_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  optimized_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule TEXT NOT NULL,
  project TEXT,
  domain TEXT DEFAULT 'unknown',
  explicit_scope TEXT DEFAULT 'local',
  count INTEGER DEFAULT 0,
  total_count INTEGER DEFAULT 0,
  written_to TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal TEXT NOT NULL,
  north_star TEXT,
  completion_criteria TEXT,
  status TEXT DEFAULT 'active',
  level INTEGER DEFAULT 0,
  iteration INTEGER DEFAULT 0,
  max_iterations INTEGER DEFAULT 10,
  project TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER,
  cp TEXT,
  status TEXT,
  notes TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS evolution (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id INTEGER,
  strategy TEXT,
  candidate TEXT,
  rationale TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT,
  applied_at TEXT
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT,
  payload TEXT,
  project TEXT,
  created_at TEXT
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
  return db
}

export function getDb(): Database {
  return db || initDb()
}

export function now(): string {
  return new Date().toISOString()
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
    getDb()
      .query(
        "INSERT INTO observations (type, payload, project, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(type, JSON.stringify(payload ?? {}), project ?? null, now())
  } catch {}
}

export function closeDb() {
  try {
    db?.close()
  } catch {}
}

