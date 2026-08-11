import { tool } from "@opencode-ai/plugin"
import { dashboardText, serve, closeServer } from "../rpc"
import { exec } from "node:child_process"

function openBrowser(url: string) {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`
  exec(cmd, (err) => {
    if (err) throw err
  })
}

export const dashboardTools = {
  selfforge_status: tool({
    description:
      "Show a plain-text overview of the selfforge engine: counts, recent memories, skills, goals, pending repairs and mature patterns. No network or process spawned; reads the local SQLite store directly. Use when the user asks about selfforge status, memory, skills, goals or evolution state.",
    args: {},
    async execute() {
      return { output: dashboardText() }
    },
  }),

  selfforge_dashboard: tool({
    description:
      "Ensure the selfforge web dashboard server is running on localhost, then optionally open it in the default browser. Returns the dashboard URL. Use when the user wants the visual dashboard or a browser view of the memory store.",
    args: {
      open: tool.schema.boolean().optional().describe("Open the dashboard in the default browser (default true)"),
    },
    async execute(args) {
      const port = await serve(9210)
      const url = `http://127.0.0.1:${port}/`
      if (args.open !== false) openBrowser(url)
      return { output: JSON.stringify({ ok: true, url, note: "run /selfforge for a terminal overview" }, null, 2) }
    },
  }),

  selfforge_dashboard_stop: tool({
    description: "Stop the selfforge dashboard server if running (idempotent).",
    args: {},
    async execute() {
      closeServer()
      return { output: JSON.stringify({ ok: true }) }
    },
  }),
}