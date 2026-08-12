import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { readFileSync, existsSync, unlinkSync } from "node:fs"
import { spawn } from "node:child_process"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { getDb, nodeId, clock, advanceClockTo, logObs, now, EVOLVE_HOME } from "./db"
import { exportSnapshot, importSnapshot, transferStatus, SNAPSHOT_FORMAT } from "./transfer"
import { memoryList, memoryUpdateById, memoryArchiveById, memoryAdd } from "./memory"
import { dailySummaries } from "./summary"
import { skillCreate, skillList, skillStatus, skillArchive, skillPatch, skillInfo, skillEnable, skillDisable, skillUninstall, skillInstallFromDir, adoptOpencodeSkills, skillFeedback } from "./skills"
import { curatorRun } from "./review"
import { workspaceList, mergeDuplicateWorkspaces } from "./workspace"
import { goalStatus, goalStart, maintainCheckpoints } from "./goals"
import { ruleObserve, ruleStatus } from "./rules"
import { evolutionPropose, evolutionList } from "./evolution"
import { patternCandidates, recordPattern } from "./patterns"
import { runRepair, recordSignal } from "./repair"
// getSession, sessionSearch removed
import { DASHBOARD_HTML } from "./dashboard-html"
import { dashLog, dashLogList, dashLogClear, dashLogCount } from "./dashboard-log"
/**
 * Phase 3 — local JSON-RPC endpoint (HTTP/1.1, zero dependencies).
 *
 * A tiny RPC surface over the same store used by the plugin, so other
 * agents/platforms on the same machine can query or sync memory without
 * opening the SQLite file directly (which the plugin has open).
 *
 * Methods (JSON-RPC 2.0 over HTTP POST):
 *   status            -> node id, clock, db path
 *   memory.list       -> latest memories
 *   memory.update     -> edit a memory by id (content/scope/importance/confidence/status/lifecycle)
 *   memory.delete     -> archive(删除) a memory by id
 *   memory.daily      -> session summaries aggregated by day
 *   skills.list       -> skills + lifecycle status
 *   workspaces.list   -> known workspaces
 *   goals.list        -> active goals
 *   snapshot.export   -> full portable snapshot
 *   snapshot.import   -> per-uuid LWW merge (takes the snapshot as payload)
 *   ping              -> pong
 */

type RpcRequest = { jsonrpc?: string; id?: string | number; method: string; params?: any }
type RpcResponse = { jsonrpc: string; id: string | number | null; result?: any; error?: { code: number; message: string } }

function rpcError(id: string | number | null, code: number, message: string): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ""
    req.on("data", (c) => {
      data += c
      if (data.length > 64 * 1024 * 1024) {
        reject(new Error("body too large"))
        req.destroy()
      }
    })
    req.on("end", () => resolve(data))
    req.on("error", reject)
  })
}

