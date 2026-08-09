import { tool } from "@opencode-ai/plugin"
import { patternCandidates, patternStatus, recordPattern, inducePatterns, prunePatterns, signatureLabel, signatureHash } from "../patterns"
import { logObs } from "../db"

export const patternTools = {
  pattern_status: tool({
    description:
      "Show pattern-signature candidate pool status: total signatures, quorum threshold, and buckets ready for induction (recurring across >= N episodes).",
    args: {},
    async execute() {
      return { output: JSON.stringify(patternStatus(), null, 2) }
    },
  }),

  pattern_record: tool({
    description:
      "Manually record a pattern recurrence. Use when you notice the same failure mode recurring (tool + error code). Distinct episodes accumulate toward induction.",
    args: {
      tool: tool.schema.string().describe("Tool id, e.g. shell"),
      errCode: tool.schema.string().optional().describe("Error code, e.g. EXIT_CODE_1"),
      context: tool.schema.string().optional().describe("Context, e.g. project"),
      episodeKey: tool.schema.string().optional().describe("Episode id; use a session id or date"),
    },
    async execute(args, ctx) {
      const res = recordPattern(args.tool, args.errCode, args.context ?? ctx.directory, args.episodeKey)
      logObs("pattern_record", res, ctx.directory)
      return { output: JSON.stringify(res, null, 2) }
    },
  }),

  pattern_induce: tool({
    description:
      "Induce mature pattern buckets (recurring across >= N distinct episodes) into the memory store as candidate memories. Zero-LLM distillation of recurring failure modes. Dedup-aware: near-duplicate existing memories are merged, not duplicated.",
    args: {},
    async execute(args, ctx) {
      const res = inducePatterns()
      logObs("pattern_induce", res, ctx.directory)
      return { output: JSON.stringify(res, null, 2) }
    },
  }),

  pattern_signature: tool({
    description:
      "Compute the deterministic pattern signature for a (tool, errCode, context) fingerprint and its 16-hex bucket hash.",
    args: {
      tool: tool.schema.string().describe("Tool id"),
      errCode: tool.schema.string().optional(),
      context: tool.schema.string().optional(),
    },
    async execute(args) {
      const label = signatureLabel(args.tool, args.errCode, args.context)
      return { output: JSON.stringify({ sig_label: label, sig_hash: signatureHash(label) }) }
    },
  }),
}