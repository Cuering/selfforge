import { tool } from "@opencode-ai/plugin"
import { goalStart, goalStatus, goalCheckpoint, goalComplete, goalStop } from "../goals"
import { logObs } from "../db"

export const goalTools = {
  goal_start: tool({
    description:
      "Start a goal-driven loop (PDCA with checkpoints). Sets up CP0-CP6.5 tracking.",
    args: {
      goal: tool.schema.string(),
      northStar: tool.schema.string().optional(),
      completionCriteria: tool.schema.string().optional(),
      maxIterations: tool.schema.number().optional(),
      level: tool.schema.number().optional().describe("Architecture level 0/1/2"),
    },
    async execute(args, ctx) {
      const res = goalStart({
        goal: args.goal,
        northStar: args.northStar,
        completionCriteria: args.completionCriteria,
        maxIterations: args.maxIterations,
        level: args.level,
        project: ctx.directory,
      })
      logObs("goal_start", res, ctx.directory)
      return { output: JSON.stringify(res, null, 2) }
    },
  }),

  goal_status: tool({
    description: "Show active goals and their checkpoint progress, or a specific goal.",
    args: { goalId: tool.schema.number().optional() },
    async execute(args) {
      return { output: JSON.stringify(goalStatus(args.goalId), null, 2) }
    },
  }),

  goal_checkpoint: tool({
    description:
      "Record a checkpoint (CP0..CP6.5) for a goal. Status: done/skipped/failed. CP3 increments iteration.",
    args: {
      goalId: tool.schema.number(),
      cp: tool.schema.string().describe("CP0, CP0.5, CP1, CP1.5, CP2, CP3, CP3.5, CP4, CP5, CP6, CP6.5"),
      status: tool.schema.enum(["done", "skipped", "failed"]).optional(),
      notes: tool.schema.string().optional(),
    },
    async execute(args) {
      const res = goalCheckpoint({ goalId: args.goalId, cp: args.cp, status: args.status, notes: args.notes })
      return { output: JSON.stringify(res, null, 2) }
    },
  }),

  goal_complete: tool({
    description: "Mark a goal as completed.",
    args: { goalId: tool.schema.number() },
    async execute(args) {
      return { output: JSON.stringify(goalComplete(args.goalId)) }
    },
  }),

  goal_stop: tool({
    description: "Stop a goal (status=stopped).",
    args: { goalId: tool.schema.number() },
    async execute(args) {
      return { output: JSON.stringify(goalStop(args.goalId)) }
    },
  }),
}