async function handle(method: string, params: any): Promise<any> {
  switch (method) {
    case "ping":
      return "pong"
    case "status":
      return { ...transferStatus(), format: SNAPSHOT_FORMAT }
    case "memory.list": {
      const limit = Number(params?.limit ?? 20)
      return memoryList({ limit, archived: false }).map((m) => ({
        id: m.uuid,
        content: m.content,
        type: m.type,
        lifecycle: m.lifecycle,
        status: m.status,
        tier: m.tier,
        scope: m.scope,
        created_at: m.created_at,
      }))
    }
    case "memory.update": {
      const mem = findMemoryById(params?.id)
      if (!mem) throw new Error("params.id required (id or uuid)")
      const res = memoryUpdateById(mem.id, {
        content: params?.content,
        scope: params?.scope,
        importance: params?.importance !== undefined ? Number(params.importance) : undefined,
        confidence: params?.confidence !== undefined ? Number(params.confidence) : undefined,
        status: params?.status,
        lifecycle: params?.lifecycle,
      })
      if (!res.ok) throw new Error(res.message)
      return { ok: true, id: mem.uuid }
    }
    case "memory.delete": {
      const mem = findMemoryById(params?.id)
      if (!mem) throw new Error("params.id required (id or uuid)")
      const res = memoryArchiveById(mem.id)
      if (!res.ok) throw new Error(res.message)
      return { ok: true, id: mem.uuid }
    }
    case "memory.daily":
      return dailySummaries({ limit: Number(params?.limit ?? 14) })
    // daily.refine removed
    case "skills.create": {
      if (!params?.name || !params?.description) throw new Error("params.name and params.description required")
      return skillCreate(String(params.name), String(params.description), params.body ? String(params.body) : "")
    }
    case "rules.create": {
      if (!params?.rule) throw new Error("params.rule required")
      return ruleObserve({
        rule: String(params.rule),
        domain: params.domain ? String(params.domain) : undefined,
        explicitScope: params.explicitScope === "global" ? "global" : "local",
      })
    }
    case "goals.create": {
      if (!params?.goal) throw new Error("params.goal required")
      return goalStart({
        goal: String(params.goal),
        northStar: params.northStar ? String(params.northStar) : undefined,
        completionCriteria: params.completionCriteria ? String(params.completionCriteria) : undefined,
      })
    }
    case "evolution.create": {
      if (!params?.skill || !params?.strategy || !params?.candidate) throw new Error("params.skill, params.strategy and params.candidate required")
      return evolutionPropose({
        skill: String(params.skill),
        strategy: String(params.strategy),
        candidate: String(params.candidate),
        rationale: params.rationale ? String(params.rationale) : undefined,
      })
    }
    case "repairs.create": {
      if (!params?.tool) throw new Error("params.tool required")
      const tool = String(params.tool)
      const context = params.context ? String(params.context) : "manual"
      const errCode = params.errCode ? String(params.errCode) : "MANUAL"
      for (let i = 0; i < 3; i++) recordSignal("failure", tool, context, errCode)
      return runRepair({ tool, context, errCode, trigger: "manual" })
    }
    case "patterns.record": {
      if (!params?.tool) throw new Error("params.tool required")
      return recordPattern(String(params.tool), params.errCode ? String(params.errCode) : undefined, params.context ? String(params.context) : undefined, params.episodeKey ? String(params.episodeKey) : undefined)
    }
    case "workspace.open": {
      if (!params?.id) throw new Error("params.id required")
      const ws = getDb()
        .query("SELECT * FROM workspaces WHERE id = ? AND deleted = 0")
        .get(resolveRowId("workspaces", params.id)) as { path: string } | undefined
      if (!ws || !ws.path) throw new Error("workspace not found")
      const { existsSync } = require("node:fs")
      if (!existsSync(ws.path)) throw new Error(`path does not exist: ${ws.path}`)
      // Open the folder in the OS file manager (Windows explorer / macOS open / Linux xdg-open).
      const opener = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open"
      const child = spawn(opener, process.platform === "win32" ? [ws.path] : [ws.path], {
        detached: true,
        stdio: "ignore",
      })
      child.unref()
      return { ok: true, path: ws.path }
    }
    case "workspace.merge": {
      return mergeDuplicateWorkspaces()
    }
    case "checkpoints.maintain": {
      return maintainCheckpoints()
    }
    case "diagnostics.list":
      return { entries: dashLogList(Number(params?.limit ?? 50)), ...dashLogCount() }
    case "diagnostics.clear":
      return dashLogClear()
    case "diagnostics.report": {
      const level = params?.level === "warn" || params?.level === "info" ? params.level : "error"
      const entry = dashLog(level, String(params?.source || "client"), String(params?.message || "unknown"), {
        stack: params?.stack ? String(params.stack) : undefined,
        meta: params?.meta && typeof params.meta === "object" ? params.meta : undefined,
      })
      return { ok: true, id: entry.id }
    }
    case "data.update": {
      const updated = updateRow(params?.kind, params?.id, params)
      return { ok: updated.ok, message: updated.message }
    }
    case "data.delete": {
      const del = deleteRow(params?.kind, params?.id)
      return { ok: del.ok, message: del.message }
    }
    // session.distill removed
    case "dashboard.restart":
      return restartDashboard(Number(params?.port ?? 9210))
    case "dashboard.seed": {
      const d = apiDashboard()
      const created: Record<string, unknown> = {}
      if (d.counts.skills === 0) {
        skillCreate("bash-tools", "Shell, PowerShell and CLI automation patterns")
        created.skills = "bash-tools"
      }
      if (d.counts.rules === 0) {
        ruleObserve({ rule: "提交前先运行测试并检查 lint", domain: "workflow", explicitScope: "local" })
        created.rules = "workflow"
      }
      if (d.counts.goals === 0) {
        goalStart({ goal: "优化 selfforge dashboard 体验", northStar: "数据一目了然", completionCriteria: "所有栏目可看可操作" })
        created.goals = "active"
      }
      if (d.counts.evolution === 0) {
        evolutionPropose({ skill: "bash-tools", strategy: "harden", candidate: "记 dashboard 生成/蒸馏按钮的用法", rationale: "seed" })
        created.evolution = "pending"
      }
      if (d.counts.repairs === 0) {
        recordSignal("failure", "shell", "seed", "SEED_1")
        recordSignal("failure", "shell", "seed", "SEED_1")
        recordSignal("failure", "shell", "seed", "SEED_1")
        runRepair({ tool: "shell", context: "seed", errCode: "SEED_1", trigger: "manual" })
        created.repairs = "draft"
      }
      return { created, counts: apiDashboard().counts }
    }
    case "skills.list": {
      const list = skillList({ includeDeleted: false }).map((s) => ({
        id: s.uuid,
        name: s.name,
        description: s.description,
        status: s.status,
        eta: s.eta,
        trials: s.trials_attempted ?? 0,
        passed: s.trials_passed ?? 0,
        usage: s.usage_count ?? 0,
        last_used_at: s.last_used_at,
      }))
      return { skills: list, status: skillStatus() }
    }
    case "skills.enable":
      return skillEnable(String(params?.name))
    case "skills.disable":
      return skillDisable(String(params?.name))
    case "skills.uninstall":
      return skillUninstall(String(params?.name))
    case "skills.info":
      return skillInfo(String(params?.name))
    case "skills.feedback": {
      if (!params?.name) throw new Error("params.name required")
      const positive = params.positive !== false && params.positive !== "false" && params.positive !== 0
      return skillFeedback(String(params.name), Boolean(positive))
    }
    case "skills.curator":
      return curatorRun()
    case "skills.install": {
      if (!params?.dir) throw new Error("params.dir required")
      return skillInstallFromDir(String(params.dir))
    }
    case "skills.adopt": {
      return adoptOpencodeSkills([join(homedir(), ".config", "opencode", "skills"), join(homedir(), ".agents", "skills")])
    }
    case "workspaces.list":
      return workspaceList({ limit: Number(params?.limit ?? 20) }).map((w) => ({
        name: w.name,
        path: w.path,
        scope: w.scope,
        markers: w.markers ? JSON.parse(w.markers) : [],
        visits: w.visits,
        last_seen: w.last_seen,
      }))
    case "goals.list":
      return goalStatus().map((g) => ({ id: g.uuid, goal: g.goal, status: g.status }))
    case "snapshot.export": {
      const snap = exportSnapshot()
      return snap
    }
    case "snapshot.import": {
      const snap = params?.snapshot
      if (!snap || typeof snap !== "object" || snap.format !== SNAPSHOT_FORMAT) {
        throw new Error("params.snapshot must be a valid selfforge snapshot")
      }
      const res = importSnapshot(snap)
      // advance local clock so future writes stay ordered after the peer
      advanceClockTo(Number(snap.clock ?? 0) + 1)
      return { merged: res }
    }
    default:
      throw new Error(`unknown method: ${method}`)
  }
}

