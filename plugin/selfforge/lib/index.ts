/**
 * selfforge engine — zero-dependency core.
 * Importable outside the OpenCode plugin (CLI, JSON-RPC server, other agents).
 * The OpenCode adapter (`plugin/selfforge.ts` + `lib/tools/*`) sits on top.
 */
export * from "./db"
export * from "./memory"
export * from "./skills"
export * from "./rules"
export * from "./goals"
export * from "./evolution"
export * from "./user"
export * from "./repair"
export * from "./verify"
