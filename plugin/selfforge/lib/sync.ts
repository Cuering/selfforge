import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getConfig, setConfig, nodeId } from "./db"
import { exportSnapshot, importSnapshot, SNAPSHOT_FORMAT, SNAPSHOT_VERSION } from "./transfer"

/**
 * Phase 4 — team shared memory over git.
 *
 * A git repo (bare or worktree) holds a `snapshot.json` as the shared
 * truth. `teamSync` runs:
 *
 *   1. fetch + fast-forward (reset --hard on divergence) so we start from
 *      the team's latest snapshot;
 *   2. import that snapshot into the local store as a per-uuid LWW merge
 *      (Phase 3 merge semantics: newer wins, tombstones delete);
 *   3. re-export the merged store back into snapshot.json;
 *   4. commit + push under this node's identity.
 *
 * This is idempotent: run it on any number of machines and they converge.
 * The SQLite store is authoritative locally; the git file is transport.
 * No git library dependency — the git CLI is invoked via child_process.
 */

const SNAPSHOT_FILENAME = "snapshot.json"

export type SyncResult = {
  repo: string
  pulled: boolean
  merged: Record<string, Record<string, number>> | null
  pushed: boolean
  commit: string | null
  error?: string
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim()
}

function repoPath(): string {
  return getConfig("team_repo") || ""
}

function setRepo(repo: string): void {
  setConfig("team_repo", repo)
}

/** True if `repo` is a git worktree with our snapshot. */
export function isTeamRepo(repo: string): boolean {
  if (!existsSync(join(repo, ".git"))) return false
  return existsSync(join(repo, SNAPSHOT_FILENAME))
}

/** Initialize a new team repo at `repo` (git init + first snapshot commit). */
export function teamInit(repo: string, opts?: { remote?: string }): { repo: string; commit: string } {
  if (!existsSync(repo)) mkdirSync(repo, { recursive: true })
  if (!existsSync(join(repo, ".git"))) git(repo, ["init", "-q", "-b", "main"])
  const snap = exportSnapshot()
  writeFileSync(join(repo, SNAPSHOT_FILENAME), JSON.stringify(snap, null, 2))
  git(repo, ["add", SNAPSHOT_FILENAME])
  const committed = tryCommit(repo, `selfforge: init snapshot (${nodeId()})`)
  if (opts?.remote) {
    try {
      git(repo, ["remote", "remove", "origin"])
    } catch {}
    git(repo, ["remote", "add", "origin", opts.remote])
  }
  setRepo(repo)
  return { repo, commit: committed }
}

function tryCommit(repo: string, message: string): string | null {
  try {
    const out = git(repo, ["commit", "-q", "-m", message])
    return out || git(repo, ["rev-parse", "HEAD"]).slice(0, 8)
  } catch {
    // nothing to commit
    try {
      return git(repo, ["rev-parse", "HEAD"]).slice(0, 8)
    } catch {
      return null
    }
  }
}

function loadRepoSnapshot(repo: string) {
  const raw = readFileSync(join(repo, SNAPSHOT_FILENAME), "utf8")
  const snap = JSON.parse(raw) as Record<string, unknown>
  if (snap.format !== SNAPSHOT_FORMAT) throw new Error(`bad team snapshot in ${repo}`)
  return snap as Parameters<typeof importSnapshot>[0]
}

/** Pull the remote (fast-forward; hard-reset on divergence), return whether anything changed. */
function pullRemote(repo: string, branch: string, remote: string): { changed: boolean; error?: string } {
  let fetched = false
  try {
    git(repo, ["fetch", "-q", remote, branch])
    fetched = true
  } catch (e) {
    // first push: remote branch doesn't exist yet — nothing to pull, not an error
    return { changed: false }
  }
  try {
    git(repo, ["merge", "-q", "--ff-only", `${remote}/${branch}`])
    return { changed: fetched }
  } catch {
    // diverged — the snapshot file is transport; take the team's version then re-merge locally
    try {
      git(repo, ["reset", "-q", "--hard", `${remote}/${branch}`])
      return { changed: true }
    } catch {
      return { changed: false, error: "pull failed" }
    }
  }
}

/**
 * One team sync cycle: pull -> merge into local store -> re-export -> push.
 * Returns per-table merge counts and whether a push happened.
 */
export function teamSync(opts?: { repo?: string; remote?: string; branch?: string }): SyncResult {
  const repo = opts?.repo ?? repoPath()
  if (!repo) return { repo: "", pulled: false, merged: null, pushed: false, commit: null, error: "no team repo configured (set team_repo or pass repo)" }
  if (!existsSync(join(repo, ".git"))) return { repo, pulled: false, merged: null, pushed: false, commit: null, error: `not a git repo: ${repo}` }
  const remote = opts?.remote ?? "origin"
  const branch = opts?.branch ?? "main"

  let pulled = false
  if (existsSync(join(repo, SNAPSHOT_FILENAME))) {
    const p = pullRemote(repo, branch, remote)
    if (p.error) return { repo, pulled: false, merged: null, pushed: false, commit: null, error: p.error }
    pulled = p.changed
  } else {
    // no snapshot yet (fresh clone) — just take whatever the remote has
    try {
      git(repo, ["checkout", "-q", `${remote}/${branch}`, "--", SNAPSHOT_FILENAME])
      pulled = true
    } catch {}
  }

  let merged: Record<string, Record<string, number>> | null = null
  if (existsSync(join(repo, SNAPSHOT_FILENAME))) {
    merged = importSnapshot(loadRepoSnapshot(repo))
  }

  // re-export the merged store as the new shared truth and push it
  const snap = exportSnapshot()
  writeFileSync(join(repo, SNAPSHOT_FILENAME), JSON.stringify(snap, null, 2))
  git(repo, ["add", SNAPSHOT_FILENAME])
  const commit = tryCommit(repo, `selfforge: sync from ${nodeId()}`)
  let pushed = false
  try {
    git(repo, ["push", "-q", remote, branch])
    pushed = true
  } catch (e) {
    return { repo, pulled, merged, pushed: false, commit, error: `push failed: ${(e as Error).message.split("\n")[0]}` }
  }
  setLastSync()
  return { repo, pulled, merged, pushed, commit }
}

export function teamStatus(): {
  repo: string
  is_team_repo: boolean
  snapshot_version: number
  local_node: string
  last_sync: string | null
} {
  const repo = repoPath()
  return {
    repo,
    is_team_repo: repo ? isTeamRepo(repo) : false,
    snapshot_version: SNAPSHOT_VERSION,
    local_node: nodeId(),
    last_sync: getConfig("last_sync_at") || null,
  }
}

export function setLastSync(): void {
  setConfig("last_sync_at", new Date().toISOString())
}
