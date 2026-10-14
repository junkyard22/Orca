/**
 * Workspace evidence — the runtime's own record of what a task changed and
 * which test commands really ran.
 *
 * Pappy used to judge file changes from what the worker reported (a write
 * tool's new content), which cannot show deletions and cannot tell a real
 * edit from rewriting identical content. The runtime now takes a bounded
 * inventory of the workspace at task start (path → size, mtime, content hash;
 * plus the contents of test and configuration files), refreshes it cheaply
 * before each verification (only files whose size or mtime changed are
 * re-hashed), and hands Pappy the differences. It also fingerprints the
 * non-test source the moment a test command's result is observed, so Pappy
 * can tell whether a run happened on the task-start source (a reproduction)
 * or on the final source (a verification) without trusting the order the
 * worker reports.
 *
 * Nothing here is authored by the worker. File enumeration honours git's
 * ignore rules when the workspace is a repository, so dependency and build
 * trees do not count against the limits; when a limit is still hit the
 * evidence is marked `partial` rather than silently incomplete.
 *
 * Inventories are taken synchronously. A test-command fingerprint must be
 * captured before the worker's next tool call can touch the disk, and the
 * agent loops run tool calls back to back within one turn; a few hundred
 * milliseconds of blocking around a test run that itself took seconds is the
 * price of a fingerprint that cannot race.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspaceEvidence, WorkspaceFileChange, WorkspaceFileKind, WorkspaceTestRun } from "@clawde/pappy-core";
import { classifyPath, isFullSuiteCommand, testSegment } from "@clawde/pappy-core";

export interface EvidenceLimits {
  /** Files in the inventory before the evidence is marked partial. */
  maxFiles: number;
  /** Larger files are listed but not hashed or read. */
  maxFileBytes: number;
  /** Total bytes hashed in one capture before the evidence is marked partial. */
  maxHashBytes: number;
  /** Test/config files up to this size keep their content for before/after comparison. */
  captureContentBytes: number;
  /** Milliseconds allowed for `git ls-files` before falling back to a directory walk. */
  gitTimeoutMs: number;
}

export const DEFAULT_EVIDENCE_LIMITS: EvidenceLimits = {
  maxFiles: 60_000,
  maxFileBytes: 25_000_000,
  maxHashBytes: 2_000_000_000,
  captureContentBytes: 512_000,
  gitTimeoutMs: 15_000,
};

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "dist-main", "build", "out", "coverage", "release",
  ".next", ".nuxt", ".turbo", ".cache", ".venv", "venv", "__pycache__", "target", ".idea", ".vscode", ".pnpm-store",
]);

interface FileRecord {
  size: number;
  mtimeMs: number;
  hash: string;
  kind: WorkspaceFileKind;
  /** Baseline content for test/config files (bounded). */
  content?: string;
}

export interface WorkspaceInventory {
  files: Map<string, FileRecord>;
  partial: boolean;
  reason?: string;
  testCommand?: string;
  source: "git" | "walk";
  ms: number;
}

function isProbablyText(buffer: Buffer): boolean {
  return !buffer.subarray(0, 8000).includes(0);
}

function readTestCommand(packageJson: string | undefined): string | undefined {
  if (!packageJson) return undefined;
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, unknown> };
    const test = parsed.scripts?.["test"];
    return typeof test === "string" && test.trim() && !/no test specified/i.test(test) ? test.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Paths from `git ls-files` (tracked + untracked, honouring ignores), or null when git is unavailable. */
function gitListFiles(root: string, timeoutMs: number): string[] | null {
  if (!existsSync(join(root, ".git"))) return null;
  try {
    const stdout = execFileSync(
      "git",
      ["-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    return String(stdout).split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function walkFiles(root: string, limits: EvidenceLimits): { paths: string[]; problem?: string } {
  const paths: string[] = [];
  const walk = (dir: string): string | undefined => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return dir === root ? `cannot read workspace: ${(err as Error).message}` : undefined;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const problem = walk(full);
        if (problem) return problem;
        continue;
      }
      if (!entry.isFile()) continue;
      if (paths.length >= limits.maxFiles) return `more than ${limits.maxFiles} files`;
      paths.push(relative(root, full).split(sep).join("/"));
    }
    return undefined;
  };
  const problem = walk(root);
  return problem ? { paths, problem } : { paths };
}

