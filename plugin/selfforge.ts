import type { Plugin } from "@opencode-ai/plugin"
import { initDb, getConfig, logObs, closeDb, vacuumDb } from "./selfforge/lib/db"
import {
  memoryDecay,
  composeMemoryContext,
  scheduleContextRefresh,
  liveMemoryInjection,
} from "./selfforge/lib/memory"
import { syncSkillsToDisk, recordSkillUse } from "./selfforge/lib/skills"
import { goalAdvisory, maintainCheckpoints } from "./selfforge/lib/goals"
import { evolutionAdvisory } from "./selfforge/lib/evolution"
import { redact, truncate, spawnReview, spawnReviewSdk, getSession, sessionSet, bufferPush, isTrivial } from "./selfforge/lib/review"
import { memoryTools } from "./selfforge/lib/tools/memory"
import { userTools } from "./selfforge/lib/tools/user"
import { skillTools } from "./selfforge/lib/tools/skills"
import { ruleTools } from "./selfforge/lib/tools/rules"
import { goalTools } from "./selfforge/lib/tools/goals"
import { evolutionTools } from "./selfforge/lib/tools/evolution"
import { curatorTools } from "./selfforge/lib/tools/curator"
import { repairTools } from "./selfforge/lib/tools/repair"
import { patternTools } from "./selfforge/lib/tools/patterns"
import { workspaceTools } from "./selfforge/lib/tools/workspace"
import { summaryTools } from "./selfforge/lib/tools/summary"
import { evalTools } from "./selfforge/lib/tools/eval"
import { transferTools } from "./selfforge/lib/tools/transfer"
import { teamTools } from "./selfforge/lib/tools/team"
import { dashboardTools } from "./selfforge/lib/tools/dashboard"
import { recordSignal } from "./selfforge/lib/repair"
import { touchWorkspace, scopeFor, fingerprintOf, mergeDuplicateWorkspaces } from "./selfforge/lib/workspace"
import { summarizeSession, getSessionSummary } from "./selfforge/lib/summary"
import { closeServer, ensureDashboard } from "./selfforge/lib/rpc"
import { recordCall } from "./selfforge/lib/dashboard-log"

