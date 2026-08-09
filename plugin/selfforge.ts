import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { initDb, setConfig, getConfig, now, logObs, closeDb, vacuumDb } from "./selfforge/lib/db"
import { memoryAdd, memoryAddDedup, memoryList, memoryStrengthen, memoryWeaken, memoryRemove, memorySummary, memoryBrief, memoryRecall, memoryDecay, memoryCandidates, memoryConfirm, memoryReject, isBlockedMemoryContent, MEMORY_TYPES, composeMemoryContext } from "./selfforge/lib/memory"
import { userAdd, userList, userRemove } from "./selfforge/lib/user"
import { skillCreate, skillPatch, skillArchive, skillList, skillUsage, syncSkillsToDisk, recordSkillUse } from "./selfforge/lib/skills"
import { ruleObserve, ruleStatus, ruleDue, escalate, ruleHistory } from "./selfforge/lib/rules"
import { goalStart, goalStatus, goalCheckpoint, goalComplete, goalStop, goalAdvisory } from "./selfforge/lib/goals"
import { evolutionPropose, evolutionList, evolutionStatus, evolutionApply, evolutionReject, evolutionAdvisory, evolutionCriteria, pickEvolutionCandidate } from "./selfforge/lib/evolution"
import { redact, truncate, spawnReview, getSession, sessionSet, bufferPush, isTrivial, sessionSearch, curatorRun, curatorStatus } from "./selfforge/lib/review"

export const Selfforge: Plugin = async ({ client, directory, worktree }) => {
  const db = initDb()
  syncSkillsToDisk()

  const projectName = () =>
    (directory || worktree || process.cwd()).split(/[\\/]/).pop() || "unknown"

  composeMemoryContext()
  logObs("plugin_loaded", { version: "1.0.0" }, projectName())
  try {
    memoryDecay()
  } catch {}

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
    const res = spawnReview(captured, s.project || projectName(), reviewCmd())
    sessionSet(sessionId, { buffer: "[]", last_review_turn: s.turn_count })
    logObs("review_triggered", { reason, result: res }, s.project || projectName())
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
            messageRoles.set(msgId, role)
            const text = messageTexts.get(msgId) || ""
if (text && role === "assistant") {
              const sid = (info.sessionID as string) || (info.sessionId as string) || ""
              if (!sid) break
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
              const sid = (info.sessionID as string) || (info.sessionId as string) || ""
              if (!sid) break
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
            const nowMs = Date.now()
            // housekeeping: decay stale memories periodically
            try {
              if (nowMs - lastMaintenance >= maintenanceInterval()) {
                memoryDecay()
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
            break
          }
        }
      } catch (err) {
        console.error("[evolve] event error:", (err as Error).message)
      }
    },

    "tool.execute.after": async (input: any) => {
      try {
        if (input.tool === "skill" && input.args?.name) {
          recordSkillUse(String(input.args.name))
        }
      } catch {}
    },

