import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { getDb, nodeId, clock, advanceClockTo, logObs } from "./db"
import { exportSnapshot, importSnapshot, transferStatus, SNAPSHOT_FORMAT } from "./transfer"
import { memoryList, memoryUpdateById, memoryArchiveById, memoryAdd } from "./memory"
import { dailySummaries, summarizeSession, sessionSummaryList } from "./summary"
import { skillCreate, skillList, skillStatus } from "./skills"
import { workspaceList } from "./workspace"
import { goalStatus, goalStart } from "./goals"
import { ruleObserve, ruleStatus } from "./rules"
import { evolutionPropose, evolutionList } from "./evolution"
import { patternCandidates, recordPattern } from "./patterns"
import { runRepair, recordSignal } from "./repair"
import { getSession, sessionSearch } from "./review"

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
    case "session.distill": {
      const sessions = sessionSummaryList({ limit: 500 })
      const target = params?.sessionId ? String(params.sessionId) : (sessions[0]?.session_id ?? "")
      if (!target) throw new Error("no session to distill")
      const s = getSession(target)
      let buf: Array<{ role: string; content: string }> = []
      try {
        buf = JSON.parse(s.buffer || "[]")
      } catch {}
      if (buf.length === 0) {
        const hits = sessionSearch("", { limit: 100 }).filter((h) => h.session_id === target)
        buf = hits.map((h) => ({ role: h.role, content: h.content }))
      }
      const row = summarizeSession(target, buf, s.turn_count)
      return { session_id: target, fact_count: row.fact_count, summary: row.summary }
    }
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
      if (d.counts.observations === 0) {
        logObs("seed", { note: "dashboard seed" }, "seed")
        created.observations = "1"
      }
      return { created, counts: apiDashboard().counts }
    }
    case "skills.list": {
      const list = skillList({ includeDeleted: false }).map((s) => ({
        id: s.uuid,
        name: s.name,
        status: s.status,
        eta: s.eta,
      }))
      return { skills: list, status: skillStatus() }
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
    status: s.status,
    eta: s.eta,
    trials: s.trials_attempted ?? 0,
    passed: s.trials_passed ?? 0,
  }))
}

function apiRepairs() {
  const rows = getDb()
    .query("SELECT * FROM repairs WHERE status NOT IN ('accepted','rejected') ORDER BY created_at DESC LIMIT 50")
    .all() as Array<{ uuid: string | null; kind: string; trigger: string; scope: string | null; draft: string; status: string; created_at: string }>
  return rows.map((r) => ({ id: r.uuid, kind: r.kind, trigger: r.trigger, scope: r.scope, draft: r.draft, status: r.status, created_at: r.created_at }))
}

function apiPatterns() {
  return patternCandidates().map((c) => ({ sig: c.sig_label, tool: c.tool, err_code: c.err_code, episodes: c.episodes }))
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
      checkpoints: count("checkpoints"),
      evolution: count("evolution"),
      observations: count("observations"),
      repairs: count("repairs"),
      workspaces: count("workspaces"),
    },
    observations: (() => {
      try {
        const rows = getDb()
          .query("SELECT type, project, created_at FROM observations WHERE deleted = 0 ORDER BY id DESC LIMIT 100")
          .all() as Array<{ type: string; project: string | null; created_at: string }>
        return rows
      } catch {
        return []
      }
    })(),
  }
}

function apiGoals() {
  return goalStatus().map((g) => ({ id: g.uuid, goal: g.goal, status: g.status, project: g.project, updated_at: g.updated_at }))
}

function apiRules() {
  return getDb()
    .query("SELECT rule, domain, explicit_scope, count, created_at FROM rules WHERE deleted = 0 ORDER BY id DESC LIMIT 100")
    .all() as Array<{ rule: string; domain: string; explicit_scope: string; count: number; created_at: string }>
}

function apiCheckpoints() {
  return getDb()
    .query(
      "SELECT c.cp, c.status, c.notes, c.created_at, g.goal, g.uuid AS goal_uuid FROM checkpoints c LEFT JOIN goals g ON g.id = c.goal_id WHERE c.deleted = 0 ORDER BY c.id DESC LIMIT 100"
    )
    .all() as Array<{ cp: string; status: string; notes: string | null; created_at: string; goal: string | null; goal_uuid: string | null }>
}

