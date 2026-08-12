/**
 * Dashboard SPA markup (HTML + CSS + client JS).
 *
 * Use a cooked tagged template (NOT String.raw):
 * - Bundlers may rewrite non-ASCII to \\uXXXX; cooked templates decode them,
 *   String.raw would leave literal "\\u9519" visible in the UI.
 * - Write \\\\n in embedded JS string literals so the client receives \\n
 *   (a JS escape), not a real newline that breaks <script> parse.
 *
 * Edit this file for UI changes. rpc.ts only imports and serves it.
 */
function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0] ?? ""
  for (let i = 0; i < values.length; i++) {
    out += String(values[i] ?? "") + (strings[i + 1] ?? "")
  }
  return out
}
export const DASHBOARD_HTML = html`

<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>selfforge</title>
<style>
  :root {
    --bg:#0f1115; --panel:#171a21; --line:#262b36; --fg:#d7dbe2; --dim:#8b93a3;
    --acc:#5b8def; --acc-txt:#9ec2ff; --on-acc:#fff; --good:#4caf7d; --warn:#d9a13b; --bad:#e2605b;
    --strong:#fff; --hover:#1c2130; --cnt-bg:#262b36;
    --t-hot-bg:#3d2e1e; --t-warm-bg:#1e2a3d; --t-cold-bg:#262b36; --t-evictable-bg:#332a1a;
    --s-active-bg:#143524; --s-candidate-bg:#1e2a3d; --s-trial-bg:#1e2a3d; --s-archived-bg:#3a1e1e; --s-stale-bg:#332a1a;
  }
  [data-theme="light"] {
    --bg:#f5f7fa; --panel:#ffffff; --line:#e1e6ef; --fg:#1c2733; --dim:#5c6b7a;
    --acc:#3b6fe0; --acc-txt:#1d4fb8; --on-acc:#fff; --good:#2e9e62; --warn:#b8811b; --bad:#d4524d;
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
  header button { background:var(--acc); color:var(--on-acc); border:0; padding:6px 14px; border-radius:6px; cursor:pointer; font-size:13px; }
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
  nav button.active { background:var(--acc); color:var(--on-acc); }
  nav button .cnt { background:var(--cnt-bg); color:var(--dim); border-radius:99px; font-size:11px; padding:1px 8px; }
  nav button.active .cnt { background:rgba(255,255,255,.22); color:var(--on-acc); }
  main { flex:1; padding:16px 22px; overflow-y:auto; min-width:0; }
  .tab-title { font-size:15px; color:var(--strong); margin:0 0 12px; }
  .toolbar { display:flex; gap:8px; margin:-4px 0 12px; min-height:30px; align-items:center; }
  .toolbar .tab-desc { color:var(--dim); font-size:12px; margin-right:auto; }
  .toolbar button.gen-btn { background:var(--acc); color:var(--on-acc); border:0; border-radius:6px; padding:4px 12px; font-size:12px; cursor:pointer; }
  .toolbar button.gen-btn:hover { filter:brightness(1.1); }
  .pane { display:none; }
  .pane.active { display:block; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:500; font-size:12px; white-space:nowrap; }
  .table-wrap table th:last-child, .table-wrap table td:last-child { position:sticky; right:0; background:var(--panel); border-left:1px solid var(--line); z-index:1; }
  th,td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  tbody tr:last-child td { border-bottom:0; }
  td .tag { display:inline-block; padding:1px 8px; border-radius:99px; font-size:11px; margin-right:6px; white-space:nowrap; }
  td .st { color:var(--dim); font-size:11px; }
  td .content-cell { min-width:240px; word-break:break-word; }
  .t-hot{background:var(--t-hot-bg);color:var(--warn);} .t-warm{background:var(--t-warm-bg);color:var(--acc-txt);} .t-cold{background:var(--t-cold-bg);color:var(--dim);} .t-evictable{background:var(--t-evictable-bg);color:var(--warn);}
  .s-active{background:var(--s-active-bg);color:var(--good);} .s-candidate{background:var(--s-candidate-bg);color:var(--acc-txt);} .s-trial{background:var(--s-trial-bg);color:var(--acc-txt);} .s-archived{background:var(--s-archived-bg);color:var(--bad);} .s-stale{background:var(--s-stale-bg);color:var(--warn);}
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
  .daycard ul { margin:0; padding-left:0; list-style:none; }
  .daycard li { display:flex; align-items:flex-start; gap:6px; padding:2px 0; }
  .daycard .kind { flex:none; min-width:70px; font-size:10px; color:var(--dim); border:1px solid var(--line); border-radius:4px; padding:0 4px; text-align:center; margin-top:1px; white-space:nowrap; }
  .daycard .st-done { color:#2e7d32; white-space:nowrap; } .daycard .st-pending { color:#c77700; white-space:nowrap; } .daycard .st-info { color:var(--dim); white-space:nowrap; }
  .daycard .review { margin:4px 0 8px; padding:6px 8px; background:rgba(127,127,127,.08); border-radius:6px; line-height:1.5; color:var(--strong); }
  #errBtn { position:relative; }
  #errBtn .badge { position:absolute; top:-6px; right:-8px; background:var(--bad); color:#fff; border-radius:99px; font-size:10px; min-width:16px; height:16px; line-height:16px; padding:0 4px; display:none; }
  #errBtn.has-err .badge { display:inline-block; }
  #errPanel { display:none; position:fixed; right:16px; bottom:16px; width:min(480px,92vw); max-height:50vh; background:var(--panel); border:1px solid var(--line); border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,.35); z-index:99; flex-direction:column; overflow:hidden; }
  #errPanel.open { display:flex; }
  #errPanel .eh { display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid var(--line); }
  #errPanel .eh b { flex:1; color:var(--strong); font-size:13px; }
  #errPanel .eh button { background:transparent; border:1px solid var(--line); color:var(--dim); border-radius:5px; padding:2px 8px; font-size:12px; cursor:pointer; }
  #errPanel .eh button:hover { color:var(--strong); border-color:var(--acc); }
  #errList { overflow:auto; padding:8px 12px; font-size:12px; }
  #errList .erow { padding:6px 0; border-bottom:1px solid var(--line); }
  #errList .erow:last-child { border-bottom:0; }
  #errList .elvl { display:inline-block; font-size:10px; padding:0 6px; border-radius:4px; margin-right:6px; }
  #errList .elvl-error { background:var(--s-archived-bg); color:var(--bad); }
  #errList .elvl-warn { background:var(--t-hot-bg); color:var(--warn); }
  #errList .elvl-info { background:var(--t-cold-bg); color:var(--dim); }
  #errList .emsg { color:var(--strong); word-break:break-word; }
  #errList .emeta { color:var(--dim); font-size:11px; margin-top:2px; }
  #errList .estack { color:var(--dim); font-size:10px; white-space:pre-wrap; max-height:80px; overflow:auto; margin-top:4px; display:none; }
  #errList .erow.open .estack { display:block; }
</style>
</head>
<body>
<header>
  <h1>selfforge</h1>
  <span class="sub" id="sub">—</span>
  <div class="actions">
    <button class="ghost" id="errBtn" onclick="toggleErrPanel()" title="运行错误日志">错误<span class="badge" id="errBadge">0</span></button>
    <button class="ghost" id="themeBtn" onclick="toggleTheme()">夜间</button>
    <button class="ghost" id="langBtn" onclick="toggleLang()" title="切换界面语言">EN</button>
    <button onclick="location.reload()">刷新</button>
    <button onclick="restartDaemon()" title="重启 daemon 进程以加载新编译代码">重启</button>
  </div>
</header>
<div id="errPanel">
  <div class="eh"><b>运行错误日志</b><button onclick="refreshErrPanel()">刷新</button><button onclick="clearErrPanel()">清空</button><button onclick="toggleErrPanel()">关闭</button></div>
  <div id="errList" class="empty">暂无错误</div>
</div>
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
    <section class="pane" id="pane-daily"><div class="panel" id="daily"><div class="empty">加载中…</div></div></section>
    <section class="pane" id="pane-workspaces"><div class="panel" id="workspaces"><div class="empty">加载中…</div></div></section>
  </main>
</div>
<script>
// Language: read from localStorage, fallback to browser locale.
let __lang = (() => {
  try {
    const saved = localStorage.getItem("lang");
    if (saved === "zh" || saved === "en") return saved;
    const l = (navigator.language || navigator.languages?.[0] || "en").toLowerCase();
    return l.startsWith("zh") ? "zh" : "en";
  } catch { return "en"; }
})();
function _l(zh, en){ return __lang === "zh" ? zh : en; }
function toggleLang(){
  __lang = __lang === "zh" ? "en" : "zh";
  try { localStorage.setItem("lang", __lang); } catch (e) {}
  location.reload();
}
function applyTheme(t){
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("theme", t); } catch (e) {}
  document.getElementById("themeBtn").textContent = _l(t === "light" ? "日间" : "夜间", t === "light" ? "Light" : "Dark");
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
// Apply language to static UI elements (header buttons, error panel, etc.)
function applyLang(){
  document.getElementById("langBtn").textContent = __lang === "zh" ? "EN" : "中文";
  document.getElementById("themeBtn").textContent = (() => {
    const t = document.documentElement.getAttribute("data-theme");
    return _l(t === "light" ? "日间" : "夜间", t === "light" ? "Light" : "Dark");
  })();
  document.getElementById("errBtn").childNodes[0].textContent = _l("错误","Logs");
  // Set header buttons by index (order: errBtn, themeBtn, langBtn, refresh, restart)
  const acts = document.querySelector("header .actions");
  if (acts) {
    const btns = acts.querySelectorAll("button");
    if (btns[3]) btns[3].textContent = _l("刷新","Reload");
    if (btns[4]) { btns[4].textContent = _l("重启","Restart"); btns[4].title = _l("重启 daemon 进程以加载新编译代码","Restart daemon to load new code"); }
  }
  const errPanel = document.getElementById("errPanel");
  if (errPanel) {
    const eh = errPanel.querySelector(".eh");
    if (eh) {
      eh.querySelector("b").textContent = _l("运行错误日志","Error Log");
      const btns = eh.querySelectorAll("button");
      if (btns[0]) btns[0].textContent = _l("刷新","Refresh");
      if (btns[1]) btns[1].textContent = _l("清空","Clear");
      if (btns[2]) btns[2].textContent = _l("关闭","Close");
    }
    const list = errPanel.querySelector("#errList");
    if (list && list.classList.contains("empty")) list.textContent = _l("暂无错误","No errors");
  }
}
applyLang();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const __localErrs = [];
function pushLocalErr(level, source, message, stack){
  __localErrs.unshift({ id: "L" + __localErrs.length, ts: new Date().toISOString(), level: level || "error", source: source || "client", message: String(message || ""), stack: stack || "" });
  if (__localErrs.length > 50) __localErrs.length = 50;
  updateErrBadge();
}
async function reportErr(level, source, message, stack, meta){
  pushLocalErr(level, source, message, stack);
  try {
    await fetch("/", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ jsonrpc:"2.0", id:1, method:"diagnostics.report", params:{ level, source, message:String(message||""), stack: stack ? String(stack) : undefined, meta } }) });
  } catch (e) {}
}
window.addEventListener("error", (ev) => {
  reportErr("error", "window.onerror", ev.message || String(ev.error || "error"), (ev.error && ev.error.stack) || (ev.filename + ":" + ev.lineno));
});
window.addEventListener("unhandledrejection", (ev) => {
  const r = ev.reason;
  reportErr("error", "unhandledrejection", (r && r.message) || String(r), r && r.stack);
});
let __remoteErrCount = 0;
function updateErrBadge(){
  const btn = document.getElementById("errBtn");
  const badge = document.getElementById("errBadge");
  if (!btn || !badge) return;
  const local = __localErrs.filter((e) => e.level === "error").length;
  const n = Math.max(local, __remoteErrCount);
  badge.textContent = String(n);
  btn.classList.toggle("has-err", n > 0);
}
function toggleErrPanel(){
  const p = document.getElementById("errPanel");
  if (!p) return;
  const open = !p.classList.contains("open");
  p.classList.toggle("open", open);
  if (open) refreshErrPanel();
}
async function refreshErrPanel(){
  const box = document.getElementById("errList");
  if (!box) return;
  let remote = [];
  try {
    const j = await get("/api/errors");
    remote = (j && j.entries) || [];
    __remoteErrCount = Number(j && j.errors) || remote.filter((e) => e.level === "error").length;
  } catch (e) { __remoteErrCount = 0; }
  const seen = new Set();
  const all = [];
  for (const e of __localErrs.concat(remote)) {
    const k = (e.ts || "") + "|" + (e.message || "");
    if (seen.has(k)) continue;
    seen.add(k);
    all.push(e);
  }
  all.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  if (!all.length) { box.className = "empty"; box.textContent = "暂无错误"; __remoteErrCount = 0; updateErrBadge(); return; }
  box.className = "";
  box.innerHTML = all.slice(0, 40).map((e, i) => {
    return '<div class="erow" data-i="' + i + '"><div><span class="elvl elvl-' + esc(e.level||"error") + '">' + esc(e.level||"error") + '</span><span class="emsg">' + esc(e.message) + '</span></div><div class="emeta">' + esc((e.ts||"").replace("T"," ").slice(0,19)) + " · " + esc(e.source||"") + '</div>' + (e.stack ? '<div class="estack">' + esc(e.stack) + '</div>' : "") + "</div>";
  }).join("");
  box.querySelectorAll(".erow").forEach((el) => el.addEventListener("click", () => el.classList.toggle("open")));
  updateErrBadge();
}
async function clearErrPanel(){
  __localErrs.length = 0;
  __remoteErrCount = 0;
  try { await rpc("diagnostics.clear", {}); } catch (e) {}
  updateErrBadge();
  refreshErrPanel();
}
async function get(p){
  const r = await fetch(p);
  if (!r.ok) {
    const msg = "GET " + p + " → " + r.status;
    reportErr("error", "fetch", msg);
    throw new Error(msg);
  }
  return r.json();
}
async function rpc(method, params){
  const r = await fetch("/", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ jsonrpc:"2.0", id:1, method, params }) });
  const j = await r.json();
  if (j.error) {
    const msg = method + ": " + j.error.message;
    reportErr("error", "rpc", msg);
    throw new Error(j.error.message);
  }
  return j.result;
}
const _L = { // bilingual labels
  memories: ["记忆","Memories"], skills: ["技能","Skills"], rules: ["规则","Rules"],
  goals: ["目标","Goals"], checkpoints: ["检查点","CP"],
  daily: ["每日总结","Daily"],
  workspaces: ["工作区","Workspaces"],
  done: ["已落实","Done"], pending: ["待跟进","Pending"], info: ["新信息","Info"],
  active: ["活跃","Active"], candidate: ["候选","Candidate"], archived: ["已归档","Archived"],
  stale: ["过期","Stale"], disabled: ["已停止","Disabled"],
  hot: ["热","Hot"], warm: ["温","Warm"], cold: ["冷","Cold"], evictable: ["可淘汰","Evictable"],
  temporary: ["临时","Temporary"], permanent: ["长期","Permanent"],
  "failure-burst": ["失败爆发","Burst"], "user.negative": ["用户差评","Negative"],
  "user.preference": ["用户偏好","Preference"], manual: ["手动","Manual"],
  failure: ["失败","Fail"], success: ["成功","Success"],
  global: ["全局","Global"], local: ["本地","Local"],
  completed: ["已完成","Completed"], stopped: ["已停止","Stopped"],
  pending_st: ["待审","Pending"], applied: ["已应用","Applied"], rejected: ["已拒绝","Rejected"],
  harden: ["加固","Harden"], innovate: ["创新","Innovate"], repair: ["修复","Repair"],
  generalize: ["泛化","Generalize"],
};
const TIER_ZH = { hot: _l("热","Hot"), warm: _l("温","Warm"), cold: _l("冷","Cold"), evictable: _l("可淘汰","Evictable") };
const STATUS_ZH = { confirmed: _l("已确认","Confirmed"), candidate: _l("候选","Candidate"), archived: _l("已归档","Archived"), stale: _l("过期","Stale"), active: _l("活跃","Active"), trial: _l("试用","Trial"), disabled: _l("已停止","Disabled") };
const LIFECYCLE_ZH = { temporary: _l("临时","Temporary"), active: _l("活跃","Active"), permanent: _l("长期","Permanent"), archived: _l("已归档","Archived") };
const GOAL_ZH = { active: _l("进行中","Active"), completed: _l("已完成","Done"), stopped: _l("已停止","Stopped") };
const REPAIR_ZH = { "failure-burst": _l("失败爆发","Burst"), "user.negative":_l("用户差评","Negative"), "user.preference":_l("用户偏好","Preference"), manual:_l("手动","Manual"), failure:_l("失败","Fail"), success:_l("成功","Success") };
const COUNT_ZH = { memories:_l("记忆","Memories"), skills:_l("技能","Skills"), rules:_l("规则","Rules"), goals:_l("目标","Goals"), checkpoints:_l("检查点","CP"), workspaces:_l("工作区","Workspaces") };
const TABS = [
  { id:"memories", label:_l("记忆","Memories"), key:"memories", desc:_l("长期知识库，按强度分级，可编辑内容/删除(归档)","Long-term knowledge base, tiered by strength, editable") },
  { id:"skills", label:_l("技能","Skills"), key:"skills", desc:_l("可复用工作流：候选→活跃→过期/归档；90天无试用淘汰","Reusable skills: candidate→active→stale/archived; 90d expiry"), gen:{ method:"skills.create", prompt:__lang==="zh"?"技能名称（英文 slug 或中文）：":"Skill name (slug):", desc:__lang==="zh"?"技能说明（中文，写清能完成什么任务）：":"Description (what it does):", args:["name","description"] } },
  { id:"rules", label:_l("规则","Rules"), key:"rules", desc:_l("行为规则，可升级写入 AGENTS.md","Behavioral rules, escalate to AGENTS.md"), gen:{ method:"rules.create", prompt:__lang==="zh"?"规则内容：":"Rule text:", args:["rule"] } },
  { id:"goals", label:_l("目标","Goals"), key:"goals", desc:_l("目标驱动循环，含检查点追踪","Goal-driven PDCA loop with checkpoints"), gen:{ method:"goals.create", prompt:__lang==="zh"?"目标：":"Goal:", desc:__lang==="zh"?"北星目标（可选）：":"North star (optional):", args:["goal","northStar"] } },
  { id:"checkpoints", label:_l("检查点","CP"), key:"checkpoints", desc:_l("目标下 CP0..CP6.5 的阶段状态","CP0..CP6.5 milestone status") },
  { id:"daily", label:_l("每日总结","Daily"), key:"daily", desc:_l("按天聚合的会话要点(蒸馏提取)","Daily session digests"), distill:true },
  { id:"workspaces", label:_l("工作区","Workspaces"), key:"workspaces", desc:_l("访问过的工作目录指纹","Visited workspace fingerprints") }
];
const TITLES = { memories:_l("记忆","Memories"), skills:_l("技能","Skills"), rules:_l("规则","Rules"), goals:_l("目标","Goals"), checkpoints:_l("检查点","CP"), daily:_l("每日总结","Daily"), workspaces:_l("工作区","Workspaces") };
const KIND_EDIT_LABEL = {
  skills:_l("编辑技能描述：","Edit skill description:"), rules:_l("编辑规则内容：","Edit rule:"), goals:_l("编辑目标：","Edit goal:"), checkpoints:_l("编辑备注：","Edit notes:"), workspaces:_l("编辑名称：","Edit name:")
};
const KIND_EDIT_FIELD = { skills:"description", rules:"rule", goals:"goal", checkpoints:"notes", workspaces:"name" };
function tierBadge(t, label){ return '<span class="tag t-' + t + '">' + esc(label || t) + "</span>"; }
function statusBadge(s, label){ return '<span class="tag s-' + s + '">' + esc(label || s) + "</span>"; }
function zh(obj, key, fb){ return (obj && key && obj[key]) || key || fb || ""; }
function memRow(m){
  const id = m.uuid || m.id;
  const tag = tierBadge(m.tier, zh(TIER_ZH, m.tier, m.tier));
  const act = '<span class=act><button onclick="editMem(' + "'" + id + "'" + ')">' + _l("编辑","Edit") + '</button><button class=del onclick="delMem(' + "'" + id + "'" + ')">' + _l("删除","Delete") + '</button></span>';
  return "<tr><td>" + tag + "<span class=st>" + _l("强度","Strength") + " " + m.strength + "</span></td><td class=content-cell>" + esc(m.content) + "</td><td class=muted>" + esc(m.scope || "") + "</td><td class=muted>" + esc((m.created_at || "").slice(0,10)) + "</td><td>" + act + "</td></tr>";
}
let editingId = null;
async function editMem(id){
  const m = (memoriesById || {})[id];
  if (!m) return;
  const v = prompt(_l("编辑记忆内容：","Edit memory content:"), m.content);
  if (v === null) return;
  await rpc("memory.update", { id, content: v }).then(() => boot()).catch((e) => alert(e.message));
}
window.editMem = editMem;
async function delMem(id){
  if (!confirm(_l("删除这条记忆？","Delete this memory?"))) return;
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
  if (tab && tab.desc) {
    const d = document.createElement("span");
    d.textContent = tab.desc;
    d.className = "tab-desc";
    bar.appendChild(d);
  }
  if (tab && tab.gen) {
    const btn = document.createElement("button");
    btn.textContent = _l("生成","Create");
    btn.className = "gen-btn";
    btn.addEventListener("click", () => genByTab(tab));
    bar.appendChild(btn);
  }
  if (tab && tab.id === "skills") {
    const b1 = document.createElement("button");
    b1.textContent = _l("接管opencode技能","Adopt opencode skills");
    b1.className = "gen-btn";
    b1.addEventListener("click", () => adoptSkills());
    bar.appendChild(b1);
    const b2 = document.createElement("button");
    b2.textContent = _l("从目录安装","Install from dir");
    b2.className = "gen-btn";
    b2.addEventListener("click", () => installSkillDir());
    bar.appendChild(b2);
    }
  if (tab && tab.distill) {
    const exbtn = document.createElement("button");
    exbtn.textContent = _l("导出","Export");
    exbtn.className = "gen-btn";
    exbtn.addEventListener("click", () => exportDaily());
    bar.appendChild(exbtn);
  }
}
async function editRow(kind, id, current, field){
  const label = (KIND_EDIT_LABEL[kind] || "编辑内容：");
  const v = prompt(label, current);
  if (v === null || v === current) return;
  try {
    await rpc("data.update", { kind, id, [field]: v });
    await boot();
  } catch (e) {
    alert(e.message);
  }
}
async function delRow(kind, id, label){
  if (!confirm(_l("删除","Delete") + " '" + (label || "") + "'?")) return;
  try {
    await rpc("data.delete", { kind, id });
    await boot();
  } catch (e) {
    alert(e.message);
  }
}
async function openDir(id){
  try {
    const res = await rpc("workspace.open", { id });
    if (!res.ok) alert(_l("无法打开目录","Cannot open directory"));
  } catch (e) {
    alert(e.message);
  }
}
function rowAct(kind, id, label, current){
  const field = KIND_EDIT_FIELD[kind];
  return '<span class=act><button onclick="editRow(' + "'" + kind + "'" + ',' + "'" + id + "'" + ',' + "'" + esc(current || "") + "'" + ',' + "'" + (field || "") + "'" + ')">' + _l("编辑","Edit") + '</button><button class=del onclick="delRow(' + "'" + kind + "'" + ',' + "'" + id + "'" + ',' + "'" + esc(label || "") + "'" + ')">' + _l("删除","Delete") + '</button></span>';
}
function skillRun(method, name){
  rpc(method, { name }).then((r) => { if (r.error) alert(r.error); else boot(); }).catch((e) => alert(e.message));
}
async function skillInfoBox(name){
  try {
    const r = await rpc("skills.info", { name });
    if (r.error) return alert(r.error);
    const st = zh(STATUS_ZH, r.status, r.status);
    alert("【" + r.name + "】\\n说明：" + (r.description || "（无）") + "\\n\\n状态：" + st + "  可靠度η=" + Number(r.eta).toFixed(2) + "  试用 " + r.trials + "\\n使用次数：" + r.usage + "  失败：" + r.fails + "  已优化：" + (r.optimized_at ? "是" : "否") + "\\n\\n路径：" + (r.location || "") + (r.loaded_by_opencode ? "\\n[opencode 当前可加载]" : "\\n[opencode 未加载，可能需重启]"));
  } catch (e) { alert(e.message); }
}
async function skillRate(name, positive){
  try {
    const r = await rpc("skills.feedback", { name, positive: !!positive });
    if (r.error) return alert(r.error);
    alert((positive ? "已点赞" : "已点踩") + "「" + name + "」  η=" + Number(r.eta).toFixed(2) + "  状态=" + zh(STATUS_ZH, r.status, r.status));
    await boot();
  } catch (e) { alert(e.message); }
}
// runSkillCurator removed
function skillRowAct(s){
  const en = s.status === "disabled" ? '<button onclick="skillRun(' + "'skills.enable'" + ',' + "'" + esc(s.name) + "'" + ')">' + _l("启动","Enable") + '</button>' : '<button class=del onclick="skillRun(' + "'skills.disable'" + ',' + "'" + esc(s.name) + "'" + ')">' + _l("停止","Stop") + '</button>';
  const up = '<button onclick="skillRate(' + "'" + esc(s.name) + "'" + ',true)" title="' + _l("有用，提高η","Useful, raise η") + '">' + _l("赞","👍") + '</button>';
  const dn = '<button class=del onclick="skillRate(' + "'" + esc(s.name) + "'" + ',false)" title="' + _l("无用，降低η","Useless, lower η") + '">' + _l("踩","👎") + '</button>';
  return '<span class=act>' + up + dn + en + '<button class=del onclick="delRow(' + "'skills'" + ',' + "'" + esc(s.id) + "'" + ',' + "'" + esc(s.name) + "'" + ')">' + _l("卸载","Uninstall") + '</button></span>';
}
async function adoptSkills(){
  try {
    const r = await rpc("skills.adopt", {});
    alert(_l("已接管技能：","Adopted: ") + (r.installed.length ? r.installed.join("、") : _l("（无新增）","(none new)")) + (r.skipped.length ? "\\n" + _l("跳过：","Skipped: ") + r.skipped.join("、") : ""));
    await boot();
  } catch (e) { alert(e.message); }
}
async function installSkillDir(){
  const d = prompt(_l("输入要安装技能的目录（会扫描其中所有 SKILL.md）：","Directory to scan for SKILL.md:"), "");
  if (d === null || !d.trim()) return;
  try {
    const r = await rpc("skills.install", { dir: d.trim() });
    alert(_l("已安装：","Installed: ") + (r.installed.length ? r.installed.join("、") : _l("（无）","(none)")) + (r.skipped.length ? "\\n" + _l("跳过：","Skipped: ") + r.skipped.join("、") : ""));
    await boot();
  } catch (e) { alert(e.message); }
}
async function genByTab(tab){
  const g = tab.gen;
  const skipTip = __lang === "zh" ? "(留空则跳过) " : "(leave empty to skip) ";
  const val = prompt(g.prompt + (g.desc ? skipTip : ""), "");
  if (val === null || !val.trim()) return;
  const params = { [g.args[0]]: val.trim() };
  if (g.desc) {
    const d = prompt(g.desc, "");
    if (d !== null && d.trim()) params[g.args[1]] = d.trim();
  }
  try {
    const res = await rpc(g.method, params);
    alert(_l("已生成：","Created: ") + (res.name || res.rule || res.goal || res.id || "OK"));
    await boot();
  } catch (e) {
    alert(e.message);
  }
}
// distillNow and refineDaily removed
// aiRefineStatus and aiRefineDaily removed
async function exportDaily(){
  try {
    const daily = await rpc("memory.daily", { limit: 14 });
    if (!daily || !daily.length) { alert("暂无每日总结数据"); return; }
    let txt = "# selfforge 每日总结\\n\\n";
    for (const d of daily) {
      txt += "## " + d.day + "  (" + d.session_count + " 个会话 · " + d.fact_count + " 条事项)\\n\\n";
      if (d.review) txt += d.review + "\\n\\n";
      for (const f of d.items) {
        txt += "- [" + f.kind + "] [" + { done:"已落实", pending:"待跟进", info:"新信息" }[f.status] + "]";
        if (f.text) txt += "\\n  " + f.text;
        txt += "\\n";
      }
      txt += "\\n";
    }
    const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "selfforge-daily-" + new Date().toISOString().slice(0,10) + ".md";
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    alert(e.message);
  }
}
async function boot(){
  // housekeeping before rendering: merge duplicate workspaces, prune done/useless checkpoints
  try { await rpc("workspace.merge", {}); } catch (e) {}
  try { await rpc("checkpoints.maintain", {}); } catch (e) {}
  const [dash, memories, skills, goals, daily, workspaces, rules, checkpoints] = await Promise.all([
    get("/api/dashboard"), get("/api/memories"), get("/api/skills"), get("/api/goals"),
    rpc("memory.daily", { limit: 14 }), get("/api/workspaces"), get("/api/rules"), get("/api/checkpoints")
  ]);
  memoriesById = {};
  for (const m of memories) memoriesById[m.uuid || m.id] = m;
  const st = dash.status;
  document.getElementById("sub").textContent = "节点 " + st.node_id + " · 时钟 " + st.clock + " · " + (st.home || st.db_path);
  const counts = dash.counts;
  document.getElementById("counts").innerHTML = Object.entries(counts).filter(([k]) => !["evolution","repairs","patterns"].includes(k)).map(([k,v]) => "<div class=card><b>" + v + "</b><span>" + zh(COUNT_ZH, k, k) + "</span></div>").join("");
  const nav = document.getElementById("nav");
  nav.innerHTML = TABS.map((t) => {
    const n = t.key === "daily" ? (daily ? daily.length : 0) : (t.key ? (counts[t.key] ?? 0) : "");
    return '<button data-tab="' + t.id + '"' + (t.id === activeTab ? ' class=active' : '') + '><span>' + t.label + "</span>" + (t.key ? "<span class=cnt>" + n + "</span>" : "") + "</button>";
  }).join("");
  nav.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => switchTab(b.getAttribute("data-tab"))));
  updateToolbar();
  const memBox = document.getElementById("memories");
  if (!memories.length) memBox.innerHTML = '<div class="empty">' + _l("暂无记忆","No memories") + '</div>';
  else {
    let h = "<div class=table-wrap><table><tr><th>" + _l("强度","Tier") + "</th><th>" + _l("内容","Content") + "</th><th>" + _l("作用域","Scope") + "</th><th>" + _l("时间","Date") + "</th><th>" + _l("操作","Actions") + "</th></tr>";
    for (const m of memories) h += memRow(m);
    memBox.innerHTML = h + "</table></div>";
  }
  const dlBox = document.getElementById("daily");
  dlBox.innerHTML = daily && daily.length ? daily.map((d) => {
    const stCls = { done: "st-done", pending: "st-pending", info: "st-info" };
    const statusTxt = { done: _l("已落实","Done"), pending: _l("待跟进","Pending"), info: _l("新信息","Info") };
    return "<div class=daycard><h3>" + d.day + "</h3><div class=meta>" + d.session_count + " " + _l("个会话","sessions") + " · " + d.fact_count + " " + _l("条事项","facts") + " · " + _l("已落实","Done") + " " + d.done_count + " · " + _l("待跟进","Pending") + " " + d.pending_count + "</div>" +
      (d.review ? "<div class=review>" + esc(d.review) + "</div>" : "") +
      "<ul>" + d.items.map((f) => "<li><span class=kind>" + esc(f.kind) + "</span><span class=" + stCls[f.status] + ">[" + statusTxt[f.status] + "]</span><span>" + esc(f.text || "") + "</span></li>").join("") + "</ul></div>";
  }).join("") : '<div class="empty">' + _l("暂无总结","No summaries") + '</div>';
  const skBox = document.getElementById("skills");
  if (!skills.length) skBox.innerHTML = '<div class="empty">' + _l("暂无技能","No skills") + '</div>';
  else {
    let h = "<div class=table-wrap><table><tr><th>" + _l("名称 / 说明","Name / Desc") + "</th><th>" + _l("状态","Status") + "</th><th>η</th><th>" + _l("试用","Trials") + "</th><th>" + _l("最近试用","Last used") + "</th><th>" + _l("操作","Actions") + "</th></tr>";
    for (const s of skills) {
      const last = s.last_used_at ? String(s.last_used_at).slice(0, 10) : _l("从未","never");
      const noDesc = __lang === "zh" ? "（无中文说明）" : "(no description)";
      const desc = __lang === "zh" ? (s.description || s.description_en || "") : (s.description_en || s.description || "");
      h += "<tr><td><b>" + esc(s.name) + "</b>" + (desc ? "<div class=muted>" + esc(desc) + "</div>" : "<div class=muted>" + noDesc + "</div>") + "</td><td>" + statusBadge(s.status, zh(STATUS_ZH, s.status, s.status)) + "</td><td>" + Number(s.eta).toFixed(2) + "</td><td class=muted>" + (s.passed || 0) + "/" + (s.trials || 0) + "</td><td class=muted>" + esc(last) + "</td><td>" + skillRowAct(s) + "</td></tr>";
    }
    skBox.innerHTML = h + "</table></div>";
  }
  const goBox = document.getElementById("goals");
  goBox.innerHTML = goals.length ? "<div class=table-wrap><table><tr><th>" + _l("目标","Goal") + "</th><th>" + _l("状态","Status") + "</th><th>" + _l("项目","Project") + "</th><th>" + _l("操作","Actions") + "</th></tr>" + goals.map(g => "<tr><td>" + esc(g.goal) + "</td><td>" + esc(zh(GOAL_ZH, g.status, g.status)) + "</td><td class=muted>" + esc(g.project || "") + "</td><td>" + rowAct("goals", g.id, g.goal, g.goal) + "</td></tr>").join("") + "</table></div>" : '<div class="empty">' + _l("暂无目标","No goals") + '</div>';
  const wsBox = document.getElementById("workspaces");
  wsBox.innerHTML = workspaces.length ? "<div class=table-wrap><table><tr><th>" + _l("名称","Name") + "</th><th>" + _l("路径","Path") + "</th><th>" + _l("访问","Visits") + "</th><th>" + _l("操作","Actions") + "</th></tr>" + workspaces.map(w => "<tr><td>" + esc(w.name) + "</td><td class=muted>" + esc(w.path || "") + "</td><td class=muted>" + esc((w.last_seen || "").slice(0,10)) + " · " + w.visits + "</td><td>" + '<span class=act><button class="open-dir" onclick="openDir(' + "'" + esc(w.id) + "'" + ')">' + _l("打开目录","Open") + '</button>' + rowAct("workspaces", w.id, w.name, w.name) + "</span></td></tr>").join("") + "</table></div>" : '<div class="empty">' + _l("暂无工作区","No workspaces") + '</div>';
  const ruBox = document.getElementById("rules");
  ruBox.innerHTML = rules.length ? "<div class=table-wrap><table><tr><th>" + _l("规则","Rule") + "</th><th>" + _l("域","Domain") + "</th><th>" + _l("范围","Scope") + "</th><th>" + _l("次数","Count") + "</th><th>" + _l("操作","Actions") + "</th></tr>" + rules.map(r => "<tr><td>" + esc(r.rule) + "</td><td class=muted>" + esc(r.domain || "") + "</td><td class=muted>" + esc(zh({ global:_l("全局","Global"), local:_l("本地","Local") }, r.explicit_scope, r.explicit_scope)) + "</td><td>" + r.count + "</td><td>" + rowAct("rules", r.uuid, "rule", r.rule) + "</td></tr>").join("") + "</table></div>" : '<div class="empty">' + _l("暂无规则","No rules") + '</div>';
  const cpBox = document.getElementById("checkpoints");
  cpBox.innerHTML = checkpoints.length ? function(){ var groups={},i; for(i=0;i<checkpoints.length;i++){ var c=checkpoints[i],g=c.goal||"(" + _l("无目标","none") + ")"; if(!groups[g]||groups[g].cp<c.cp) groups[g]=c } var entries=[]; for(var k in groups) entries.push(groups[k]); entries.sort(function(a,b){return a.cp>b.cp?-1:1}); return "<div class=table-wrap><table><tr><th>" + _l("目标","Goal") + "</th><th>" + _l("检查点","CP") + "</th><th>" + _l("状态","Status") + "</th><th>" + _l("备注","Notes") + "</th><th>" + _l("操作","Actions") + "</th></tr>" + entries.slice(0,20).map(function(c){return "<tr><td class=muted>"+esc(c.goal||"")+"</td><td>"+esc(c.cp)+"</td><td>"+esc(zh({done:_l("完成","Done"),pending:_l("待办","Pending"),skipped:_l("跳过","Skipped"),failed:_l("失败","Failed")},c.status,c.status))+"</td><td class=muted>"+esc(c.notes||"")+"</td><td>"+rowAct("checkpoints",c.uuid,_l("检查点","CP"),c.notes||"")+"</td></tr>"}).join("")+"</table></div>" }() : '<div class="empty">' + _l("暂无检查点","No checkpoints") + '</div>';
}
async function restartDaemon(){
  const btn = document.querySelector('header .actions button:last-child');
  if (btn) btn.textContent = "重启中…";
  try {
    await rpc("dashboard.restart", {});
  } catch (e) {
    // Daemon may exit before response body — ignore.
  }
  let up = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const j = await fetch("/api/ping").then((r) => r.json());
      if (j && j.pong === true) { up = true; break; }
    } catch {}
  }
  if (up) location.reload();
  else { alert("daemon 重启后未连接上，请手动启动或重启 opencode。"); location.reload(); }
}
boot().catch((e) => {
  reportErr("error", "boot", e.message || String(e), e.stack);
  const mem = document.getElementById("memories");
  if (mem) mem.innerHTML = '<div class="empty">加载失败：' + esc(e.message || e) + ' — 点右上角「错误」查看详情</div>';
  const p = document.getElementById("errPanel");
  if (p) { p.classList.add("open"); refreshErrPanel(); }
});
</script>
</body>
</html>
`
