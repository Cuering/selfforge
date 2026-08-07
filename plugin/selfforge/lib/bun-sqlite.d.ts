declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { create?: boolean })
    exec(sql: string): void
    query(sql: string): Statement
    run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number }
    close(): void
  }
  interface Statement {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number }
  }
  const _default: typeof Database
  export default _default
  export { Database, type Statement }
}