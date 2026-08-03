/**
 * Pappy — File Change Verifier
 *
 * Performs post-execution file-system verification for FileWrite and CodeEdit
 * tasks.  Three checks are run:
 *
 *   1. File exists   — expected paths appear in filesChanged or on disk.
 *   2. Content match — actual file content reflects the task's described intent.
 *   3. No side effects — no unexpected deletions / out-of-scope modifications.
 *
 * Results are returned as a map of AC-text → check result.  The evaluator
 * substitutes these in place of the generic keyword heuristic for the
 * matching default ACs so failures carry precise, actionable evidence.
 *
 * File-system access uses Node's built-in `fs` module (no new npm deps).
 * Disk checks are only attempted when `AHPVerificationInput.workspaceRoot`
 * is provided.  Without it the checks fall back to the `filesChanged` list.
 */

import * as fs   from "fs";
import * as path from "path";
import type { AHPPacket }              from "@clawde/miranda-core";
import type { AHPVerificationInput }   from "./evaluator.js";
import { TaskType }                    from "./taskClassifier.js";

// ---------------------------------------------------------------------------
// AC text keys — must match taskClassifier DEFAULT_ACS strings exactly
// ---------------------------------------------------------------------------

const AC_FILE_EXISTS         = "file exists at expected path";
const AC_CONTENT_MATCHES     = "content matches described intent";
const AC_NO_UNINTENDED_FILES = "no unintended files created";
const AC_CHANGE_MATCHES      = "the change matches the described intent";
const AC_NO_UNINTENDED_MOD   = "no unintended files modified";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FileCheckResult {
  passed: boolean;
  evidence: string;
}

/**
 * Keyed by normalized AC text (lowercase, trimmed).
 * The evaluator does a `map.get(ac.toLowerCase().trim())` lookup.
 */
