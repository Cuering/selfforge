import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { getDb, nodeId, clock, advanceClockTo } from "./db"
import { exportSnapshot, importSnapshot, transferStatus, SNAPSHOT_FORMAT } from "./transfer"
import { memoryList } from "./memory"
import { skillList, skillStatus } from "./skills"
import { workspaceList } from "./workspace"
import { goalStatus } from "./goals"
import { patternCandidates } from "./patterns"

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
  }
}

function apiGoals() {
  return goalStatus().map((g) => ({ id: g.uuid, goal: g.goal, status: g.status, project: g.project, updated_at: g.updated_at }))
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
  :root { --bg:#0f1115; --panel:#171a21; --line:#262b36; --fg:#d7dbe2; --dim:#8b93a3; --acc:#5b8def; --good:#4caf7d; --warn:#d9a13b; --bad:#e2605b; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; }
  header { padding:16px 24px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  header h1 { font-size:18px; margin:0; color:#fff; }
  header .sub { color:var(--dim); font-size:12px; }
  header button { margin-left:auto; background:var(--acc); color:#fff; border:0; padding:6px 14px; border-radius:6px; cursor:pointer; font-size:13px; }
  main { padding:16px 24px; display:grid; gap:16px; grid-template-columns:repeat(auto-fill,minmax(360px,1fr)); }
  section { background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  section h2 { margin:0; padding:10px 14px; font-size:13px; color:var(--dim); border-bottom:1px solid var(--line); text-transform:uppercase; letter-spacing:.05em; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(90px,1fr)); gap:8px; padding:12px; }
  .card { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
  .card b { display:block; font-size:20px; color:#fff; }
  .card span { color:var(--dim); font-size:11px; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th,td { text-align:left; padding:6px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:500; }
  td .tag { display:inline-block; padding:1px 7px; border-radius:99px; font-size:11px; margin-right:6px; }
  .t-hot{background:#3d2e1e;color:var(--warn);} .t-warm{background:#1e2a3d;color:var(--acc);} .t-cold{background:#262b36;color:var(--dim);}
  .s-active{background:#143524;color:var(--good);} .s-candidate{background:#1e2a3d;color:var(--acc);} .s-archived{background:#3a1e1e;color:var(--bad);} .s-stale{background:#332a1a;color:var(--warn);}
  .muted { color:var(--dim); }
  pre { margin:0; padding:10px 12px; overflow:auto; max-height:300px; font-size:11px; }
  .empty { padding:14px; color:var(--dim); font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>selfforge</h1>
  <span class="sub" id="sub">—</span>
  <button onclick="location.reload()">刷新</button>
</header>
<main>
  <section><h2>概览</h2><div class="cards" id="counts"></div></section>
  <section><h2>记忆</h2><div id="memories"><div class="empty">加载中…</div></div></section>
  <section><h2>技能</h2><div id="skills"><div class="empty">加载中…</div></div></section>
  <section><h2>目标</h2><div id="goals"><div class="empty">加载中…</div></div></section>
  <section><h2>待决策修复</h2><div id="repairs"><div class="empty">加载中…</div></div></section>
  <section><h2>模式候选</h2><div id="patterns"><div class="empty">加载中…</div></div></section>
</main>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
async function get(p){ const r = await fetch(p); return r.json(); }
function tierClass(t){ return "tag t-" + t; }
function statusClass(s){ return "tag s-" + s; }
async function boot(){
  const [dash, memories, skills, goals, repairs, patterns] = await Promise.all([
    get("/api/dashboard"), get("/api/memories"), get("/api/skills"), get("/api/goals"), get("/api/repairs"), get("/api/patterns")
  ]);
  const st = dash.status;
  document.getElementById("sub").textContent = "node " + st.node_id + " · clock " + st.clock + " · " + (st.home || st.db_path);
  const counts = dash.counts;
  document.getElementById("counts").innerHTML = Object.entries(counts).map(([k,v]) => "<div class=card><b>" + v + "</b><span>" + k + "</span></div>").join("");
  const memBox = document.getElementById("memories");
  if (!memories.length) memBox.innerHTML = '<div class="empty">暂无记忆</div>';
  else {
    let h = "<table><tr><th>强度</th><th>内容</th><th>作用域</th><th>时间</th></tr>";
    for (const m of memories.slice(0, 30)) h += "<tr><td>" + tierClass(m.tier) + m.strength + "</td><td>" + esc(m.content) + "</td><td class=muted>" + esc(m.scope || "") + "</td><td class=muted>" + esc((m.created_at || "").slice(0,10)) + "</td></tr>";
    memBox.innerHTML = h + "</table>";
  }
  const skBox = document.getElementById("skills");
  if (!skills.length) skBox.innerHTML = '<div class="empty">暂无技能</div>';
  else {
    let h = "<table><tr><th>名称</th><th>状态</th><th>η</th><th>试用</th></tr>";
    for (const s of skills.slice(0, 30)) h += "<tr><td>" + esc(s.name) + "</td><td>" + statusClass(s.status) + s.status + "</td><td>" + s.eta.toFixed(2) + "</td><td class=muted>" + s.passed + "/" + s.trials + "</td></tr>";
    skBox.innerHTML = h + "</table>";
  }
  const goBox = document.getElementById("goals");
  goBox.innerHTML = goals.length ? "<table><tr><th>目标</th><th>状态</th><th>项目</th></tr>" + goals.map(g => "<tr><td>" + esc(g.goal) + "</td><td>" + esc(g.status) + "</td><td class=muted>" + esc(g.project || "") + "</td></tr>").join("") + "</table>" : '<div class="empty">暂无目标</div>';
  const rpBox = document.getElementById("repairs");
  rpBox.innerHTML = repairs.length ? "<table><tr><th>类型</th><th>触发</th><th>草稿</th></tr>" + repairs.slice(0, 15).map(r => "<tr><td>" + esc(r.kind) + "</td><td class=muted>" + esc(r.trigger || "") + "</td><td>" + esc(r.draft) + "</td></tr>").join("") + "</table>" : '<div class="empty">暂无</div>';
  const ptBox = document.getElementById("patterns");
  ptBox.innerHTML = patterns.length ? "<table><tr><th>签名</th><th>工具</th><th>错误码</th><th>episodes</th></tr>" + patterns.map(p => "<tr><td>" + esc(p.sig) + "</td><td>" + esc(p.tool || "") + "</td><td class=muted>" + esc(p.err_code || "") + "</td><td>" + p.episodes + "</td></tr>").join("") + "</table>" : '<div class="empty">暂无成熟候选</div>';
}
boot().catch(e => document.body.insertAdjacentHTML("beforeend", "<pre>" + esc(e.stack) + "</pre>"));
</script>
</body>
</html>`
