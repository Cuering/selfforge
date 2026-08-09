import { tool } from "@opencode-ai/plugin"
import { userAdd, userList, userRemove } from "../user"

export const userTools = {
  user_add: tool({
    description: "Record a communication/workflow preference for the user profile.",
    args: {
      keyword: tool.schema.string().describe("Short unique keyword"),
      content: tool.schema.string().describe("Preference description"),
    },
    async execute(args) {
      const res = userAdd(args.keyword, args.content)
      return { output: JSON.stringify(res) }
    },
  }),

  user_list: tool({
    description: "List user profile preferences.",
    args: {},
    async execute() {
      return { output: JSON.stringify(userList(), null, 2) }
    },
  }),

  user_remove: tool({
    description: "Remove a user profile preference by keyword.",
    args: { keyword: tool.schema.string() },
    async execute(args) {
      const res = userRemove(args.keyword)
      return { output: JSON.stringify(res) }
    },
  }),
}