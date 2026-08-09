import { tool } from "@opencode-ai/plugin"
import { curatorRun, curatorStatus, sessionSearch } from "../review"
import { logObs } from "../db"

export const curatorTools = {
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