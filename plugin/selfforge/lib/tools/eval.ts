import { tool } from "@opencode-ai/plugin"
import { runRecallEval } from "../eval"
import { logObs } from "../db"

export const evalTools = {
  memory_eval: tool({
    description:
      "Run the recall benchmark: seed a known fixture set, measure how often keyword+evidence recall returns the expected memory. Reports precision@k and per-case hits — a regression check for recall quality.",
    args: { k: tool.schema.number().optional().describe("Recall depth (default 3)") },
    async execute(args, ctx) {
      const res = runRecallEval({ k: args.k })
      logObs("memory_eval", { precision: res.precision, hits: res.hits, total: res.total }, ctx.directory)
      return { output: JSON.stringify(res, null, 2) }
    },
  }),
}
