import { tool } from "@opencode-ai/plugin"
import {
  memoryAddDedup,
  memoryList,
  memoryStrengthen,
  memoryWeaken,
  memoryRemove,
  memorySummary,
  memoryBrief,
  memoryRecall,
  memoryCandidates,
  memoryConfirm,
  memoryReject,
  isBlockedMemoryContent,
  recallFeedback,
  MEMORY_TYPES,
} from "../memory"
import { logObs } from "../db"
import { evolutionCriteria } from "../evolution"

export const memoryTools = {
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
      if ((res as { gated?: boolean }).gated) {
        return { output: `Memory not recorded: ${(res as { reason: string }).reason}` }
      }
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
      "Surgically recall the most relevant confirmed memories for a query topic (keyword-scored + evidence-weighted). Use instead of dumping all memories. For short queries, also surfaces recent evolution criteria as authoritative behavior guidance.",
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

  memory_feedback: tool({
    description:
      "Give explicit useful/not-useful feedback about a recalled memory. Feeds the feature-3 evidence loop: word-level precision weights shift so future recalls of the same topic rank better.",
    args: {
      memory_id: tool.schema.number().describe("Memory id that was recalled"),
      useful: tool.schema.boolean().describe("true = this memory was helpful; false = it was not relevant/helpful"),
    },
    async execute(args, ctx) {
      const res = recallFeedback(args.memory_id, args.useful)
      logObs("memory_feedback", { memory_id: args.memory_id, useful: args.useful, result: res }, ctx.directory)
      return { output: res.message }
    },
  }),
}