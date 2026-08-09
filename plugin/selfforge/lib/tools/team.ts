import { tool } from "@opencode-ai/plugin"
import { teamSync, teamStatus, teamInit, isTeamRepo } from "../sync"
import { logObs } from "../db"

export const teamTools = {
  team_sync: tool({
    description:
      "Synchronize the local memory store with the team's shared git repo. Pulls the team snapshot, merges it into the local store (per-uuid last-write-wins; tombstones delete), re-exports the merged store and pushes it. Safe to run on any number of machines — they converge. Requires a configured team_repo (see team_status / team_init).",
    args: {
      repo: tool.schema.string().optional().describe("Override team repo path (defaults to config team_repo)"),
      remote: tool.schema.string().optional().describe("Git remote name (default origin)"),
      branch: tool.schema.string().optional().describe("Git branch (default main)"),
    },
    async execute(args, ctx) {
      const res = teamSync({ repo: args.repo, remote: args.remote, branch: args.branch })
      logObs("team_sync", res, ctx.directory)
      return { output: JSON.stringify(res, null, 2) }
    },
  }),

  team_status: tool({
    description: "Show team sync status: configured repo, whether it is a valid team repo, local node id, last sync time.",
    args: {},
    async execute() {
      return { output: JSON.stringify(teamStatus(), null, 2) }
    },
  }),

  team_init: tool({
    description:
      "Initialize a new team shared-memory repo: git init at the given path (if needed), write the initial snapshot, commit, optionally add a git remote, and set team_repo in config. Then run team_sync to share.",
    args: {
      repo: tool.schema.string().describe("Directory for the team repo (created if missing)"),
      remote: tool.schema.string().optional().describe("Optional git remote URL to add as origin"),
    },
    async execute(args, ctx) {
      const res = teamInit(args.repo, { remote: args.remote })
      logObs("team_init", res, ctx.directory)
      return { output: JSON.stringify(res, null, 2) }
    },
  }),

  team_ping: tool({
    description: "Check whether a directory is an existing team repo (has .git and snapshot.json).",
    args: { repo: tool.schema.string().describe("Directory to inspect") },
    async execute(args) {
      return { output: JSON.stringify({ repo: args.repo, is_team_repo: isTeamRepo(args.repo) }, null, 2) }
    },
  }),
}