/** Resolve a memory by numeric id or uuid (from the full active list). */
function findMemoryById(ref: unknown) {
  const all = memoryList({ limit: 100000, archived: false })
  if (typeof ref === "number" || (typeof ref === "string" && /^\d+$/.test(ref))) {
    const n = Number(ref)
    return all.find((m) => m.id === n)
  }
  return all.find((m) => m.uuid === ref)
}

/** JSON API used by the single-page dashboard (Phase 5). */
function apiStatus() {
  return { ...transferStatus(), format: SNAPSHOT_FORMAT }
}

/** Single active dashboard/RPC server (spawned by the plugin or CLI, never duplicated). */
let activeServer: import("node:http").Server | null = null

export function closeServer(): void {
  if (activeServer) {
    try {
      activeServer.close()
    } catch {}
    activeServer = null
  }
}

/**
 * Stable dashboard supervision. The dashboard is served by a *detached daemon
 * process* that survives opencode restarts (the plugin used to serve in-process,
 * so the port died on exit and drifted upward on EADDRINUSE). The supervisor:
 *  1. probes the desired port with GET /api/ping
 *  2. if nothing answers, spawns a detached child running serve-daemon.js
 *  3. waits for it to come up, then returns the bound port
 *  4. falls back to an in-process server only if the daemon cannot be spawned
 */
