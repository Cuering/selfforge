import { tool } from "@opencode-ai/plugin"
import { skillCreate, skillPatch, skillArchive, skillList, skillUsage, skillStatus, skillFeedback } from "../skills"
import { verifySkillDraft } from "../verify"
import { logObs } from "../db"

export const skillTools = {
  skill_create: tool({
    description:
      "Create a new skill from distilled knowledge. Name is auto-slugified. Body appended if empty. Runs deterministic anti-hallucination verification (tool coverage + evidence resonance) and returns the verdict as advisory info.",
    args: {
      name: tool.schema.string(),
      description: tool.schema.string(),
      body: tool.schema.string().optional().describe("Optional SKILL.md body"),
    },
    async execute(args, ctx) {
      const res = skillCreate(args.name, args.description, args.body)
      const verify = verifySkillDraft({
        name: res.name ?? args.name,
        description: args.description,
        body: args.body ?? "",
      })
      logObs("skill_create", { ...res, verify }, ctx.directory)
      return { output: JSON.stringify({ ...res, verify }, null, 2) }
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
    description: "Show skill usage telemetry (uses, failures, trial lifecycle: eta/status).",
    args: {},
    async execute() {
      return { output: JSON.stringify(skillUsage(), null, 2) }
    },
  }),

  skill_status: tool({
    description:
      "Show skill lifecycle status: counts by status, candidate trial cohort, and how many skills are eligible for retrieval (eta >= minEtaForRetrieval).",
    args: {},
    async execute() {
      return { output: JSON.stringify(skillStatus(), null, 2) }
    },
  }),

  skill_feedback: tool({
    description:
      "Give thumbs feedback on a skill. positive=true raises its reliability eta (used to graduate/rehab); positive=false lowers it (drives toward archive). Applies eta ± 0.1 with rehab/retire transitions.",
    args: {
      name: tool.schema.string().describe("Skill name"),
      positive: tool.schema.boolean().describe("true = good skill, keep promoting; false = bad, push toward archive"),
    },
    async execute(args, ctx) {
      const res = skillFeedback(args.name, args.positive)
      logObs("skill_feedback", res, ctx.directory)
      return { output: JSON.stringify(res) }
    },
  }),

  skill_verify: tool({
    description:
      "Deterministic anti-hallucination check on a skill body before you create/patch it: (1) tool coverage — every command/tool named must appear in real evidence (signals + session history); (2) evidence resonance — the body must share >=2 tokens with recent session messages. Returns coverage/resonance scores and unmapped tool names.",
    args: {
      name: tool.schema.string().describe("Proposed skill name"),
      description: tool.schema.string().optional().describe("Proposed description"),
      body: tool.schema.string().describe("Proposed SKILL.md body"),
    },
    async execute(args, ctx) {
      const res = verifySkillDraft({ name: args.name, description: args.description, body: args.body })
      logObs("skill_verify", res, ctx.directory)
      return { output: JSON.stringify(res, null, 2) }
    },
  }),
}