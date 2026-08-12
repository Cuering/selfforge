#!/usr/bin/env bun
/**
 * Build the local opencode plugins to Node-compatible ESM (for the desktop app,
 * which runs on Node and cannot import .ts). Run `bun run build` (or
 * `bun build.mjs`) from the plugins/ directory after editing any plugin source.
 *
 * Output: compiled/<name>.js  (+ compiled/package.json { type: "module" })
 *
 * The desktop and CLI both load plugins; CLI (Bun) can take .ts directly, but
 * the desktop (Node/Electron) requires .js. We always emit .js so one artifact
 * works everywhere.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, "compiled")
const pluginEntries = ["browser-cdp.ts", "web-tools.ts", "selfforge.ts"]
// Non-plugin standalone entries are built but not self-checked as plugins
// (e.g. serve-daemon.js is run as a detached child process, not imported here).
const entries = [...pluginEntries, "selfforge/serve-daemon.ts"]

// Locate a bun binary (used to bundle .ts -> .js). Accept an explicit path via
// BUN env var; otherwise resolve bun from PATH or common install locations.
function findBun() {
  if (process.env.BUN && existsSync(process.env.BUN)) return process.env.BUN
  const fromPath = spawnSync("bun", ["--version"], { encoding: "utf8", shell: true })
  if (fromPath.status === 0 && fromPath.stdout) return "bun"
  const home = process.env.USERPROFILE || ""
  const candidates = [
    // plugin tree lives at <home>/.config/opencode/plugins — sibling projects
    resolve(home, "selfforge", "node_modules", ".bin", "bun.cmd"),
    resolve(home, "selfforge", "node_modules", ".bin", "bun"),
    resolve(home, ".bun", "bin", "bun.exe"),
    resolve(process.env.APPDATA || "", "npm", "bun.cmd"),
  ]
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c
    } catch {}
  }
  return "bun"
}

const bun = findBun()
console.log(`using bun: ${bun}`)

mkdirSync(out, { recursive: true })

// Emit compiled/package.json so Node treats the .js files as ESM.
writeFileSync(
  resolve(out, "package.json"),
  JSON.stringify(
    { name: "opencode-local-plugins-compiled", private: true, type: "module" },
    null,
    2
  )
)

let failed = false
for (const entry of entries) {
  const name = entry.replace(/\.ts$/, ".js")
  const res = spawnSync(
    bun,
    [
      "build",
      resolve(here, entry),
      "--outdir",
      out,
      "--target",
      "node",
      "--external",
      "@opencode-ai/plugin",
      "--format",
      "esm",
      "--minify",
    ],
    { encoding: "utf8", shell: true }
  )
  console.log(`built ${name}${res.status === 0 ? "" : ` (exit ${res.status})`}`)
  if (res.status !== 0) {
    failed = true
    if (res.stderr) console.error(res.stderr)
  }
}

// Post-build self-check: import each .js in Node and exercise the plugin factory,
// then call dispose() so background servers don't hold the process open.
const loader = resolve(here, ".build-check.mjs")
writeFileSync(
  loader,
  `import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const targets = process.env.PLUGIN_CHECKS.split(",")
for (const p of targets) {
  try {
    const m = await import(p)
    const fn = m.default || m[Object.keys(m).find((k) => k !== "default") || ""]
    if (typeof fn !== "function") throw new Error("no plugin function exported")
    const created = await fn({ client: { tool: { define: async () => {}, ids: async () => [] } }, directory: process.cwd() })
    if (typeof created?.dispose === "function") await created.dispose()
    console.log("[check] OK " + p)
  } catch (e) {
    console.error("[check] FAIL " + p + ": " + e.message)
    process.exitCode = 1
  }
}
setTimeout(() => process.exit(process.exitCode ?? 0), 500)
`
)

const checks = pluginEntries.map((e) => "file:///" + resolve(out, e.replace(/\.ts$/, ".js")).replace(/\\/g, "/"))
const checkRun = spawnSync(
  process.execPath,
  ["--no-warnings", loader],
  {
    encoding: "utf8",
    env: { ...process.env, PLUGIN_CHECKS: checks.join(","), SELFFORGE_NO_DAEMON: "1" },
    timeout: 60000,
  }
)
rmSync(loader, { force: true })
if (checkRun.stdout) console.log(checkRun.stdout)
if (checkRun.stderr) console.error(checkRun.stderr)
if (checkRun.status !== 0) failed = true

if (failed) {
  console.error("\nBUILD FAILED — fix errors above; old compiled/*.js kept in place.")
  process.exit(1)
}
console.log("\nBuild OK. Desktop will pick up the .js on next launch.")