const DAEMON_STATE_FILE = join(EVOLVE_HOME, "dashboard.json")

function readDaemonState(): { port?: number; pid?: number; started_at?: string } | null {
  try {
    return JSON.parse(readFileSync(DAEMON_STATE_FILE, "utf8")) as { port?: number; pid?: number; started_at?: string }
  } catch {
    return null
  }
}

async function pingPort(port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const { get } = require("node:http")
      const r = get(
        { host: "127.0.0.1", port, path: "/api/ping", timeout: timeoutMs },
        (res: import("node:http").IncomingMessage) => {
          res.resume()
          resolve(res.statusCode === 200)
        }
      )
      r.on("error", () => resolve(false))
      r.on("timeout", () => {
        r.destroy()
        resolve(false)
      })
    } catch {
      resolve(false)
    }
  })
}

function daemonEntryCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  return [
    // deployed (compiled bundle): compiled/serve-daemon.js sits next to the plugin
    join(here, "serve-daemon.js"),
    join(here, "..", "serve-daemon.js"),
    // source layouts: lib/rpc.ts -> selfforge/serve-daemon.ts (repo & installed plugins/)
    join(here, "..", "serve-daemon.ts"),
    join(here, "..", "..", "serve-daemon.ts"),
  ]
}

function resolveDaemonEntry(): string | null {
  for (const c of daemonEntryCandidates()) {
    try {
      if (existsSync(c)) return c
    } catch {}
  }
  return null
}

/** Spawn the detached daemon. Returns the child or null if it cannot start. */
function spawnDaemon(port: number): ReturnType<typeof spawn> | null {
  const entry = resolveDaemonEntry()
  if (!entry) return null
  // Use the same runtime that is hosting the plugin (Node on desktop, Bun on CLI).
  const env: Record<string, string> = { ...process.env, SELFFORGE_PORT: String(port), EVOLVE_HOME }
  // ELECTRON_RUN_AS_NODE makes an Electron binary (opencode desktop) run the
  // script as plain Node; plain node/bun ignore the variable, so it is safe to
  // always set.
  env.ELECTRON_RUN_AS_NODE = "1"
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    env,
  })
  child.unref()
  return child
}

export async function ensureDashboard(port = 9210): Promise<{ port: number; daemon: boolean }> {
  // Already running in-process (CLI `selfforge serve` or previous fallback).
  if (activeServer) return { port: activeServerPort() || port, daemon: false }
  // Reuse a live daemon: try the requested port, then the recorded daemon port.
  if (await pingPort(port)) return { port, daemon: true }
  const state = readDaemonState()
  if (state?.port && state.port !== port && (await pingPort(state.port))) return { port: state.port, daemon: true }
  // Spawn a detached daemon.
  const child = spawnDaemon(port)
  if (child) {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150))
      if (await pingPort(port)) return { port, daemon: true }
      const st = readDaemonState()
      if (st?.port && (await pingPort(st.port))) return { port: st.port, daemon: true }
    }
  }
  // Fallback: serve in-process (daemon could not be spawned / started).
  const actual = await serve(port)
  return { port: actual, daemon: false }
}

/** Stop the dashboard: kills the detached daemon (and any in-process server). */
export async function stopDashboard(): Promise<{ ok: boolean }> {
  const state = readDaemonState()
  if (state?.pid && state.pid !== process.pid) {
    try {
      process.kill(state.pid)
    } catch {}
  }
  closeServer()
  try {
    unlinkSync(DAEMON_STATE_FILE)
  } catch {}
  return { ok: true }
}

/**
 * Hot restart: spawn a replacement daemon, then schedule this process to exit
 * after the RPC response has been flushed. The new daemon retries the target
 * port for several seconds so it wins the same port once the old one exits.
 */