/**
 * Inventory the workspace. When `previous` is given, files with an unchanged
 * size and mtime keep their previous hash (and captured content) without being
 * read again, which keeps repeated captures cheap.
 */
export function captureWorkspaceInventorySync(
  root: string,
  limits: EvidenceLimits = DEFAULT_EVIDENCE_LIMITS,
  previous?: WorkspaceInventory,
): WorkspaceInventory {
  const started = Date.now();
  const absoluteRoot = resolve(root);
  const files = new Map<string, FileRecord>();
  let partial = false;
  let reason: string | undefined;
  let source: "git" | "walk" = "walk";

  let paths = gitListFiles(absoluteRoot, limits.gitTimeoutMs);
  if (paths) {
    source = "git";
    if (paths.length > limits.maxFiles) {
      partial = true;
      reason = `more than ${limits.maxFiles} files`;
      paths = paths.slice(0, limits.maxFiles);
    }
  } else {
    const walked = walkFiles(absoluteRoot, limits);
    paths = walked.paths;
    if (walked.problem) {
      if (/cannot read workspace/.test(walked.problem)) {
        return { files, partial: true, reason: walked.problem, source, ms: Date.now() - started };
      }
      partial = true;
      reason = walked.problem;
    }
  }

  let hashedBytes = 0;
  for (const path of paths) {
    const full = join(absoluteRoot, ...path.split("/"));
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    const before = previous?.files.get(path);
    if (before && before.size === info.size && before.mtimeMs === info.mtimeMs) {
      files.set(path, before);
      continue;
    }
    const counted = Math.min(info.size, limits.maxFileBytes);
    if (hashedBytes + counted > limits.maxHashBytes) {
      partial = true;
      reason = reason ?? `more than ${limits.maxHashBytes} bytes to hash`;
      break;
    }
    const kind = classifyPath(path);
    let hash: string;
    let buffer: Buffer | undefined;
    if (info.size > limits.maxFileBytes) {
      hash = `size:${info.size}`;
    } else {
      try {
        buffer = readFileSync(full);
      } catch {
        continue;
      }
      hash = createHash("sha256").update(buffer).digest("hex");
    }
    hashedBytes += counted;
    const keepContent = (kind === "test" || kind === "config") && buffer !== undefined && info.size <= limits.captureContentBytes && isProbablyText(buffer);
    files.set(path, { size: info.size, mtimeMs: info.mtimeMs, hash, kind, ...(keepContent ? { content: buffer!.toString("utf8") } : {}) });
  }

  return {
    files,
    partial,
    reason,
    testCommand: readTestCommand(files.get("package.json")?.content),
    source,
    ms: Date.now() - started,
  };
}

export async function captureWorkspaceInventory(
  root: string,
  limits: EvidenceLimits = DEFAULT_EVIDENCE_LIMITS,
  previous?: WorkspaceInventory,
): Promise<WorkspaceInventory> {
  return captureWorkspaceInventorySync(root, limits, previous);
}

/** Hashes of non-test files that differ from the baseline (deleted files map to ""). */
function sourceDelta(baseline: WorkspaceInventory, current: WorkspaceInventory): Map<string, string> {
  const delta = new Map<string, string>();
  for (const [path, record] of baseline.files) {
    if (record.kind === "test") continue;
    const now = current.files.get(path);
    if (!now) delta.set(path, "");
    else if (now.hash !== record.hash) delta.set(path, now.hash);
  }
  for (const [path, record] of current.files) {
    if (record.kind !== "test" && !baseline.files.has(path)) delta.set(path, record.hash);
  }
  return delta;
}

function sameDelta(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [path, hash] of a) if (b.get(path) !== hash) return false;
  return true;
}