export const Selfforge: Plugin = async ({ client, directory, worktree }) => {
  const db = initDb()
  syncSkillsToDisk()

  const projectName = () =>
    (directory || worktree || process.cwd()).split(/[\\/]/).pop() || "unknown"

  // Feature 4: workspace-aware memory injection (tiered fusion)
  let wsScope: string | null = null
  try {
    const dir = directory || worktree || process.cwd()
    wsScope = scopeFor(dir, fingerprintOf(dir))
  } catch {}

  // Seed instructions file + register default scope for later hot reloads.
  scheduleContextRefresh({ wsScope: wsScope ?? undefined, immediate: true })
  logObs("plugin_loaded", { version: "1.9.0" }, projectName())
  try {
    touchWorkspace(directory || worktree || process.cwd())
  } catch {}
  try {
    memoryDecay()
  } catch {}

  // Feature: ensure the dashboard is served by a stable detached daemon so the
  // browser dashboard and /selfforge command always have a live endpoint, even
  // across opencode restarts and background data writes.
  if (process.env.SELFFORGE_NO_DAEMON !== "1") {
    try {
      void ensureDashboard(9210)
    } catch {}
  }

  const threshold = () => Number(getConfig("review_threshold", "5"))
  const idleCooldown = () => Number(getConfig("idle_cooldown_ms", "300000"))
  const maintenanceInterval = () => Number(getConfig("maintenance_interval_ms", "3600000"))
  const vacuumInterval = () => Number(getConfig("vacuum_interval_ms", "86400000"))
  const sessionReviewOnIdle = () => getConfig("session_review_on_idle", "true") !== "false"

  // Resolve the review wrapper executable
  const reviewCmd = (): string => {
    const { join } = require("node:path")
    if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN
    // npm global install layout
    const candidates = [
      join(process.env.APPDATA || "", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"),
      join(process.env.USERPROFILE || "", "AppData", "Roaming", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"),
      "opencode",
    ]
    for (const c of candidates) {
      try {
        const { existsSync } = require("node:fs")
        if (existsSync(c)) return c
      } catch {}
    }
    return "opencode"
  }

  // message buffering state
  const messageTexts = new Map<string, string>()
  const messageRoles = new Map<string, string>()
  let lastIdleReview = 0
  let lastMaintenance = 0
  let lastVacuum = 0
  let reviewInProgress = false

  const REVIEW_HEADING = "# Autolearn Review"

  // IDs of review sub-sessions we spawned via the SDK. Their own messages must
  // not re-trigger a review (infinite loop guard).
  const reviewSessionIDs = new Set<string>()

  function isReviewSession(sid: string): boolean {
    return reviewSessionIDs.has(sid)
  }

  function maybeSpawnReview(sessionId: string, reason: string) {
    if (reviewInProgress) return
    const s = getSession(sessionId)
    let buf: Array<{ role: string; content: string }>
    try {
      buf = JSON.parse(s.buffer || "[]")
    } catch {
      buf = []
    }
    if (buf.length === 0) return
    if (buf.map((m) => m.content).join(" ").includes(REVIEW_HEADING)) {
      sessionSet(sessionId, { buffer: "[]" })
      return
    }
    reviewInProgress = true
    const captured = [...buf]
    // Prefer the in-process SDK path (works on desktop where the npm CLI binary
    // is broken/missing and in the CLI), falling back to a detached CLI spawn.
    const res = spawnReviewSdk(client, captured, s.project || projectName(), (sid) =>
      reviewSessionIDs.add(sid)
    )
    void res.then((r) => {
      if (!r.spawned) {
        const legacy = spawnReview(captured, s.project || projectName(), reviewCmd())
        logObs("review_fallback_cli", { ok: legacy.spawned, error: legacy.error }, s.project || projectName())
      }
      sessionSet(sessionId, { buffer: "[]", last_review_turn: s.turn_count })
      // Feature 1: distill the consumed buffer into a fixed-size session state
      let facts = 0
      try {
        summarizeSession(sessionId, captured, s.turn_count)
        facts = getSessionSummary(sessionId)?.fact_count ?? 0
        scheduleContextRefresh({
          wsScope: wsScope ?? undefined,
          includeSession: sessionId,
        })
      } catch {}
      // Single consolidated observation per trigger (was 3 noisy rows: review_spawned,
      // session_summary_built, review_triggered).
      logObs(
        "review_triggered",
        { reason, result: r, session: sessionId, summary_facts: facts },
        s.project || projectName()
      )
    })
    setTimeout(() => {
      reviewInProgress = false
    }, 10000)
  }

  const hooks = {
    event: async ({ event }: { event: any }) => {
      try {
        const props = event.properties || {}

        switch (event.type) {
          case "session.created": {
            const info = props.info || {}
            const sid = info.id || props.sessionID
            if (sid) {
              // Skip bookkeeping for our own review sub-sessions.
              if (isReviewSession(sid)) break
              getSession(sid)
              sessionSet(sid, { project: projectName() })
              logObs("session_created", { session: sid }, projectName())
            }
            break
          }

          case "message.updated": {
            const info = props.info || {}
            const msgId = info.id
            const role = info.role
            if (!msgId || !role) break
            const sid = (info.sessionID as string) || (info.sessionId as string) || ""
            if (!sid) break
            // Skip buffering/tracking for our own review sub-sessions.
            if (isReviewSession(sid)) {
              messageTexts.delete(msgId)
              break
            }
            messageRoles.set(msgId, role)
            const text = messageTexts.get(msgId) || ""
            if (text && role === "assistant") {
              const s = getSession(sid)
              if (isTrivial(text)) break
              const buf = bufferPush(s, {
                role: "assistant",
                content: redact(truncate(text, 2000)),
              })
              const next = sessionSet(sid, { turn_count: s.turn_count + 1, buffer: JSON.stringify(buf) })
              if (next.turn_count - next.last_review_turn >= threshold()) {
                maybeSpawnReview(sid, "threshold")
              }
            } else if (text && role === "user") {
              const s = getSession(sid)
              if (isTrivial(text)) break
              const buf = bufferPush(s, {
                role: "user",
                content: redact(truncate(text, 1000)),
              })
              sessionSet(sid, { buffer: JSON.stringify(buf) })
            }
            messageTexts.delete(msgId)
            break
          }
          case "message.part.updated": {
            const part = props.part || {}
            const msgId = part.messageID
            if (!msgId || part.type !== "text") break
            const text = part.text || ""
            if (text && !messageTexts.has(msgId)) messageTexts.set(msgId, text)
            break
          }

          case "message.part.delta": {
            const msgId = props.messageID
            const delta = props.delta || ""
            if (!msgId || !delta) break
            const existing = messageTexts.get(msgId) || ""
            messageTexts.set(msgId, existing + delta)
            break
          }

          case "session.idle": {
            const sid = (props.sessionID as string) || (props.sessionId as string) || ""
            if (!sid) break
            // Never housekeep/auto-distill our own review sub-sessions.
            if (isReviewSession(sid)) {
              reviewSessionIDs.delete(sid)
              break
            }
            const nowMs = Date.now()
            // housekeeping: decay stale memories periodically
            try {
              if (nowMs - lastMaintenance >= maintenanceInterval()) {
                memoryDecay()
                lastMaintenance = nowMs
              }
            } catch {}
            // housekeeping: dedupe workspaces + prune checkpoints + expire unused skills (90d)
            try {
              if (nowMs - lastMaintenance >= maintenanceInterval()) {
                mergeDuplicateWorkspaces()
                maintainCheckpoints()
                try {
                  const { curatorRun } = require("./selfforge/lib/review")
                  curatorRun()
                } catch {}
                lastMaintenance = nowMs
              }
            } catch {}
            // infrequent DB compaction
            try {
              if (nowMs - lastVacuum >= vacuumInterval()) {
                vacuumDb()
                lastVacuum = nowMs
              }
            } catch {}
            if (
              sessionReviewOnIdle() &&
              nowMs - lastIdleReview >= idleCooldown()
            ) {
              const s = getSession(sid)
              let buf: Array<{ role: string; content: string }> = []
              try {
                buf = JSON.parse(s.buffer || "[]")
              } catch {}
              if (buf.length > 2) {
                lastIdleReview = nowMs
                maybeSpawnReview(sid, "idle")
              }
            }
            // Feature 1: auto-distill — if the session has buffered messages but
            // no distilled summary yet, build one on idle so the dashboard's
            // daily summary shows content even without a manual session_summary call.
            try {
              const st = getSessionSummary(sid)
              if (st && !st.summary && st.fact_count === 0) {
                const s = getSession(sid)
                let buf: Array<{ role: string; content: string }> = []
                try {
                  buf = JSON.parse(s.buffer || "[]")
                } catch {}
                if (buf.length > 0) {
                  summarizeSession(sid, buf, s.turn_count)
                  logObs("session_summary_auto", { session: sid, facts: getSessionSummary(sid)?.fact_count ?? 0 }, s.project || projectName())
                  // Fuse distilled session state into memory.context.md for next instructions load.
                  scheduleContextRefresh({
                    wsScope: wsScope ?? undefined,
                    includeSession: sid,
                    immediate: true,
                  })
                }
              } else if (st?.summary) {
                // Keep session state attached even when summary already existed.
                scheduleContextRefresh({
                  wsScope: wsScope ?? undefined,
                  includeSession: sid,
                })
              }
            } catch {}
            break
          }
        }
      } catch (err) {
        console.error("[evolve] event error:", (err as Error).message)
      }
    },

    "tool.execute.after": async (input: any) => {
      try {
        // Log every tool call
        if (input.tool) {
          const detail = input.args ? JSON.stringify(input.args).slice(0, 200) : ""
          recordCall("tool", String(input.tool), detail)
        }
        if (input.tool === "skill" && input.args?.name) {
          recordSkillUse(String(input.args.name))
        }
        // decision-repair signal tap: every non-skill tool call is a step-level
        // success/failure signal (gated; feeds the burst detector)
        if (input.tool && input.tool !== "skill" && getConfig("signals_auto", "true") !== "false") {
          const err = input.error || input.output?.isError || (input.output && typeof input.output === "object" && (input.output as any).error)
          if (err) {
            const code =
              typeof err === "string" ? err.slice(0, 80) : (err as any)?.name || (err as any)?.code || (err as any)?.message || "error"
            recordSignal("failure", String(input.tool), projectName(), typeof code === "string" ? code.slice(0, 80) : "error")
          } else {
            recordSignal("success", String(input.tool), projectName())
          }
        }
      } catch {}
    },

    "experimental.chat.system.transform": async (input: any, output: { system: string[] }) => {
      try {
        const advisories: string[] = []
        // Live reuse: session state + confirmed memories written since last file compose.
        // Covers the gap where opencode caches instructions for the open session.
        try {
          const live = liveMemoryInjection({
            sessionID: input?.sessionID ? String(input.sessionID) : undefined,
            wsScope: wsScope ?? undefined,
          })
          if (live) advisories.push(live)
        } catch {}
        const ga = goalAdvisory()
        if (ga) advisories.push(`## Active Goals\n${ga}`)
        const ea = evolutionAdvisory()
        if (ea) advisories.push(`## Evolution Candidates\n${ea}`)
        if (advisories.length > 0) {
          output.system.push(
            `\n\n<!-- selfforge advisory -->\n${advisories.join("\n\n")}\n\nThese are auto-generated signals. Context they describe is authoritative for this session's prior decisions; act on evolution candidates only when relevant. Most sessions need no action.`
          )
        }
      } catch {}
    },

    "experimental.session.compacting": async (input: any, output: { context: string[]; prompt?: string }) => {
      try {
        const live = liveMemoryInjection({
          sessionID: input?.sessionID ? String(input.sessionID) : undefined,
          wsScope: wsScope ?? undefined,
          limit: 12,
        })
        if (live) output.context.push(live)
        else {
          // Fallback: push the on-disk snapshot so compaction still sees durable lessons.
          try {
            const { readFileSync } = require("node:fs")
            const { CONTEXT_FILE } = require("./selfforge/lib/memory")
            const md = readFileSync(CONTEXT_FILE, "utf8")
            if (md && md.length > 80) {
              output.context.push(
                `<!-- selfforge memory.context.md -->\n${md.slice(0, 6000)}${md.length > 6000 ? "\n…" : ""}`
              )
            }
          } catch {}
        }
      } catch {}
    },

    dispose: async () => {
      try {
        closeDb()
      } catch {}
      try {
        closeServer()
      } catch {}
    },
  }

  const tools = {
    ...memoryTools,
    ...userTools,
    ...skillTools,
    ...ruleTools,
    ...goalTools,
    ...evolutionTools,
    ...curatorTools,
    ...repairTools,
    ...patternTools,
    ...workspaceTools,
    ...summaryTools,
    ...evalTools,
    ...transferTools,
    ...teamTools,
    ...dashboardTools,
  }

  return { ...hooks, tool: tools }
}

export default Selfforge