export async function restartDashboard(port = 9210): Promise<{ ok: boolean; pid: number | null }> {
  const child = spawnDaemon(port)
  if (!child) return { ok: false, pid: null }
  // Give the child time to start and the response to flush, then exit.
  setTimeout(() => {
    try {
      process.exit(0)
    } catch {}
  }, 800)
  return { ok: true, pid: child.pid }
}

/** Plain-text overview of the engine, rendered from the same data as the JSON APIs. */
export function dashboardText(): string {
  const d = apiDashboard()
  const lines: string[] = []
  lines.push("# selfforge")
  lines.push(
    `node ${d.status.node_id}   clock ${d.status.clock}   ${d.status.home || d.status.db_path}`
  )
  lines.push("")
  const counts = Object.entries(d.counts)
  if (counts.length) {
    lines.push("## counts")
    for (const [k, v] of counts) lines.push(`- ${k}: ${v}`)
    lines.push("")
  }
  const memories = apiMemories()
  if (memories.length) {
    lines.push("## memories")
    for (const m of memories.slice(0, 25)) {
      const meta = [m.tier, m.lifecycle, m.scope || ""].filter(Boolean).join("/")
      lines.push(`- [${meta}] (${String(m.strength ?? "")}) ${m.content.slice(0, 120)}`)
    }
    lines.push("")
  }
  const skills = apiSkills()
  if (skills.length) {
    lines.push("## skills")
    for (const s of skills.slice(0, 25)) lines.push(`- ${s.name} (${s.status}, trials ${s.passed}/${s.trials})`)
    lines.push("")
  }
  const goals = apiGoals()
  if (goals.length) {
    lines.push("## goals")
    for (const g of goals.slice(0, 25)) lines.push(`- [${g.status}] ${g.goal}${g.project ? `  (${g.project})` : ""}`)
    lines.push("")
  }
  const repairs = apiRepairs()
  if (repairs.length) {
    lines.push("## pending repairs")
    for (const r of repairs.slice(0, 15)) lines.push(`- [${r.kind}] ${r.draft.slice(0, 120)}`)
    lines.push("")
  }
  const patterns = apiPatterns()
  if (patterns.length) {
    lines.push("## mature patterns")
    for (const p of patterns.slice(0, 15)) lines.push(`- ${p.sig}${p.tool ? ` (${p.tool})` : ""} x${p.episodes}`)
    lines.push("")
  }
  lines.push("Visual dashboard: `selfforge serve` then open the served URL in a browser.")
  return lines.join("\n")
}

function apiMemories() {
  return memoryList({ limit: 500, archived: false }).map((m) => ({
    id: m.uuid,
    content: m.content,
    type: m.type,
    lifecycle: m.lifecycle,
    status: m.status,
    tier: m.tier,
    strength: m.strength,
    importance: m.importance,
    scope: m.scope,
    created_at: m.created_at,
  }))
}

function apiSkills() {
  return skillList({ includeDeleted: false }).map((s) => ({
    id: s.uuid,
    name: s.name,
    description: s.description,
    status: s.status,
    eta: s.eta,
    trials: s.trials_attempted ?? 0,
    passed: s.trials_passed ?? 0,
    usage: s.usage_count ?? 0,
    last_used_at: s.last_used_at,
  }))
}

function apiRepairs() {
  const rows = getDb()
    .query("SELECT * FROM repairs WHERE deleted = 0 AND status NOT IN ('accepted','rejected') ORDER BY created_at DESC LIMIT 50")
    .all() as Array<{ uuid: string | null; kind: string; trigger: string; scope: string | null; draft: string; status: string; created_at: string }>
  return rows.map((r) => ({ id: r.uuid, kind: r.kind, trigger: r.trigger, scope: r.scope, draft: r.draft, status: r.status, created_at: r.created_at }))
}

function apiPatterns() {
  return patternCandidates().map((c) => ({ id: c.sig_hash, sig: c.sig_label, tool: c.tool, err_code: c.err_code, episodes: c.episodes }))
}

function apiWorkspacesData() {
  return workspaceList({ limit: 50 }).map((w) => ({
    id: w.uuid || w.id,
    name: w.name,
    path: w.path,
    visits: w.visits,
    last_seen: w.last_seen,
  }))
}

