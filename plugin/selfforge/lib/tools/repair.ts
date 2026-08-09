import { tool } from "@opencode-ai/plugin"
import { classifyFeedback, runRepair, repairList, repairAccept, repairReject, repairStatus, recordSignal } from "../repair"
import { logObs } from "../db"

export const repairTools = {
  repair_run: tool({
    description:
      "Run a decision repair. failure-burst: detects a tool failing N times in a row (no success in window) and drafts an anti-pattern. user.negative / user.preference: user free-text is ground truth (no burst needed). manual: force a repair for a tool/context. Deterministic, no LLM.",
    args: {
      trigger: tool.schema.enum(["failure-burst", "user.negative", "user.preference", "manual"]).describe("Repair trigger"),
      tool: tool.schema.string().optional().describe("Tool id, e.g. shell or pip.install"),
      context: tool.schema.string().optional().describe("Context (e.g. project or command)"),
      errCode: tool.schema.string().optional().describe("Error code/name, e.g. NETWORK_REFUSED"),
      userText: tool.schema.string().optional().describe("User feedback text (for user.* triggers)"),
    },
    async execute(args, ctx) {
      const res = runRepair({
        trigger: args.trigger,
        tool: args.tool,
        context: args.context ?? ctx.directory,
        errCode: args.errCode,
        userText: args.userText,
      })
      logObs("repair_run", res, ctx.directory)
      return { output: JSON.stringify(res, null, 2) }
    },
  }),

  repair_signal: tool({
    description:
      "Record a tool success/failure signal (feeds the decision-repair burst detector). Call recordSignal with kind failure when a tool errors out.",
    args: {
      kind: tool.schema.enum(["success", "failure"]).describe("Outcome of the tool call"),
      tool: tool.schema.string().describe("Tool id, e.g. shell"),
      context: tool.schema.string().optional().describe("Context (e.g. project or command)"),
      errCode: tool.schema.string().optional().describe("Error code, e.g. EXIT_CODE_1"),
    },
    async execute(args, ctx) {
      const res = recordSignal(args.kind, args.tool, args.context ?? ctx.directory, args.errCode)
      logObs("repair_signal", { ...args, burst: res.burst }, ctx.directory)
      return { output: JSON.stringify(res) }
    },
  }),

  feedback_classify: tool({
    description:
      "Deterministically classify free-text user feedback into a shape (positive/negative/preference/instruction/unknown) with extracted prefer/avoid fragments. No LLM.",
    args: { text: tool.schema.string().describe("User feedback text") },
    async execute(args, ctx) {
      const res = classifyFeedback(args.text)
      logObs("feedback_classify", res, ctx.directory)
      return { output: JSON.stringify(res, null, 2) }
    },
  }),

  repair_status: tool({
    description: "Show decision-repair status: counts by status/trigger and pending drafts.",
    args: {},
    async execute() {
      return { output: JSON.stringify(repairStatus(), null, 2) }
    },
  }),

  repair_list: tool({
    description: "List repair drafts (optionally filtered by status).",
    args: {
      status: tool.schema.enum(["draft", "accepted", "rejected"]).optional().describe("Filter by status"),
    },
    async execute(args) {
      const rows = repairList({ status: args.status })
      if (rows.length === 0) return { output: "No repairs." }
      return {
        output: rows
          .map((r) => `#${r.id} [${r.trigger}/${r.kind}/${r.status}] ${r.scope ?? ""}: ${r.draft}`)
          .join("\n"),
      }
    },
  }),

  repair_accept: tool({
    description: "Accept a repair draft, promoting its guidance for later escalation.",
    args: { id: tool.schema.number().describe("Repair id") },
    async execute(args, ctx) {
      const res = repairAccept(args.id)
      logObs("repair_accept", res, ctx.directory)
      return { output: JSON.stringify(res, null, 2) }
    },
  }),

  repair_reject: tool({
    description: "Reject (and tombstone) a repair draft.",
    args: { id: tool.schema.number().describe("Repair id") },
    async execute(args, ctx) {
      const res = repairReject(args.id)
      logObs("repair_reject", res, ctx.directory)
      return { output: JSON.stringify(res, null, 2) }
    },
  }),
}
