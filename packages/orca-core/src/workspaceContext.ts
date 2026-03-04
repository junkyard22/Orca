/**
 * WorkspaceContext — lightweight snapshot of the working environment
 * captured once at the start of each task.
 *
 * Adapters (e.g. MaestroAdapter) inject it into the LLM task prompt so the
 * model has grounding: which branch it's on, what recently changed, etc.
 *
 * All fields are optional; git fields degrade gracefully when the CWD is not
 * inside a git repository.
 */

import { execSync } from "child_process";

export interface WorkspaceContext {
  /** Absolute path to the working directory. */
  cwd: string;
  /** Current git branch name, e.g. "main". */
  gitBranch?: string;
  /** Short commit SHA, e.g. "ee698ea". */
  gitCommit?: string;
  /** Subject line of the most-recent commit. */
  gitCommitMessage?: string;
  /**
   * Files changed in the last few commits (relative paths).
   * Provides the model with recency context without full diff noise.
   */
  recentlyModifiedFiles?: string[];
}

/**
 * Capture the current workspace state.
 *
 * @param cwd  Directory to inspect.  Defaults to `process.cwd()`.
 */
export function getWorkspaceContext(cwd: string = process.cwd()): WorkspaceContext {
  const ctx: WorkspaceContext = { cwd };

  const run = (cmd: string): string | undefined => {
    try {
      return execSync(cmd, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 3_000,
      })
        .toString()
        .trim();
    } catch {
      return undefined;
    }
  };

  ctx.gitBranch        = run("git rev-parse --abbrev-ref HEAD");
  ctx.gitCommit        = run("git rev-parse --short HEAD");
  ctx.gitCommitMessage = run("git log -1 --pretty=%s");

  const rawFiles = run("git diff --name-only HEAD~3 HEAD 2>/dev/null") ?? run("git diff --name-only HEAD");
  if (rawFiles) {
    ctx.recentlyModifiedFiles = rawFiles.split("\n").filter(Boolean);
  }

  return ctx;
}
