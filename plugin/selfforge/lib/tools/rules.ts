import { tool } from "@opencode-ai/plugin"
import { ruleObserve, ruleStatus, escalate } from "../rules"
import { logObs } from "../db"

export const ruleTools = {
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
}