function apiDashboard() {
  const db = getDb()
  const count = (t: string) => {
    // tables without an `archived` column (workspaces, signals, repairs) filter by deleted only
    const cols = (db.query(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name)
    const where = cols.includes("archived") ? "deleted = 0 AND archived = 0" : "deleted = 0"
    return (db.query(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`).get() as { n: number }).n
  }
  return {
    status: apiStatus(),
    counts: {
      memories: count("memories"),
      skills: count("skills"),
      rules: count("rules"),
      goals: count("goals"),
      checkpoints: (db.query("SELECT COUNT(DISTINCT goal_id) AS n FROM checkpoints WHERE deleted = 0").get() as { n: number }).n,
      evolution: count("evolution"),
      repairs: (db.query("SELECT COUNT(*) AS n FROM repairs WHERE deleted = 0 AND status NOT IN ('accepted','rejected')").get() as { n: number }).n,
      workspaces: count("workspaces"),
    },
  }
}

function apiGoals() {
  // Dashboard count cards count every non-deleted goal (completed/stopped
  // included), so the list must show the same universe or the panel feels
  // empty while the badge says e.g. "4".
  return getDb()
    .query("SELECT id, uuid, goal, status, project, created_at, updated_at FROM goals WHERE deleted = 0 ORDER BY updated_at DESC LIMIT 100")
    .all()
    .map((g: any) => ({ id: g.uuid, goal: g.goal, status: g.status, project: g.project, updated_at: g.updated_at }))
}

function apiRules() {
  return getDb()
    .query("SELECT id, uuid, rule, domain, explicit_scope, count, created_at FROM rules WHERE deleted = 0 ORDER BY id DESC LIMIT 100")
    .all() as Array<{ id: number; uuid: string; rule: string; domain: string; explicit_scope: string; count: number; created_at: string }>
}

function apiCheckpoints() {
  return getDb()
    .query(
      "SELECT c.id, c.uuid, c.cp, c.status, c.notes, c.created_at, g.goal, g.uuid AS goal_uuid FROM checkpoints c LEFT JOIN goals g ON g.id = c.goal_id WHERE c.deleted = 0 ORDER BY c.id DESC LIMIT 100"
    )
    .all() as Array<{ id: number; uuid: string; cp: string; status: string; notes: string | null; created_at: string; goal: string | null; goal_uuid: string | null }>
}

function apiEvolution() {
  return getDb()
    .query(
      "SELECT e.id, e.uuid, e.strategy, e.status, e.candidate, e.created_at, s.name AS skill_name FROM evolution e JOIN skills s ON s.id = e.skill_id WHERE e.deleted = 0 ORDER BY e.id DESC LIMIT 50"
    )
    .all() as Array<{ id: number; uuid: string; strategy: string; status: string; candidate: string; created_at: string; skill_name: string }>
}

/** Update a row identified by kind + id (uuid or numeric). Returns { ok, message } or throws. */
function updateRow(kind: string | undefined, id: unknown, patch: Record<string, unknown>): { ok: boolean; message?: string } {
  if (!kind || !id) throw new Error("params.kind and params.id required")
  const db = getDb()
  const ref = resolveRowId(kind, id)
  if (!ref) throw new Error(`row #${id} not found in ${kind}`)
  const ts = now()
  switch (kind) {
    case "memories": {
      if (patch.content !== undefined) {
        const res = memoryUpdateById(ref, { content: String(patch.content), scope: patch.scope !== undefined ? String(patch.scope) : undefined })
        if (!res.ok) throw new Error(res.message)
      }
      return { ok: true }
    }
    case "skills": {
      const s = db.query("SELECT * FROM skills WHERE id = ?").get(ref) as { name: string } | undefined
      if (!s) throw new Error("skill not found")
      if (patch.description !== undefined) skillPatch(s.name, "description", String(patch.description))
      if (patch.body !== undefined) skillPatch(s.name, "body", String(patch.body))
      return { ok: true }
    }
    case "rules":
      if (patch.rule !== undefined)
        db.query("UPDATE rules SET rule = ?, updated_at = ? WHERE id = ?").run(String(patch.rule), ts, ref)
      return { ok: true }
    case "goals":
      if (patch.goal !== undefined)
        db.query("UPDATE goals SET goal = ?, updated_at = ? WHERE id = ?").run(String(patch.goal), ts, ref)
      if (patch.northStar !== undefined)
        db.query("UPDATE goals SET north_star = ?, updated_at = ? WHERE id = ?").run(String(patch.northStar), ts, ref)
      if (patch.completionCriteria !== undefined)
        db.query("UPDATE goals SET completion_criteria = ?, updated_at = ? WHERE id = ?").run(String(patch.completionCriteria), ts, ref)
      return { ok: true }
    case "checkpoints": {
      if (patch.notes !== undefined)
        db.query("UPDATE checkpoints SET notes = ? WHERE id = ?").run(String(patch.notes), ref)
      if (patch.status !== undefined)
        db.query("UPDATE checkpoints SET status = ? WHERE id = ?").run(String(patch.status), ref)
      return { ok: true }
    }
    case "evolution": {
      if (patch.candidate !== undefined)
        db.query("UPDATE evolution SET candidate = ?, rationale = COALESCE(rationale, ''), updated_at = ? WHERE id = ?").run(String(patch.candidate), ts, ref)
      return { ok: true }
    }
    case "repairs": {
      if (patch.draft !== undefined)
        db.query("UPDATE repairs SET draft = ?, updated_at = ? WHERE id = ?").run(String(patch.draft), ts, ref)
      return { ok: true }
    }
    case "patterns": {
      if (patch.sig_label !== undefined)
        db.query("UPDATE pattern_signatures SET sig_label = ? WHERE id = ?").run(String(patch.sig_label), ref)
      return { ok: true }
    }
    case "workspaces":
      if (patch.name !== undefined)
        db.query("UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?").run(String(patch.name), ts, ref)
      if (patch.path !== undefined)
        db.query("UPDATE workspaces SET path = ?, updated_at = ? WHERE id = ?").run(String(patch.path), ts, ref)
      return { ok: true }
    default:
      throw new Error(`unknown kind: ${kind}`)
  }
}

/** Soft-delete a row identified by kind + id. */
function deleteRow(kind: string | undefined, id: unknown): { ok: boolean; message?: string } {
  if (!kind || !id) throw new Error("params.kind and params.id required")
  const db = getDb()
  const ref = resolveRowId(kind, id)
  if (!ref) throw new Error(`row #${id} not found in ${kind}`)
  switch (kind) {
    case "memories": {
      const res = memoryArchiveById(ref)
      if (!res.ok) throw new Error(res.message)
      return { ok: true }
    }
    case "skills": {
      const s = db.query("SELECT * FROM skills WHERE id = ?").get(ref) as { name: string } | undefined
      if (!s) throw new Error("skill not found")
      skillArchive(s.name)
      return { ok: true }
    }
    case "goals":
      db.query("UPDATE goals SET deleted = 1, updated_at = ? WHERE id = ?").run(now(), ref)
      return { ok: true }
    default:
      db.query(`UPDATE ${kind} SET deleted = 1 WHERE id = ?`).run(ref)
      return { ok: true }
  }
}

/** Resolve a row id (uuid string or numeric) to the numeric PK for a kind. */
function resolveRowId(kind: string, id: unknown): number {
  const db = getDb()
  if (typeof id === "number" || (typeof id === "string" && /^\d+$/.test(id))) return Number(id)
  const cols = (db.query(`PRAGMA table_info(${kind})`).all() as Array<{ name: string }>).map((c) => c.name)
  if (!cols.includes("deleted")) throw new Error(`table ${kind} has no soft-delete column`)
  const col = kind === "patterns" ? "sig_hash" : "uuid"
  const row = db.query(`SELECT id FROM ${kind} WHERE ${col} = ? AND deleted = 0`).get(String(id)) as { id: number } | undefined
  if (!row) throw new Error(`row ${id} not found`)
  return row.id
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, url: string) {
  const route = url.split("?")[0]
  if (route === "/" || route === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(DASHBOARD_HTML)
    return
  }
  if (route === "/api/status") return json(res, apiStatus())
  if (route === "/api/ping") return json(res, { pong: true, pid: process.pid, port: activeServerPort() })
  if (route === "/api/dashboard") return json(res, apiDashboard())
  if (route === "/api/memories") return json(res, apiMemories())
  if (route === "/api/skills") return json(res, apiSkills())
  if (route === "/api/goals") return json(res, apiGoals())
  if (route === "/api/repairs") return json(res, apiRepairs())
  if (route === "/api/patterns") return json(res, apiPatterns())
  if (route === "/api/workspaces") return json(res, apiWorkspacesData())
  if (route === "/api/rules") return json(res, apiRules())
  if (route === "/api/checkpoints") return json(res, apiCheckpoints())
  if (route === "/api/evolution") return json(res, apiEvolution())
  if (route === "/api/errors") return json(res, { entries: dashLogList(100), ...dashLogCount() })
  res.writeHead(404, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ error: `not found: ${route}` }))
}

function json(res: ServerResponse, data: unknown) {
  res.writeHead(200, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data, null, 2))
}

export async function serve(port = 9210): Promise<number> {
  if (activeServer) return activeServerPort() || port
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }
    const url = (req.url || "/").split("?")[0]
    if (req.method === "GET") {
      if (url === "/api/dashboard") return json(res, apiDashboard())
      await serveStatic(req, res, req.url || "/")
      return
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" })
      res.end(JSON.stringify(rpcError(null, -32000, "POST only")))
      return
    }
    try {
      const raw = await readBody(req)
      const reqObj = JSON.parse(raw) as RpcRequest
      if (!reqObj || reqObj.method === undefined) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify(rpcError(reqObj?.id ?? null, -32600, "invalid request")))
        return
      }
      const id = reqObj.id ?? null
      try {
        const result = await handle(String(reqObj.method), reqObj.params)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }))
      } catch (err) {
        const e = err as Error
        dashLog("error", `rpc:${String(reqObj.method)}`, e.message, { stack: e.stack })
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(rpcError(id, -32000, e.message)))
      }
    } catch (err) {
      const e = err as Error
      dashLog("error", "rpc:parse", e.message, { stack: e.stack })
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify(rpcError(null, -32700, e.message)))
    }
  })
  activeServer = server
  await new Promise<void>((resolve, reject) => {
    const tryListen = (p: number, retriesLeft = 0) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          // Hot restart: retry the same port up to 6s (24 x 250ms) before drifting
          if (p === port && retriesLeft < 24) {
            setTimeout(() => tryListen(p, retriesLeft + 1), 250)
          } else if (p < port + 64) {
            tryListen(p + 1)
          } else {
            activeServer = null
            reject(err)
          }
        } else {
          activeServer = null
          reject(err)
        }
      })
      server.listen(p, () => {
        resolve()
      })
    }
    tryListen(port)
  })
  const actual = activeServerPort() || port
  console.log(`selfforge serve: http://127.0.0.1:${actual}  (dashboard /, JSON-RPC POST /)`)
  return actual
}

function activeServerPort(): number | null {
  if (!activeServer) return null
  const addr = activeServer.address()
  return typeof addr === "object" && addr ? addr.port : null
}

/** For tests: spin a server on an ephemeral port and run JSON-RPC/API round-trips. */
export function serveEphemeral(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Access-Control-Allow-Origin", "*")
      if (req.method === "GET") {
        await serveStatic(req, res, req.url || "/")
        return
      }
      if (req.method !== "POST") {
        res.writeHead(405)
        res.end()
        return
      }
      try {
        const raw = await readBody(req)
        const reqObj = JSON.parse(raw) as RpcRequest
        const id = reqObj.id ?? null
        try {
          const result = await handle(String(reqObj.method), reqObj.params)
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ jsonrpc: "2.0", id, result }))
        } catch (err) {
          const e = err as Error
          dashLog("error", `rpc:${String(reqObj.method)}`, e.message, { stack: e.stack })
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify(rpcError(id, -32000, e.message)))
        }
      } catch (err) {
        const e = err as Error
        dashLog("error", "rpc:parse", e.message, { stack: e.stack })
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify(rpcError(null, -32000, e.message)))
      }
    })
    server.listen(0, () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      resolve({ port, close: () => server.close() })
    })
  })
}

