import { tool } from "@opencode-ai/plugin"
import { join } from "path"
import { homedir } from "os"
import {
  skillCreate,
  skillPatch,
  skillArchive,
  skillList,
  skillUsage,
  skillStatus,
  skillFeedback,
  skillEnable,
  skillDisable,
  skillUninstall,
  skillInstallFromDir,
  skillInfo,
  adoptOpencodeSkills,
} from "../skills"
import { verifySkillDraft } from "../verify"
import { logObs } from "../db"

const OPENCODE_SKILL_DIRS = () => [
  join(homedir(), ".config", "opencode", "skills"),
  join(homedir(), ".agents", "skills"),
]

export const skillTools = {
  skill_create: tool({
    description:
      "创建可复用技能。名称会 slug 化；description 请用中文写清能完成的任务。若未提供 body，自动生成含目标/步骤/硬性规则/验收标准的完整中文执行模板。会跑确定性反幻觉校验（工具覆盖+证据共鸣）。",
    args: {
      name: tool.schema.string().describe("技能名（英文或中文，存盘为 slug）"),
      description: tool.schema.string().describe("中文说明：何时用、能完成什么任务"),
      body: tool.schema.string().optional().describe("可选 SKILL.md 正文；空则用完整执行规则模板"),
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

  skill_enable: tool({
    description:
      "Start/enable a skill: moves its SKILL.md back into the opencode-loading skills dir (SKILLS_DIR) and restores a non-disabled status. Inverse of skill_disable.",
    args: {
      name: tool.schema.string().describe("Skill name"),
    },
    async execute(args, ctx) {
      const res = skillEnable(args.name)
      logObs("skill_enable", res, ctx.directory)
      return { output: JSON.stringify(res, null, 2) }
    },
  }),

  skill_disable: tool({
    description:
      "Stop/disable a skill: moves its SKILL.md out of the opencode-loading skills dir into ~/.evolve/skills-disabled so opencode stops loading it, and marks status=disabled. Does not delete anything.",
    args: {
      name: tool.schema.string().describe("Skill name"),
    },
    async execute(args, ctx) {
      const res = skillDisable(args.name)
      logObs("skill_disable", res, ctx.directory)
      return { output: JSON.stringify(res, null, 2) }
    },
  }),

  skill_info: tool({
    description:
      "Show a skill's details: description, status, eta, usage, trials, current on-disk location and whether opencode loads it. Use to explain what a skill does.",
    args: {
      name: tool.schema.string().describe("Skill name"),
    },
    async execute(args) {
      return { output: JSON.stringify(skillInfo(args.name), null, 2) }
    },
  }),

  skill_install: tool({
    description:
      "Install a skill from a filesystem directory: scans the directory (and subdirs) for SKILL.md files, copies them into the selfforge-managed skills dir, and registers them in the skill table. Re-running updates existing skills. Returns installed/skipped names.",
    args: {
      dir: tool.schema.string().describe("Directory to scan for SKILL.md files (absolute or ~ path)"),
    },
    async execute(args, ctx) {
      const res = skillInstallFromDir(args.dir.replace(/^~[\\/]/, homedir() + "/"))
      logObs("skill_install", { dir: args.dir, ...res }, ctx.directory)
      return { output: JSON.stringify(res, null, 2) }
    },
  }),

  skill_adopt: tool({
    description:
      "Adopt opencode's own skill directories (~/.config/opencode/skills and ~/.agents/skills) into selfforge management. MOVE semantics: every skill folder is MOVED into the selfforge-managed skills dir (~/.evolve/skills, loaded by opencode via skills.paths) and registered. The original folder is removed, so selfforge becomes the single owner. Use once to bring existing skills under selfforge control.",
    args: {},
    async execute(args, ctx) {
      const res = adoptOpencodeSkills([join(homedir(), ".config", "opencode", "skills"), join(homedir(), ".agents", "skills")])
      logObs("skill_adopt", res, ctx.directory)
      return { output: JSON.stringify(res, null, 2) }
    },
  }),

  skill_uninstall: tool({
    description:
      "Uninstall a skill completely: deletes its DB row and removes its folder from both the live and disabled skills dirs. Irreversible. Unlike skill_archive (soft) or skill_disable (stop), this removes the skill entirely.",
    args: {
      name: tool.schema.string().describe("Skill name"),
    },
    async execute(args, ctx) {
      const res = skillUninstall(args.name)
      logObs("skill_uninstall", res, ctx.directory)
      return { output: JSON.stringify(res, null, 2) }
    },
  }),
}