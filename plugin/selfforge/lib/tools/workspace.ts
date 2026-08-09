import { tool } from "@opencode-ai/plugin"
import { workspaceStatus, workspaceList, currentWorkspace, scopeFor, detectMarkers, fingerprintOf } from "../workspace"
import { logObs } from "../db"

export const workspaceTools = {
  workspace_status: tool({
    description:
      "Show work-environment awareness: known workspaces (last seen, visit count, detected stack markers, fingerprint scope) and how many memories are scoped to workspaces. Use before deciding where to store a memory.",
    args: {},
    async execute(args, ctx) {
      const res = workspaceStatus(ctx.directory)
      return { output: JSON.stringify(res, null, 2) }
    },
  }),

  workspace_scan: tool({
    description:
      "Fingerprint the current working directory: detect stack markers (node/python/go/rust/java/dotnet/docker/ci/make/cmake), compute the stable fingerprint and the ws: scope key used to scope memories.",
    args: {},
    async execute(args, ctx) {
      const dir = ctx.directory
      const markers = detectMarkers(dir)
      const fingerprint = fingerprintOf(dir, markers)
      const scope = scopeFor(dir, fingerprint)
      const ws = currentWorkspace(dir)
      logObs("workspace_scan", { markers, fingerprint, scope }, dir)
      return {
        output: JSON.stringify(
          {
            directory: dir,
            markers,
            fingerprint,
            scope,
            visits: ws.visits,
          },
          null,
          2
        ),
      }
    },
  }),

  workspace_list: tool({
    description: "List all previously seen workspaces ordered by most recent activity.",
    args: { limit: tool.schema.number().optional().describe("Max rows, default 20") },
    async execute(args) {
      return {
        output: JSON.stringify(
          workspaceList({ limit: args.limit }).map((w) => ({
            name: w.name,
            path: w.path,
            fingerprint: w.fingerprint,
            scope: w.scope,
            markers: w.markers ? JSON.parse(w.markers) : [],
            visits: w.visits,
            last_seen: w.last_seen,
          })),
          null,
          2
        ),
      }
    },
  }),
}