export type FileVerificationOverrides = Map<string, FileCheckResult>;

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function resolveWorkspaceFile(workspaceRoot: string, requestedPath: string): string | undefined {
  try {
    const workspace = path.resolve(workspaceRoot);
    const candidate = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(workspace, requestedPath);
    if (!isWithin(workspace, candidate)) return undefined;

    const realWorkspace = fs.realpathSync.native(workspace);
    let existingAncestor = candidate;
    while (!fs.existsSync(existingAncestor)) {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) return undefined;
      existingAncestor = parent;
    }
    const realAncestor = fs.realpathSync.native(existingAncestor);
    if (!isWithin(realWorkspace, realAncestor)) return undefined;

    const tail = path.relative(existingAncestor, candidate);
    const resolved = tail ? path.join(realAncestor, tail) : realAncestor;
    return isWithin(realWorkspace, resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function resolveExistingWorkspaceFile(workspaceRoot: string, requestedPath: string): string | undefined {
  const resolved = resolveWorkspaceFile(workspaceRoot, requestedPath);
  return resolved && fs.existsSync(resolved) ? resolved : undefined;
}

export function isWorkspaceFileReceipt(workspaceRoot: string, requestedPath: string): boolean {
  return resolveWorkspaceFile(workspaceRoot, requestedPath) !== undefined;
}

// ---------------------------------------------------------------------------
// Path extraction
// ---------------------------------------------------------------------------

/** Code/config file extension allowlist used when identifying bare paths. */
const CODE_EXT =
  /\.(ts|js|tsx|jsx|mjs|cjs|json|md|yaml|yml|py|sh|txt|toml|xml|html|css|go|rs|rb|java|cs|cpp|c|h|env|lock)$/i;

function addIfPath(found: Set<string>, candidate: string): void {
  const trimmed = candidate.trim();
  // Reject anything with whitespace or newlines — not a file path
  if (!trimmed || /[\s\n\r]/.test(trimmed)) return;
  if (CODE_EXT.test(trimmed)) found.add(trimmed);
}

/**
 * Extract candidate file paths mentioned in a text string.
 *
 * Matches:
 *   - Backtick-quoted:  `src/foo.ts`
 *   - Double-quoted:    "path/to/file.json"
 *   - Single-quoted:    'config.ts'
 *   - Bare slash paths: src/foo/bar.ts
 */
export function extractExpectedPaths(text: string): string[] {
  const found = new Set<string>();

  // Backtick-quoted (highest confidence — used in code contexts)
  for (const m of text.matchAll(/`([^`\n]+)`/g)) addIfPath(found, m[1] ?? "");

  // Double-quoted
  for (const m of text.matchAll(/"([^"\n]+)"/g)) addIfPath(found, m[1] ?? "");

  // Single-quoted (basic — avoids apostrophes by requiring extension)
  for (const m of text.matchAll(/'([^'\n]+)'/g)) addIfPath(found, m[1] ?? "");

  // Bare slash paths: at-word-boundary, contains at least one /
  for (const m of text.matchAll(/\b([a-zA-Z0-9_\-]+(?:\/[a-zA-Z0-9_\-\.]+)+)\b/g)) {
    addIfPath(found, m[1] ?? "");
  }

  return [...found];
}

// ---------------------------------------------------------------------------
// Check 1 — File exists at expected path
// ---------------------------------------------------------------------------

function checkFilesExist(
  expectedPaths: string[],
  filesChanged: Array<{ path: string; diff?: string; changeType?: string }>,
  workspaceRoot?: string,
): FileCheckResult {
  if (expectedPaths.length === 0) {
    const presentFiles = filesChanged.filter((file) => file.changeType !== "D");
    return presentFiles.length > 0
      ? { passed: true, evidence: `${presentFiles.length} file receipt(s) present; no explicit path in task` }
      : { passed: false, evidence: "no explicit file path and no non-deleted file receipt" };
  }

  const changedPaths = filesChanged
    .filter((file) =>
      file.changeType !== "D" &&
      (!workspaceRoot || isWorkspaceFileReceipt(workspaceRoot, file.path)),
    )
    .map((file) => file.path);
  const found: string[]   = [];
  const missing: string[] = [];

  for (const expected of expectedPaths) {
    // Match by exact path, suffix (`/foo.ts` ends-with), or platform separator
    const inFilesChanged = changedPaths.some(
      (p) =>
        p === expected ||
        p.endsWith(`/${expected}`) ||
        p.endsWith(`\\${expected}`) ||
        p.replace(/\\/g, "/").endsWith(`/${expected}`),
    );

    if (inFilesChanged) {
      found.push(expected);
      continue;
    }

    // Disk check when workspaceRoot is provided
    if (workspaceRoot) {
      const existingFile = resolveExistingWorkspaceFile(workspaceRoot, expected);
      if (existingFile) {
        found.push(expected);
        continue;
      }
    }

    missing.push(expected);
  }

  if (missing.length === 0) {
    return { passed: true, evidence: `file(s) present: ${found.join(", ")}` };
  }

  return { passed: false, evidence: `file(s) not found: ${missing.join(", ")}` };
}

// ---------------------------------------------------------------------------
// Check 2 — Content matches described intent
// ---------------------------------------------------------------------------

const CONTENT_STOP_WORDS = new Set([
  "must", "should", "each", "that", "with", "from", "have", "been", "will",
  "when", "then", "this", "there", "their", "than", "into", "also", "some",
  "more", "such", "they", "what", "were", "your", "does", "file", "files",
  "write", "create", "adds", "the", "and", "for", "are", "not", "its",
  "using", "which", "task", "make", "ensure", "implement", "generate",
  "update", "change", "edit", "path", "should", "able",
]);

function extractSignificantKeywords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !CONTENT_STOP_WORDS.has(w)),
    ),
  ];
}

const CONTENT_READ_BYTE_LIMIT = 10_000;

function checkContentMatchesIntent(
  objective: string,
  filesChanged: Array<{ path: string; diff?: string; changeType?: string }>,
  workspaceRoot?: string,
): FileCheckResult {
  const contentParts: string[] = [];
  const truncatedPaths: string[] = [];

  for (const file of filesChanged) {
    if (file.changeType === "D") continue; // deleted files have no content
    if (workspaceRoot && !isWorkspaceFileReceipt(workspaceRoot, file.path)) continue;

    // Use diff captured from the agent's tool events
    if (file.diff) contentParts.push(file.diff);

    // Read actual file from disk when workspaceRoot is available (stronger signal)
    if (workspaceRoot) {
      try {
        const abs = resolveExistingWorkspaceFile(workspaceRoot, file.path);
        if (!abs) continue;
        const content = fs.readFileSync(abs, "utf8");
        if (content.length > CONTENT_READ_BYTE_LIMIT) {
          truncatedPaths.push(file.path);
        }
        contentParts.push(content.slice(0, CONTENT_READ_BYTE_LIMIT));
      } catch {
        // File unreadable — diff is still in contentParts
      }
    }
  }

  if (contentParts.length === 0) {
    return { passed: false, evidence: "no file content receipt available for content check" };
  }

  const corpus   = contentParts.join("\n").toLowerCase();
  const keywords = extractSignificantKeywords(objective);

  if (keywords.length === 0) {
    return { passed: true, evidence: "objective has no significant keywords to match" };
  }

  const matched   = keywords.filter((kw) => corpus.includes(kw));
  // Use a lenient threshold (1/3) — file content may express the same idea
  // using identifiers and symbols rather than prose words.
  const threshold = Math.max(1, Math.ceil(keywords.length / 3));

  // Surface truncation so a false-negative from unread content is visible.
  const truncationNote =
    truncatedPaths.length > 0
      ? ` (note: content truncated at ${CONTENT_READ_BYTE_LIMIT} bytes for ${truncatedPaths.length} file(s): ${truncatedPaths.slice(0, 3).join(", ")}${truncatedPaths.length > 3 ? ", …" : ""})`
      : "";

  if (matched.length >= threshold) {
    return {
      passed:   true,
      evidence: `content reflects intent (${matched.length}/${keywords.length} keywords): ${matched.slice(0, 4).join(", ")}${truncationNote}`,
    };
  }

  return {
    passed:   false,
    evidence: `file content does not reflect described intent: ${matched.length}/${keywords.length} keywords matched (need ≥${threshold}); objective keywords: ${keywords.slice(0, 5).join(", ")}${truncationNote}`,
  };
}

// ---------------------------------------------------------------------------
// Check 3 — No unintended side effects
// ---------------------------------------------------------------------------

function checkNoUnintendedChanges(
  expectedPaths: string[],
  filesChanged: Array<{ path: string; diff?: string; changeType?: string }>,
): FileCheckResult {
  if (filesChanged.length === 0) {
    return { passed: true, evidence: "no files were changed" };
  }

  // Build a set of expected paths in normalized form (lowercase + both separators)
  const expectedSet      = new Set(expectedPaths.map((p) => p.toLowerCase().replace(/\\/g, "/")));
  const expectedBasenames = new Set(expectedPaths.map((p) => path.basename(p).toLowerCase()));

  const isExpected = (filePath: string): boolean => {
    const norm     = filePath.toLowerCase().replace(/\\/g, "/");
    const basename = path.basename(norm);
    return expectedSet.has(norm) || expectedSet.has(basename) || expectedBasenames.has(basename);
  };

  // ── Unexpected deletions (highest severity) ─────────────────────────────
  const unexpectedDeletions = filesChanged
    .filter((f) => f.changeType === "D" && !isExpected(f.path))
    .map((f) => f.path);

  // ── Unexpected out-of-scope modifications ───────────────────────────────
  // Only check when we have expectedPaths to derive a "scope" from
  const unexpectedMods: string[] = [];
  if (expectedPaths.length > 0) {
    // Derive scope directories: parent dirs of all expected paths
    const scopeDirs = new Set(
      expectedPaths
        .map((p) => p.replace(/\\/g, "/").split("/").slice(0, -1).join("/"))
        .filter(Boolean),
    );

    for (const f of filesChanged) {
      if (f.changeType === "D") continue; // already handled
      if (isExpected(f.path))   continue; // in scope

      const fileDir = f.path.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
      const inScopeDir =
        scopeDirs.size === 0 ||
        [...scopeDirs].some(
          (d) => d === "" || fileDir === d || fileDir.startsWith(`${d}/`),
        );

      if (!inScopeDir) {
        unexpectedMods.push(f.path);
      }
    }
  }

  if (unexpectedDeletions.length === 0 && unexpectedMods.length === 0) {
    return { passed: true, evidence: "no unexpected file changes detected" };
  }

  const parts: string[] = [];
  if (unexpectedDeletions.length > 0) {
    parts.push(`unexpected deletion(s): ${unexpectedDeletions.join(", ")}`);
  }
  if (unexpectedMods.length > 0) {
    parts.push(`out-of-scope modification(s): ${unexpectedMods.slice(0, 5).join(", ")}`);
  }
  return { passed: false, evidence: parts.join("; ") };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run file-system verification for FileWrite and CodeEdit tasks.
 *
 * Returns a `FileVerificationOverrides` map.  For each AC in the map the
 * evaluator substitutes the verification result instead of running the
 * generic keyword heuristic.  ACs not in the map fall through untouched.
 *
 * @param packet    The AHPPacket (objective and expectedOutput used for context).
 * @param input     Execution result including optional filesChanged and workspaceRoot.
 * @param taskType  Classified task type; only FileWrite and CodeEdit trigger checks.
 */
export function verifyFileChanges(
  packet: AHPPacket,
  input: AHPVerificationInput,
  taskType: TaskType,
): FileVerificationOverrides {
  const overrides: FileVerificationOverrides = new Map();

  if (taskType !== TaskType.FileWrite && taskType !== TaskType.CodeEdit) {
    return overrides; // nothing to verify for other task types
  }

  const filesChanged = input.filesChanged ?? [];
  const { workspaceRoot } = input;

  // Extract expected paths from the packet objective AND existing ACs
  const scanText    = `${packet.objective} ${packet.expectedOutput.acceptanceCriteria.join(" ")}`;
  const expectedPaths = extractExpectedPaths(scanText);

  // ── FileWrite checks ──────────────────────────────────────────────────────
  if (taskType === TaskType.FileWrite) {
    overrides.set(
      AC_FILE_EXISTS,
      checkFilesExist(expectedPaths, filesChanged, workspaceRoot),
    );
    overrides.set(
      AC_CONTENT_MATCHES,
      checkContentMatchesIntent(packet.objective, filesChanged, workspaceRoot),
    );
    overrides.set(
      AC_NO_UNINTENDED_FILES,
      checkNoUnintendedChanges(expectedPaths, filesChanged),
    );
  }

  // ── CodeEdit checks ───────────────────────────────────────────────────────
  if (taskType === TaskType.CodeEdit) {
    overrides.set(
      AC_CHANGE_MATCHES,
      checkContentMatchesIntent(packet.objective, filesChanged, workspaceRoot),
    );
    overrides.set(
      AC_NO_UNINTENDED_MOD,
      checkNoUnintendedChanges(expectedPaths, filesChanged),
    );
    // "existing tests continue to pass" requires test execution — left to keyword heuristic
  }

  return overrides;
}