export async function diffWorkspaceInventories(
  root: string,
  baseline: WorkspaceInventory,
  current: WorkspaceInventory,
  limits: EvidenceLimits = DEFAULT_EVIDENCE_LIMITS,
): Promise<WorkspaceFileChange[]> {
  const absoluteRoot = resolve(root);
  const changes: WorkspaceFileChange[] = [];
  const afterContent = (path: string, record: FileRecord): string | undefined => {
    if (record.content !== undefined) return record.content;
    if (record.size > limits.captureContentBytes) return undefined;
    try {
      const buffer = readFileSync(join(absoluteRoot, ...path.split("/")));
      return isProbablyText(buffer) ? buffer.toString("utf8") : undefined;
    } catch {
      return undefined;
    }
  };
  for (const [path, before] of baseline.files) {
    const now = current.files.get(path);
    if (!now) {
      changes.push({ path, status: "deleted", kind: before.kind, ...(before.content !== undefined ? { before: before.content } : {}) });
    } else if (now.hash !== before.hash) {
      const after = afterContent(path, now);
      changes.push({ path, status: "modified", kind: before.kind, ...(before.content !== undefined ? { before: before.content } : {}), ...(after !== undefined ? { after } : {}) });
    }
  }
  for (const [path, now] of current.files) {
    if (baseline.files.has(path)) continue;
    const after = afterContent(path, now);
    changes.push({ path, status: "added", kind: now.kind, ...(after !== undefined ? { after } : {}) });
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}

interface ObservedRun {
  tool: string;
  command: string;
  cwd?: string;
  ok: boolean;
  exitCode?: number;
  output: string;
  fullSuite: boolean;
  /** Non-test source hashes that differed from the baseline when the run finished; null when the baseline was missing. */
  delta: Map<string, string> | null;
}

export interface WorkspaceEvidenceCollector {
  /** Resolves once the baseline inventory exists. */
  ready: Promise<void>;
  /** Feed every pipeline trace entry here; test-command results are fingerprinted synchronously. */
  observeTrace(stage: string, detail: unknown): void;
  /** Compare the workspace with the baseline. */
  collect(): Promise<WorkspaceEvidence>;
}

const TOOL_CALL_STAGES = new Set(["tool.call", "agent.tool.call"]);
const TOOL_RESULT_STAGES = new Set(["tool.result", "agent.tool.result"]);
const COMMAND_TOOL = /(?:run_command|execute_command|start_process|shell)/i;
/** Tools that change a file: the host's own writers and connector tools named like them. */
const WRITE_TOOL = /(?:^|[:_.-])(?:write|edit|patch|create|append|replace|move|rename|delete|remove)(?:_?(?:file|files|block|text|lines?|path))?(?:$|[:_.-])/i;

function writtenPath(input: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file", "filePath", "file_path", "filename", "target", "destination", "source"]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function relativePath(root: string, target: string): string {
  const abs = isAbsolute(target) ? target : resolve(root, target);
  const rel = relative(root, abs);
  return (rel.startsWith("..") ? abs : rel).split(sep).join("/");
}

/**
 * Baseline once at task start; every later `collect()` compares the current
 * disk state with that baseline (so repair passes are judged cumulatively).
 */
export function createWorkspaceEvidenceCollector(
  root: string,
  limits: EvidenceLimits = DEFAULT_EVIDENCE_LIMITS,
): WorkspaceEvidenceCollector {
  const absoluteRoot = resolve(root);
  const baseline = captureWorkspaceInventorySync(absoluteRoot, limits);
  const ready = Promise.resolve();
  const runs: ObservedRun[] = [];
  const pendingCalls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  // Who wrote what, and in which Maestro pass: attribution for every changed
  // path, and detection of two workers writing the same path in one pass.
  const writes = new Map<string, Array<{ writer: string; pass: number }>>();
  let pass = 0;
  let evidenceMs = baseline.ms;

  const commandOf = (input: Record<string, unknown> | undefined) => (typeof input?.["command"] === "string" ? (input["command"] as string) : "");

  const observeTrace = (stage: string, detail: unknown): void => {
    if (stage === "maestro.run.start" || stage === "repair.start") pass += 1;
    if (!detail || typeof detail !== "object") return;
    const d = detail as Record<string, unknown>;
    const tool = typeof d["tool"] === "string" ? d["tool"] : "";
    if (TOOL_CALL_STAGES.has(stage) && WRITE_TOOL.test(tool)) {
      const input = d["input"] && typeof d["input"] === "object" ? (d["input"] as Record<string, unknown>) : {};
      const target = writtenPath(input);
      if (target) {
        const path = relativePath(absoluteRoot, target);
        const writer = typeof d["role"] === "string" ? d["role"] : typeof d["subagentId"] === "string" ? d["subagentId"] : "worker";
        const list = writes.get(path) ?? [];
        list.push({ writer, pass: Math.max(pass, 1) });
        writes.set(path, list);
      }
    }
    if (!COMMAND_TOOL.test(tool)) return;
    if (TOOL_CALL_STAGES.has(stage)) {
      const input = d["input"] && typeof d["input"] === "object" ? (d["input"] as Record<string, unknown>) : {};
      pendingCalls.push({ tool, input });
      return;
    }
    if (!TOOL_RESULT_STAGES.has(stage)) return;
    // The desktop loop puts the input on the result; the shared loop does not,
    // so fall back to the oldest unmatched call of the same tool.
    let input = d["input"] && typeof d["input"] === "object" ? (d["input"] as Record<string, unknown>) : undefined;
    const pendingIndex = pendingCalls.findIndex((p) => p.tool === tool);
    if (pendingIndex >= 0) {
      const pending = pendingCalls.splice(pendingIndex, 1)[0]!;
      input = input ?? pending.input;
    }
    const command = commandOf(input);
    if (!command || !testSegment(command)) return;
    const result = d["result"] && typeof d["result"] === "object" ? (d["result"] as Record<string, unknown>) : d;
    // Fingerprint the non-test source as it is right now, before the worker's
    // next action can change it.
    let delta: Map<string, string> | null = null;
    try {
      const current = captureWorkspaceInventorySync(absoluteRoot, limits, baseline);
      evidenceMs += current.ms;
      if (!(current.partial && /cannot read workspace/.test(current.reason ?? ""))) delta = sourceDelta(baseline, current);
    } catch {
      delta = null;
    }
    runs.push({
      tool,
      command,
      cwd: typeof input?.["cwd"] === "string" ? (input["cwd"] as string) : undefined,
      ok: result["ok"] === true,
      exitCode: typeof result["exitCode"] === "number" ? (result["exitCode"] as number) : undefined,
      output: typeof result["output"] === "string" ? (result["output"] as string) : "",
      fullSuite: isFullSuiteCommand(command, baseline.testCommand),
      delta,
    });
  };

  const collect = async (): Promise<WorkspaceEvidence> => {
    const started = Date.now();
    if (baseline.partial && /cannot read workspace/.test(baseline.reason ?? "")) {
      return { available: false, reason: baseline.reason, provenance: "runtime-snapshot", changes: [] };
    }
    const current = captureWorkspaceInventorySync(absoluteRoot, limits, baseline);
    if (current.partial && /cannot read workspace/.test(current.reason ?? "")) {
      return { available: false, reason: current.reason, provenance: "runtime-snapshot", changes: [] };
    }
    const finalDelta = sourceDelta(baseline, current);
    const testRuns: WorkspaceTestRun[] = runs.map((run) => ({
      tool: run.tool,
      command: run.command,
      ...(run.cwd !== undefined ? { cwd: run.cwd } : {}),
      ok: run.ok,
      ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
      output: run.output,
      fullSuite: run.fullSuite,
      sourceState: run.delta === null
        ? "unknown"
        : run.delta.size === 0
          ? "baseline"
          : sameDelta(run.delta, finalDelta) ? "final" : "intermediate",
    }));
    const changes = (await diffWorkspaceInventories(absoluteRoot, baseline, current, limits)).map((change) => {
      const w = writes.get(change.path);
      return w ? { ...change, writers: [...new Set(w.map((x) => x.writer))] } : change;
    });
    const contested: Array<{ path: string; writers: string[] }> = [];
    for (const [path, list] of writes) {
      const byPass = new Map<number, Set<string>>();
      for (const w of list) byPass.set(w.pass, (byPass.get(w.pass) ?? new Set()).add(w.writer));
      const writers = [...byPass.values()].find((set) => set.size > 1);
      if (writers) contested.push({ path, writers: [...writers] });
    }
    contested.sort((x, y) => x.path.localeCompare(y.path));
    const partial = baseline.partial || current.partial;
    return {
      available: true,
      ...(partial ? { partial: true, reason: baseline.reason ?? current.reason } : {}),
      provenance: "runtime-snapshot",
      baselineFiles: baseline.files.size,
      changes,
      ...(baseline.testCommand ? { testCommand: baseline.testCommand } : {}),
      testRuns,
      ...(contested.length > 0 ? { contested } : {}),
      captureMs: evidenceMs + current.ms + (Date.now() - started),
    };
  };

  return { ready, observeTrace, collect };
}
