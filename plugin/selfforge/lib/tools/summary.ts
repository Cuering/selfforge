import { tool } from "@opencode-ai/plugin"
import { getSessionSummary, summarizeSession, sessionSummaryList } from "../summary"
import { getSession } from "../review"
import { logObs } from "../db"

export const summaryTools = {
  session_summary: tool({
    description:
      "Show or refresh the compressed state digest of the current session (distilled user directives/decisions, not a transcript replay). Building it consumes the session buffer and stores a fixed-size summary.",
    args: {
      refresh: tool.schema.boolean().optional().describe("Re-distill from the current session buffer (default true)"),
    },
    async execute(args, ctx) {
      const sid = (ctx.sessionID as string) || (ctx as any).sessionId || ""
      if (!sid) return { output: "No session id available in this context." }
      const s = getSession(sid)
      let buf: Array<{ role: string; content: string }> = []
      try {
        buf = JSON.parse(s.buffer || "[]")
      } catch {}
      if (args.refresh !== false) {
        summarizeSession(sid, buf, s.turn_count)
      }
      const row = getSessionSummary(sid)
      logObs("session_summary", { session: sid, fact_count: row?.fact_count ?? 0, refreshed: args.refresh !== false }, ctx.directory)
      if (!row || !row.summary) return { output: "No session summary yet — nothing substantial to distill." }
      return { output: `## Session State\n\n${row.summary}\n\n(_${row.fact_count} distilled facts, covered through turn ${row.covered_until_turn}_)` }
    },
  }),

  session_summaries: tool({
    description: "List all stored session state digests (fixed-size compressed conversation states).",
    args: { limit: tool.schema.number().optional().describe("Max entries (default 20)") },
    async execute(args) {
      const rows = sessionSummaryList({ limit: args.limit })
      if (rows.length === 0) return { output: "No session summaries stored yet." }
      return {
        output: rows
          .map((r) => `[${r.session_id}] ${r.fact_count} facts, covered turn ${r.covered_until_turn}, ${r.updated_at}\n${r.summary}`)
          .join("\n\n"),
      }
    },
  }),
}