function apiEvolution() {
  return getDb()
    .query(
      "SELECT e.strategy, e.status, e.candidate, e.created_at, s.name AS skill_name FROM evolution e JOIN skills s ON s.id = e.skill_id ORDER BY e.id DESC LIMIT 50"
    )
    .all() as Array<{ strategy: string; status: string; candidate: string; created_at: string; skill_name: string }>
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, url: string) {
  const route = url.split("?")[0]
  if (route === "/" || route === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(DASHBOARD_HTML)
    return
  }
  if (route === "/api/status") return json(res, apiStatus())
  if (route === "/api/dashboard") return json(res, apiDashboard())
  if (route === "/api/memories") return json(res, apiMemories())
  if (route === "/api/skills") return json(res, apiSkills())
  if (route === "/api/goals") return json(res, apiGoals())
  if (route === "/api/repairs") return json(res, apiRepairs())
  if (route === "/api/patterns") return json(res, apiPatterns())
  if (route === "/api/workspaces") return json(res, workspaceList({ limit: 50 }))
  if (route === "/api/rules") return json(res, apiRules())
  if (route === "/api/checkpoints") return json(res, apiCheckpoints())
  if (route === "/api/evolution") return json(res, apiEvolution())
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
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(rpcError(id, -32000, (err as Error).message)))
      }
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify(rpcError(null, -32700, (err as Error).message)))
    }
  })
  activeServer = server
  await new Promise<void>((resolve, reject) => {
    const tryListen = (p: number) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && p < port + 64) {
          tryListen(p + 1)
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
        const result = await handle(String(reqObj.method), reqObj.params)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }))
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify(rpcError(null, -32000, (err as Error).message)))
      }
    })
    server.listen(0, () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      resolve({ port, close: () => server.close() })
    })
  })
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>selfforge</title>
<style>
  :root {
    --bg:#0f1115; --panel:#171a21; --line:#262b36; --fg:#d7dbe2; --dim:#8b93a3;
    --acc:#5b8def; --good:#4caf7d; --warn:#d9a13b; --bad:#e2605b;
    --strong:#fff; --hover:#1c2130; --cnt-bg:#262b36;
    --t-hot-bg:#3d2e1e; --t-warm-bg:#1e2a3d; --t-cold-bg:#262b36; --t-evictable-bg:#332a1a;
    --s-active-bg:#143524; --s-candidate-bg:#1e2a3d; --s-trial-bg:#1e2a3d; --s-archived-bg:#3a1e1e; --s-stale-bg:#332a1a;
  }
  [data-theme="light"] {
    --bg:#f5f7fa; --panel:#ffffff; --line:#e1e6ef; --fg:#1c2733; --dim:#5c6b7a;
    --acc:#3b6fe0; --good:#2e9e62; --warn:#b8811b; --bad:#d4524d;
    --strong:#0f1115; --hover:#eef2f8; --cnt-bg:#e7ecf3;
    --t-hot-bg:#fbe9d0; --t-warm-bg:#dce7fa; --t-cold-bg:#e8edf3; --t-evictable-bg:#f3e6c8;
    --s-active-bg:#d9f0e2; --s-candidate-bg:#dce7fa; --s-trial-bg:#e3ecfb; --s-archived-bg:#f7dcdb; --s-stale-bg:#f3e6c8;
  }
  * { box-sizing:border-box; }
  html,body { height:100%; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; display:flex; flex-direction:column; overflow:hidden; }
  header { padding:12px 20px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; flex:none; }
  header h1 { font-size:17px; margin:0; color:var(--strong); }
  header .sub { color:var(--dim); font-size:12px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  header .actions { margin-left:auto; display:flex; gap:8px; }
  header button { background:var(--acc); color:var(--strong); border:0; padding:6px 14px; border-radius:6px; cursor:pointer; font-size:13px; }
  header button.ghost { background:transparent; border:1px solid var(--line); color:var(--fg); }
  header button.ghost:hover { border-color:var(--acc); color:var(--acc); }
  .overview { padding:12px 20px; border-bottom:1px solid var(--line); flex:none; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(104px,1fr)); gap:8px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
  .card b { display:block; font-size:22px; color:var(--strong); line-height:1.2; }
  .card span { color:var(--dim); font-size:11px; }
  .layout { flex:1; display:flex; min-height:0; }
  nav { width:158px; flex:none; border-right:1px solid var(--line); padding:12px 8px; overflow-y:auto; }
  nav button { display:flex; align-items:center; justify-content:space-between; width:100%; background:transparent; border:0; border-radius:7px; color:var(--dim); padding:9px 12px; font-size:13px; cursor:pointer; margin-bottom:2px; font-family:inherit; }
  nav button:hover { background:var(--hover); color:var(--strong); }
  nav button.active { background:var(--acc); color:var(--strong); }
  nav button .cnt { background:var(--cnt-bg); color:var(--dim); border-radius:99px; font-size:11px; padding:1px 8px; }
  nav button.active .cnt { background:rgba(255,255,255,.22); color:var(--strong); }
  main { flex:1; padding:16px 22px; overflow-y:auto; min-width:0; }
  .tab-title { font-size:15px; color:var(--strong); margin:0 0 12px; }
  .toolbar { display:flex; gap:8px; margin:-4px 0 12px; min-height:30px; }
  .toolbar button.gen-btn { background:var(--acc); color:var(--strong); border:0; border-radius:6px; padding:4px 12px; font-size:12px; cursor:pointer; }
  .toolbar button.gen-btn:hover { filter:brightness(1.1); }
  .pane { display:none; }
  .pane.active { display:block; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:500; font-size:12px; white-space:nowrap; }
  tbody tr:last-child td { border-bottom:0; }
  td .tag { display:inline-block; padding:1px 8px; border-radius:99px; font-size:11px; margin-right:6px; white-space:nowrap; }
  td .st { color:var(--dim); font-size:11px; }
  td .content-cell { min-width:240px; word-break:break-word; }
  .t-hot{background:var(--t-hot-bg);color:var(--warn);} .t-warm{background:var(--t-warm-bg);color:var(--acc);} .t-cold{background:var(--t-cold-bg);color:var(--dim);} .t-evictable{background:var(--t-evictable-bg);color:var(--warn);}
  .s-active{background:var(--s-active-bg);color:var(--good);} .s-candidate{background:var(--s-candidate-bg);color:var(--acc);} .s-trial{background:var(--s-trial-bg);color:var(--acc);} .s-archived{background:var(--s-archived-bg);color:var(--bad);} .s-stale{background:var(--s-stale-bg);color:var(--warn);}
  .muted { color:var(--dim); }
  pre { margin:0; padding:10px 12px; overflow:auto; max-height:320px; font-size:11px; }
  .empty { padding:16px; color:var(--dim); font-size:12px; }
  td .act { display:inline-flex; gap:6px; white-space:nowrap; }
  td .act button { background:transparent; border:1px solid var(--line); color:var(--dim); border-radius:5px; padding:2px 10px; font-size:12px; cursor:pointer; white-space:nowrap; }
  td .act button:hover { color:var(--strong); border-color:var(--acc); }
  td .act button.del:hover { border-color:var(--bad); color:var(--bad); }
  .daycard { padding:12px 16px; font-size:12px; } .daycard + .daycard { border-top:1px solid var(--line); }
  .daycard h3 { margin:0 0 4px; font-size:13px; color:var(--strong); }
  .daycard .meta { color:var(--dim); font-size:11px; margin-bottom:6px; }
  .daycard ul { margin:0; padding-left:18px; }
</style>
</head>
<body>
<header>
  <h1>selfforge</h1>
  <span class="sub" id="sub">—</span>
  <div class="actions">
    <button class="ghost" id="themeBtn" onclick="toggleTheme()">夜间</button>
    <button onclick="location.reload()">刷新</button>
  </div>
</header>
<div class="overview"><div class="cards" id="counts"></div></div>
<div class="layout">
  <nav id="nav"></nav>
  <main id="main">
    <h2 class="tab-title" id="tabTitle">记忆</h2>
    <div class="toolbar" id="toolbar"></div>
    <section class="pane active" id="pane-memories"><div class="panel" id="memories"><div class="empty">加载中…</div></div></section>
    <section class="pane" id="pane-skills"><div class="panel" id="skills"><div class="empty">加载中…</div></div></section>
    <section class="pane" id="pane-rules"><div class="panel" id="rules"><div class="empty">加载中…</div></div></section>
    <section class="pane" id="pane-goals"><div class="panel" id="goals"><div class="empty">加载中…</div></div></section>
    <section class="pane" id="pane-checkpoints"><div class="panel" id="checkpoints"><div class="empty">加载中…</div></div></section>
    <section class="pane" id="pane-evolution"><div class="panel" id="evolution"><div class="empty">加载中…</div></div></section>
    <section class="pane" id="pane-daily"><div class="panel" id="daily"><div class="empty">加载中…</div></div></section>
    <section class="pane" id="pane-repairs"><div class="panel" id="repairs"><div class="empty">加载中…</div></div></section>
    <section class="pane" id="pane-patterns"><div class="panel" id="patterns"><div class="empty">加载中…</div></div></section>
    <section class="pane" id="pane-observations"><div class="panel" id="observations"><div class="empty">加载中…</div></div></section>
    <section class="pane" id="pane-workspaces"><div class="panel" id="workspaces"><div class="empty">加载中…</div></div></section>
  </main>
</div>
<script>
function applyTheme(t){
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("theme", t); } catch (e) {}
  document.getElementById("themeBtn").textContent = t === "light" ? "夜间" : "日间";
}
function toggleTheme(){
  applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light");
}
(function(){
  let t = "dark";
  try { t = localStorage.getItem("theme") || t; } catch (e) {}
  if (t !== "light" && t !== "dark") t = "dark";
  if (t === "dark" && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) t = "light";
  applyTheme(t);
})();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
async function get(p){ const r = await fetch(p); return r.json(); }
async function rpc(method, params){
  const r = await fetch("/", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ jsonrpc:"2.0", id:1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const TIER_ZH = { hot:"热", warm:"温", cold:"冷", evictable:"可淘汰" };
const STATUS_ZH = { confirmed:"已确认", candidate:"候选", archived:"已归档", stale:"过期", active:"活跃", trial:"试用" };
const LIFECYCLE_ZH = { temporary:"临时", active:"活跃", permanent:"长期", archived:"已归档" };
const GOAL_ZH = { active:"进行中", completed:"已完成", stopped:"已停止" };
const REPAIR_ZH = { "failure-burst":"失败爆发", "user.negative":"用户差评", "user.preference":"用户偏好", manual:"手动", failure:"失败", success:"成功" };
const COUNT_ZH = { memories:"记忆", skills:"技能", rules:"规则", goals:"目标", checkpoints:"检查点", evolution:"演进", observations:"观测", repairs:"修复", patterns:"模式", workspaces:"工作区" };
const TABS = [
  { id:"memories", label:"记忆", key:"memories" },
  { id:"skills", label:"技能", key:"skills", gen:{ method:"skills.create", prompt:"技能名称：", desc:"技能描述：", args:["name","description"] } },
  { id:"rules", label:"规则", key:"rules", gen:{ method:"rules.create", prompt:"规则内容：", args:["rule"] } },
  { id:"goals", label:"目标", key:"goals", gen:{ method:"goals.create", prompt:"目标：", desc:"北星目标（可选）：", args:["goal","northStar"] } },
  { id:"checkpoints", label:"检查点", key:"checkpoints" },
  { id:"evolution", label:"演进", key:"evolution", gen:{ method:"evolution.create", prompt:"技能名：", desc:"策略(harden/innovate/repair/generalize)：", args:["skill","strategy"] } },
  { id:"daily", label:"每日总结", key:"daily", distill:true },
  { id:"repairs", label:"修复草稿", key:"repairs", gen:{ method:"repairs.create", prompt:"工具名：", args:["tool"] } },
  { id:"patterns", label:"模式候选", key:"patterns", gen:{ method:"patterns.record", prompt:"工具名：", args:["tool"] } },
  { id:"observations", label:"观测", key:"observations" },
  { id:"workspaces", label:"工作区", key:"workspaces" }
];
const TITLES = { memories:"记忆", skills:"技能", rules:"规则", goals:"目标", checkpoints:"检查点", evolution:"演进", daily:"每日总结", repairs:"修复草稿", patterns:"模式候选", observations:"观测", workspaces:"工作区" };
function tierBadge(t, label){ return '<span class="tag t-' + t + '">' + esc(label || t) + "</span>"; }
function statusBadge(s, label){ return '<span class="tag s-' + s + '">' + esc(label || s) + "</span>"; }
function zh(obj, key, fb){ return (obj && key && obj[key]) || key || fb || ""; }
function memRow(m){
  const id = m.uuid || m.id;
  const tag = tierBadge(m.tier, zh(TIER_ZH, m.tier, m.tier));
  const act = '<span class=act><button onclick="editMem(' + "'" + id + "'" + ')">编辑</button><button class=del onclick="delMem(' + "'" + id + "'" + ')">删除</button></span>';
  return "<tr><td>" + tag + "<span class=st>强度 " + m.strength + "</span></td><td class=content-cell>" + esc(m.content) + "</td><td class=muted>" + esc(m.scope || "") + "</td><td class=muted>" + esc((m.created_at || "").slice(0,10)) + "</td><td>" + act + "</td></tr>";
}
let editingId = null;
async function editMem(id){
  const m = (memoriesById || {})[id];
  if (!m) return;
  const v = prompt("编辑记忆内容：", m.content);
  if (v === null) return;
  await rpc("memory.update", { id, content: v }).then(() => boot()).catch((e) => alert(e.message));
}
window.editMem = editMem;
async function delMem(id){
  if (!confirm("删除这条记忆？")) return;
  await rpc("memory.delete", { id }).then(() => boot()).catch((e) => alert(e.message));
}
window.delMem = delMem;
let memoriesById = {};
let activeTab = "memories";
function switchTab(id){
  activeTab = id;
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + id));
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.getAttribute("data-tab") === id));
  document.getElementById("tabTitle").textContent = TITLES[id] || id;
  updateToolbar();
}
function updateToolbar(){
  const tab = TABS.find((t) => t.id === activeTab);
  const bar = document.getElementById("toolbar");
  if (!bar) return;
  bar.innerHTML = "";
  if (tab && tab.gen) {
    const btn = document.createElement("button");
    btn.textContent = "生成";
    btn.className = "gen-btn";
    btn.addEventListener("click", () => genByTab(tab));
    bar.appendChild(btn);
  }
  if (tab && tab.distill) {
    const btn = document.createElement("button");
    btn.textContent = "蒸馏";
    btn.className = "gen-btn";
    btn.addEventListener("click", () => distillNow());
    bar.appendChild(btn);
  }
}
async function genByTab(tab){
  const g = tab.gen;
  const val = prompt(g.prompt + (g.desc ? "(留空则跳过) " : ""), "");
  if (val === null || !val.trim()) return;
  const params = { [g.args[0]]: val.trim() };
  if (g.desc) {
    const d = prompt(g.desc, "");
    if (d !== null && d.trim()) params[g.args[1]] = d.trim();
  }
  try {
    const res = await rpc(g.method, params);
    alert("已生成：" + (res.name || res.rule || res.goal || res.id || "OK"));
    await boot();
  } catch (e) {
    alert(e.message);
  }
}
async function distillNow(){
  try {
    const res = await rpc("session.distill", {});
    alert("已蒸馏要点 " + res.fact_count + " 条" + (res.summary ? "：" + esc(res.summary).slice(0, 80) : "（无可提取内容）"));
    await boot();
  } catch (e) {
    alert(e.message);
  }
}
async function boot(){
  const [dash, memories, skills, goals, repairs, patterns, daily, workspaces, rules, checkpoints, evolution] = await Promise.all([
    get("/api/dashboard"), get("/api/memories"), get("/api/skills"), get("/api/goals"), get("/api/repairs"), get("/api/patterns"),
    rpc("memory.daily", { limit: 14 }), get("/api/workspaces"), get("/api/rules"), get("/api/checkpoints"), get("/api/evolution")
  ]);
  memoriesById = {};
  for (const m of memories) memoriesById[m.uuid || m.id] = m;
  const st = dash.status;
  document.getElementById("sub").textContent = "节点 " + st.node_id + " · 时钟 " + st.clock + " · " + (st.home || st.db_path);
  const counts = dash.counts;
  document.getElementById("counts").innerHTML = Object.entries(counts).map(([k,v]) => "<div class=card><b>" + v + "</b><span>" + zh(COUNT_ZH, k, k) + "</span></div>").join("");
  const nav = document.getElementById("nav");
  nav.innerHTML = TABS.map((t) => {
    const n = t.key === "daily" ? (daily ? daily.length : 0) : (t.key ? (counts[t.key] ?? 0) : "");
    return '<button data-tab="' + t.id + '"' + (t.id === activeTab ? ' class=active' : '') + '><span>' + t.label + "</span>" + (t.key ? "<span class=cnt>" + n + "</span>" : "") + "</button>";
  }).join("");
  nav.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => switchTab(b.getAttribute("data-tab"))));
  updateToolbar();
  const memBox = document.getElementById("memories");
  if (!memories.length) memBox.innerHTML = '<div class="empty">暂无记忆</div>';
  else {
    let h = "<div class=table-wrap><table><tr><th>强度</th><th>内容</th><th>作用域</th><th>时间</th><th>操作</th></tr>";
    for (const m of memories) h += memRow(m);
    memBox.innerHTML = h + "</table></div>";
  }
  const dlBox = document.getElementById("daily");
  dlBox.innerHTML = daily && daily.length ? daily.map((d) => "<div class=daycard><h3>" + d.day + "</h3><div class=meta>" + d.session_count + " 个会话 · " + d.fact_count + " 条要点</div><ul>" + d.facts.map((f) => "<li>" + esc(f) + "</li>").join("") + "</ul></div>").join("") : '<div class="empty">暂无总结</div>';
  const skBox = document.getElementById("skills");
  if (!skills.length) skBox.innerHTML = '<div class="empty">暂无技能</div>';
  else {
    let h = "<div class=table-wrap><table><tr><th>名称</th><th>状态</th><th>η</th><th>试用</th></tr>";
    for (const s of skills) h += "<tr><td>" + esc(s.name) + "</td><td>" + statusBadge(s.status, zh(STATUS_ZH, s.status, s.status)) + "</td><td>" + s.eta.toFixed(2) + "</td><td class=muted>" + s.passed + "/" + s.trials + "</td></tr>";
    skBox.innerHTML = h + "</table></div>";
  }
  const goBox = document.getElementById("goals");
  goBox.innerHTML = goals.length ? "<div class=table-wrap><table><tr><th>目标</th><th>状态</th><th>项目</th></tr>" + goals.map(g => "<tr><td>" + esc(g.goal) + "</td><td>" + esc(zh(GOAL_ZH, g.status, g.status)) + "</td><td class=muted>" + esc(g.project || "") + "</td></tr>").join("") + "</table></div>" : '<div class="empty">暂无目标</div>';
  const rpBox = document.getElementById("repairs");
  rpBox.innerHTML = repairs.length ? "<div class=table-wrap><table><tr><th>类型</th><th>触发</th><th>草稿</th></tr>" + repairs.slice(0, 15).map(r => "<tr><td>" + esc(zh(REPAIR_ZH, r.kind, r.kind)) + "</td><td class=muted>" + esc(zh(REPAIR_ZH, r.trigger, r.trigger)) + "</td><td>" + esc(r.draft) + "</td></tr>").join("") + "</table></div>" : '<div class="empty">暂无</div>';
  const ptBox = document.getElementById("patterns");
  ptBox.innerHTML = patterns.length ? "<div class=table-wrap><table><tr><th>签名</th><th>工具</th><th>错误码</th><th>次数</th></tr>" + patterns.map(p => "<tr><td>" + esc(p.sig) + "</td><td>" + esc(p.tool || "") + "</td><td class=muted>" + esc(p.err_code || "") + "</td><td>" + p.episodes + "</td></tr>").join("") + "</table></div>" : '<div class="empty">暂无成熟候选</div>';
  const wsBox = document.getElementById("workspaces");
  wsBox.innerHTML = workspaces.length ? "<div class=table-wrap><table><tr><th>名称</th><th>路径</th><th>访问</th></tr>" + workspaces.map(w => "<tr><td>" + esc(w.name) + "</td><td class=muted>" + esc(w.path || "") + "</td><td class=muted>" + esc((w.last_seen || "").slice(0,10)) + " · " + w.visits + "</td></tr>").join("") + "</table></div>" : '<div class="empty">暂无工作区</div>';
  const obBox = document.getElementById("observations");
  obBox.innerHTML = dash.observations && dash.observations.length ? "<div class=table-wrap><table><tr><th>类型</th><th>项目</th><th>时间</th></tr>" + dash.observations.slice(0, 50).map(o => "<tr><td>" + esc(o.type) + "</td><td class=muted>" + esc(o.project || "") + "</td><td class=muted>" + esc((o.created_at || "").slice(0,19)) + "</td></tr>").join("") + "</table></div>" : '<div class="empty">暂无观测</div>';
  const ruBox = document.getElementById("rules");
  ruBox.innerHTML = rules.length ? "<div class=table-wrap><table><tr><th>规则</th><th>域</th><th>范围</th><th>次数</th></tr>" + rules.map(r => "<tr><td>" + esc(r.rule) + "</td><td class=muted>" + esc(r.domain || "") + "</td><td class=muted>" + esc(zh({ global:"全局", local:"本地" }, r.explicit_scope, r.explicit_scope)) + "</td><td>" + r.count + "</td></tr>").join("") + "</table></div>" : '<div class="empty">暂无规则</div>';
  const cpBox = document.getElementById("checkpoints");
  cpBox.innerHTML = checkpoints.length ? "<div class=table-wrap><table><tr><th>检查点</th><th>状态</th><th>目标</th><th>备注</th></tr>" + checkpoints.slice(0, 60).map(c => "<tr><td>" + esc(c.cp) + "</td><td>" + esc(zh({ done:"完成", pending:"待办", skipped:"跳过", failed:"失败" }, c.status, c.status)) + "</td><td class=muted>" + esc(c.goal || "") + "</td><td class=muted>" + esc(c.notes || "") + "</td></tr>").join("") + "</table></div>" : '<div class="empty">暂无检查点</div>';
  const evBox = document.getElementById("evolution");
  evBox.innerHTML = evolution.length ? "<div class=table-wrap><table><tr><th>策略</th><th>状态</th><th>技能</th><th>候选</th></tr>" + evolution.slice(0, 30).map(e => "<tr><td>" + esc(zh({ harden:"加固", innovate:"创新", repair:"修复", generalize:"泛化" }, e.strategy, e.strategy)) + "</td><td>" + esc(zh({ pending:"待审", applied:"已应用", rejected:"已拒绝" }, e.status, e.status)) + "</td><td class=muted>" + esc(e.skill_name || "") + "</td><td>" + esc(e.candidate) + "</td></tr>").join("") + "</table></div>" : '<div class="empty">暂无演进候选</div>';
  // auto-seed empty categories once
  try {
    if (!localStorage.getItem("seeded")) {
      const res = await rpc("dashboard.seed", {});
      localStorage.setItem("seeded", "1");
      if (res && res.created && Object.keys(res.created).length) await boot();
    }
  } catch (e) {}
}
boot().catch(e => document.body.insertAdjacentHTML("beforeend", "<pre>" + esc(e.stack) + "</pre>"));
</script>
</body>
</html>`