"experimental.chat.system.transform": async (input: any, output: { system: string[] }) => {
      try {
        const advisories: string[] = []
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

    dispose: async () => {
      try {
        closeDb()
      } catch {}
    },
  }

  const tools = {
    memory_add: tool({
      description:
        "Record a persistent memory/lesson (correction, preference, or general rule). Use for durable facts about how the user works, not one-off details. Explicit user statements (\"remember this\") should be confirmed; auto-inferred lessons should be candidates for human review.",
      args: {
        content: tool.schema.string().describe("The memory content to record"),
        source: tool.schema.string().optional().describe("Origin: review, manual, migration"),
        type: tool.schema
          .enum(MEMORY_TYPES as unknown as [string, ...string[]])
          .optional()
          .describe("Memory category: preference/insight/instruction/fact/decision/episodic"),
        importance: tool.schema
          .number()
          .optional()
          .describe("Importance 1-10 (default 5). Higher decays slower."),
        scope: tool.schema
          .string()
          .optional()
          .describe("Path glob scope, e.g. services/payment/** (keeps lessons from leaking across modules)"),
        status: tool.schema
          .enum(["confirmed", "candidate"])
          .optional()
          .describe("confirmed = user-endorsed (default); candidate = auto-inferred, awaiting review"),
        confidence: tool.schema
          .number()
          .optional()
          .describe("Confidence 1-10 (default 8 confirmed / 4 candidate)"),
        expires_at: tool.schema
          .string()
          .optional()
          .describe("ISO timestamp after which this memory is auto-archived (TTL for temporary facts)"),
      },
      async execute(args, ctx) {
        const blocked = isBlockedMemoryContent(args.content)
        if (blocked.blocked) {
          logObs("memory_add_blocked", { content: args.content.slice(0, 80), reason: blocked.reason }, ctx.directory)
          return { output: `Memory not recorded: ${blocked.reason}` }
        }
        const res = memoryAddDedup(args.content, {
          source: args.source,
          project: ctx.directory,
          type: args.type as never,
          importance: args.importance,
          scope: args.scope,
          status: args.status as "confirmed" | "candidate" | undefined,
          confidence: args.confidence,
          expires_at: args.expires_at,
        })
        logObs("memory_add", res, ctx.directory)
        const mergedNote = res.merged ? " (merged into existing memory)" : ""
        const statusNote = res.status === "candidate" ? " [candidate — confirm via memory_confirm]" : ""
        return {
          output: `Memory recorded (id ${res.id}, tier ${res.tier}, type ${res.type ?? "fact"}, status ${res.status ?? "confirmed"})${statusNote}${mergedNote}.`,
        }
      },
    }),

    memory_list: tool({
      description: "List persistent memories, optionally filtered by tier/status (hot/warm/cold/evictable; confirmed/candidate).",
      args: {
        tier: tool.schema.string().optional().describe("Filter by tier"),
        status: tool.schema.string().optional().describe("Filter by status (confirmed/candidate)"),
        limit: tool.schema.number().optional().describe("Max entries (default 50)"),
      },
      async execute(args) {
        const rows = memoryList({ tier: args.tier, status: args.status, limit: args.limit })
        if (rows.length === 0) return { output: "No memories found." }
        return {
          output: rows
            .map((m) => `[${m.id}] (${m.tier}/${m.strength} ${m.type} ${m.lifecycle} ${m.status}${m.scope ? ` scope:${m.scope}` : ""}) ${m.content}`)
            .join("\n"),
        }
      },
    }),

    memory_strengthen: tool({
      description: "Reinforce memories matching a keyword (increases strength/tier).",
      args: { keyword: tool.schema.string() },
      async execute(args) {
        const res = memoryStrengthen(args.keyword)
        return { output: JSON.stringify(res) }
      },
    }),

    memory_weaken: tool({
      description: "Weaken memories matching a keyword (decreases strength/tier).",
      args: { keyword: tool.schema.string() },
      async execute(args) {
        const res = memoryWeaken(args.keyword)
        return { output: JSON.stringify(res) }
      },
    }),

    memory_remove: tool({
      description: "Archive memories matching a keyword.",
      args: { keyword: tool.schema.string() },
      async execute(args) {
        const res = memoryRemove(args.keyword)
        return { output: JSON.stringify(res) }
      },
    }),

    memory_status: tool({
      description: "Show memory tier distribution and composed context preview.",
      args: {},
      async execute() {
        const summary = memorySummary()
        return { output: JSON.stringify(summary) }
      },
    }),

    memory_brief: tool({
      description:
        "Daily memory brief and health: active/archived counts, today's additions, type & lifecycle distribution, health suggestions.",
      args: {},
      async execute() {
        return { output: JSON.stringify(memoryBrief(), null, 2) }
      },
    }),

    memory_candidates: tool({
      description:
        "List unconfirmed candidate memories (auto-inferred lessons awaiting human review). Confirm or reject them with memory_confirm / memory_reject.",
      args: { limit: tool.schema.number().optional().describe("Max entries (default 20)") },
      async execute(args) {
        const rows = memoryCandidates(args.limit)
        if (rows.length === 0) return { output: "No candidate memories awaiting review." }
        return {
          output: rows
            .map((m) => `[${m.id}] (conf ${m.confidence}) ${m.content}`)
            .join("\n"),
        }
      },
    }),

    memory_confirm: tool({
      description: "Promote a candidate memory to confirmed (marks it verified and recallable).",
      args: { id: tool.schema.number().describe("Memory id from memory_candidates") },
      async execute(args) {
        const res = memoryConfirm(args.id)
        return { output: res.message }
      },
    }),

    memory_reject: tool({
      description: "Reject a candidate memory (archives it, no longer recallable).",
      args: { id: tool.schema.number().describe("Memory id from memory_candidates") },
      async execute(args) {
        const res = memoryReject(args.id)
        return { output: res.message }
      },
    }),

    memory_search: tool({
      description:
        "Surgically recall the most relevant confirmed memories for a query topic (keyword-scored). Use instead of dumping all memories. For short queries, also surfaces recent evolution criteria as authoritative behavior guidance.",
      args: {
        query: tool.schema.string().describe("Topic/keywords to recall against"),
        limit: tool.schema.number().optional().describe("Max matches (default 5)"),
        scope: tool.schema.string().optional().describe("Optional path glob to restrict recall, e.g. services/payment/**"),
      },
      async execute(args, ctx) {
        const rows = memoryRecall(args.query, { limit: args.limit, scope: args.scope })
        const lines = rows.map((m) => `[${m.id}] (${m.tier}/${m.strength} ${m.type}) ${m.content}`)
        // short query: inject recent evolution criteria (authoritative behavior guidance)
        let injected = 0
        if ((args.query || "").trim().length <= 15) {
          const crit = evolutionCriteria(3)
          if (crit.length > 0) {
            lines.push("")
            lines.push("[行为准则 - authoritative recent evolution criteria]")
            for (const c of crit) lines.push(`- (${c.date} ${c.strategy}) ${c.skill}`)
            injected = crit.length
          }
        }
        // memory trace: reconstructable write/recall/filter/inject decisions
        logObs(
          "memory_trace",
          {
            query: args.query,
            scope: args.scope,
            recalled: rows.map((m) => m.id),
            injected_criteria: injected,
            limit: args.limit,
          },
          ctx.directory
        )
        if (lines.length === 0) return { output: "No relevant memories found." }
        return { output: lines.join("\n") }
      },
    }),

    user_add: tool({
      description: "Record a communication/workflow preference for the user profile.",
      args: {
        keyword: tool.schema.string().describe("Short unique keyword"),
        content: tool.schema.string().describe("Preference description"),
      },
      async execute(args) {
        const res = userAdd(args.keyword, args.content)
        return { output: JSON.stringify(res) }
      },
    }),

    user_list: tool({
      description: "List user profile preferences.",
      args: {},
      async execute() {
        return { output: JSON.stringify(userList(), null, 2) }
      },
    }),

    user_remove: tool({
      description: "Remove a user profile preference by keyword.",
      args: { keyword: tool.schema.string() },
      async execute(args) {
        const res = userRemove(args.keyword)
        return { output: JSON.stringify(res) }
      },
    }),

    skill_create: tool({
      description:
        "Create a new skill from distilled knowledge. Name is auto-slugified. Body appended if empty.",
      args: {
        name: tool.schema.string(),
        description: tool.schema.string(),
        body: tool.schema.string().optional().describe("Optional SKILL.md body"),
      },
      async execute(args, ctx) {
        const res = skillCreate(args.name, args.description, args.body)
        logObs("skill_create", res, ctx.directory)
        return { output: JSON.stringify(res, null, 2) }
      },
    }),

    skill_patch: tool({
      description:
        "Patch a skill. section=description replaces frontmatter description; section=body replaces body; other sections append a new '## section' block.",
      args: {
        name: tool.schema.string(),
        section: tool.schema.string(),
        content: tool.schema.string(),
      },
      async execute(args, ctx) {
        const res = skillPatch(args.name, args.section, args.content)
        logObs("skill_patch", res, ctx.directory)
        return { output: JSON.stringify(res) }
      },
    }),

    skill_list: tool({
      description: "List all skills with usage counts.",
      args: {},
      async execute() {
        const rows = skillList()
        if (rows.length === 0) return { output: "No skills yet." }
        return {
          output: rows
            .map((s) => `- ${s.name} [${s.status}] use=${s.usage_count} fail=${s.fail_count}`)
            .join("\n"),
        }
      },
    }),

    skill_archive: tool({
      description: "Archive a skill (moved to .archive, marked archived).",
      args: { name: tool.schema.string() },
      async execute(args, ctx) {
        const res = skillArchive(args.name)
        logObs("skill_archive", res, ctx.directory)
        return { output: JSON.stringify(res) }
      },
    }),

    skill_usage: tool({
      description: "Show skill usage telemetry (uses, failures, last used).",
      args: {},
      async execute() {
        return { output: JSON.stringify(skillUsage(), null, 2) }
      },
    }),

    rule_observe: tool({
      description:
        "Record a behavioral rule (user correction/preference) for potential AGENTS.md escalation. Use explicitScope=global when user said 'always/everywhere'.",
      args: {
        rule: tool.schema.string().describe("The rule text"),
        domain: tool.schema.string().optional().describe("tooling|workflow|code-style|communication|architecture|testing|security|unknown"),
        explicitScope: tool.schema.enum(["global", "local"]).optional(),
      },
      async execute(args, ctx) {
        const res = ruleObserve({
          rule: args.rule,
          project: ctx.directory,
          domain: args.domain,
          explicitScope: args.explicitScope,
        })
        logObs("rule_observe", res, ctx.directory)
        return { output: JSON.stringify(res, null, 2) }
      },
    }),

    rule_status: tool({
      description: "Show all observed behavioral rules with counts and escalation recommendations.",
      args: {},
      async execute() {
        return { output: JSON.stringify(ruleStatus(), null, 2) }
      },
    }),

    rule_escalate: tool({
      description:
        "Escalate due behavioral rules into the appropriate AGENTS.md files. Use dryRun=true to preview.",
      args: { dryRun: tool.schema.boolean().optional().describe("Preview without writing") },
      async execute(args) {
        const res = escalate({ dryRun: args.dryRun ?? false })
        return { output: JSON.stringify(res, null, 2) }
      },
    }),

    goal_start: tool({
      description:
        "Start a goal-driven loop (PDCA with checkpoints). Sets up CP0-CP6.5 tracking.",
      args: {
        goal: tool.schema.string(),
        northStar: tool.schema.string().optional(),
        completionCriteria: tool.schema.string().optional(),
        maxIterations: tool.schema.number().optional(),
        level: tool.schema.number().optional().describe("Architecture level 0/1/2"),
      },
      async execute(args, ctx) {
        const res = goalStart({
          goal: args.goal,
          northStar: args.northStar,
          completionCriteria: args.completionCriteria,
          maxIterations: args.maxIterations,
          level: args.level,
          project: ctx.directory,
        })
        logObs("goal_start", res, ctx.directory)
        return { output: JSON.stringify(res, null, 2) }
      },
    }),

    goal_status: tool({
      description: "Show active goals and their checkpoint progress, or a specific goal.",
      args: { goalId: tool.schema.number().optional() },
      async execute(args) {
        return { output: JSON.stringify(goalStatus(args.goalId), null, 2) }
      },
    }),

    goal_checkpoint: tool({
      description:
        "Record a checkpoint (CP0..CP6.5) for a goal. Status: done/skipped/failed. CP3 increments iteration.",
      args: {
        goalId: tool.schema.number(),
        cp: tool.schema.string().describe("CP0, CP0.5, CP1, CP1.5, CP2, CP3, CP3.5, CP4, CP5, CP6, CP6.5"),
        status: tool.schema.enum(["done", "skipped", "failed"]).optional(),
        notes: tool.schema.string().optional(),
      },
      async execute(args) {
        const res = goalCheckpoint({ goalId: args.goalId, cp: args.cp, status: args.status, notes: args.notes })
        return { output: JSON.stringify(res, null, 2) }
      },
    }),

    goal_complete: tool({
      description: "Mark a goal as completed.",
      args: { goalId: tool.schema.number() },
      async execute(args) {
        return { output: JSON.stringify(goalComplete(args.goalId)) }
      },
    }),

    goal_stop: tool({
      description: "Stop a goal (status=stopped).",
      args: { goalId: tool.schema.number() },
      async execute(args) {
        return { output: JSON.stringify(goalStop(args.goalId)) }
      },
    }),

    evolution_status: tool({
      description: "Show evolution candidates (skills needing optimization) and pending evolution records.",
      args: {},
      async execute() {
        return { output: JSON.stringify(evolutionStatus(), null, 2) }
      },
    }),

    evolution_propose: tool({
      description:
        "Propose an evolution candidate for a skill (GEPA-style). Candidate becomes pending; apply requires human approval via evolution_apply.",
      args: {
        skill: tool.schema.string(),
        strategy: tool.schema.string().describe("e.g. harden, innovate, repair, generalize"),
        candidate: tool.schema.string().describe("New skill body or improvement content"),
        rationale: tool.schema.string().optional(),
      },
      async execute(args) {
        const res = evolutionPropose(args)
        return { output: JSON.stringify(res, null, 2) }
      },
    }),

    evolution_apply: tool({
      description: "Apply a pending evolution candidate to its skill (human-gated).",
      args: { id: tool.schema.number() },
      async execute(args) {
        const res = evolutionApply(args.id)
        return { output: JSON.stringify(res) }
      },
    }),

    evolution_reject: tool({
      description: "Reject a pending evolution candidate.",
      args: { id: tool.schema.number() },
      async execute(args) {
        const res = evolutionReject(args.id)
        return { output: JSON.stringify(res) }
      },
    }),

    curator_run: tool({
      description: "Run skill lifecycle curation: mark stale/archived skills based on last use.",
      args: {},
      async execute(args, ctx) {
        const res = curatorRun()
        logObs("curator_run", res, ctx.directory)
        return { output: JSON.stringify(res) }
      },
    }),

curator_status: tool({
      description: "Show curator status: skill counts by lifecycle status and last run time.",
      args: {},
      async execute() {
        return { output: JSON.stringify(curatorStatus(), null, 2) }
      },
    }),

    session_search: tool({
      description:
        "Full-text search across past conversation history (SQLite FTS5). Remembering decisions, solutions, or discussions from earlier sessions. Returns matching message snippets.",
      args: {
        query: tool.schema.string().describe("Search phrase"),
        limit: tool.schema.number().optional().describe("Max results (default 8)"),
      },
      async execute(args) {
        const hits = sessionSearch(args.query, { limit: args.limit })
        if (hits.length === 0) return { output: "No matching sessions found." }
        return {
          output: hits
            .map((h) => `[${h.session_id}] ${h.role} (${h.created_at}): ${h.content}`)
            .join("\n"),
        }
      },
    }),
  }

  return { ...hooks, tool: tools }
}

export default Selfforge

