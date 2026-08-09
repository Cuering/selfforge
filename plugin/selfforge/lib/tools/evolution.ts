import { tool } from "@opencode-ai/plugin"
import { evolutionPropose, evolutionApply, evolutionReject, evolutionStatus } from "../evolution"

export const evolutionTools = {
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
}