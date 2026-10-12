/**
 * Workspace verification — does the evidence show the user's request was met?
 *
 * Runs only when the runtime supplied `input.workspace` (what really changed on
 * disk, and which test commands really ran). Nothing here trusts the worker's
 * own report: a file rewritten with identical content is not a change, a
 * deleted or weakened test is never a resolution, and a test receipt counts
 * only when the host recorded it.
 *
 * The checks are task-aware. A bug fix, a refactor, a feature, a documentation
 * change and an inspection each need different evidence — and for code work
 * that evidence is *behavioural*: a modified file proves the file changed, not
 * that a defect is resolved, a feature works or a refactor preserved behaviour.
 * Each kind yields `receipts` (what the host recorded on the final source) that
 * the ledger then ties to individual criteria. The result keeps four states apart:
 *   contradicted   — the evidence shows the work is wrong          → HIGH/CRITICAL
 *   unverified     — plausibly correct, but not independently shown → HIGH, worded
 *                    "Not verified (insufficient evidence)"; mandatory evidence
 *                    never becomes a warning-only success
 *   uninterpretable— evidence present but unreadable                → HIGH, same wording
 *   verified       — independent evidence supports the objective    → no issue
 * Scope notes that are not evidence requirements (an unrequested config or
 * source change) stay MEDIUM. Pappy's verdict rules are unchanged.
 */
import type {
  Issue,
  PappyInput,
  TaskKind,
  ToolEvent,
  VerificationStatus,
  WorkspaceFileChange,
  WorkspaceFileKind,
  WorkspaceTestRun,
} from "../types.js";
import { extractCriterionSymbols } from "./criterionSymbols.js";
import { distinctiveTerms, matchedTerms, textCoversRequirement, withoutFilePaths } from "./evidenceTerms.js";

type RawIssue = Omit<Issue, "issueId">;

/**
 * Something the host recorded on the final source that shows behaviour, not
 * just a change: which criteria it can support is decided by `text` (what it
 * names) or `coversTask` (it exercises the whole request, as a reproduced
 * failure or a full passing suite does for a bug fix or refactor).
 */
export interface BehaviouralReceipt {
  kind: "reproduction" | "regression_test" | "full_suite" | "validation_command" | "build_check" | "final_content";
  command: string;
  sourceState: WorkspaceTestRun["sourceState"];
  /** Lower-cased: command, output, and the content of the tests that ran. */
  text: string;
  /** True when the receipt speaks for every criterion of the task. */
  coversTask: boolean;
  summary: string;
}

// ── Path classification ─────────────────────────────────────────────────────

const TEST_PATH = /(^|\/)(__tests__|tests?|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|(^|\/)conftest\.py$/i;
const DOCS_PATH = /\.(md|markdown|mdx|rst|txt|adoc)$|(^|\/)docs?\/|(^|\/)(README|CHANGELOG|LICENSE|CONTRIBUTING)[^/]*$/i;
const LOCK_PATH = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|go\.sum)$/i;
const CONFIG_PATH = /(^|\/)(package\.json|tsconfig[^/]*\.json|(vitest|jest|mocha|playwright|cypress|karma)\.config\.[^/]+|\.mocharc[^/]*|pytest\.ini|setup\.cfg|pyproject\.toml|tox\.ini|Cargo\.toml|go\.mod|\.github\/workflows\/[^/]+)$/i;
const CODE_EXT = /\.(c|cc|cpp|cs|dart|ex|exs|go|h|hpp|java|jsx?|kt|kts|m|mjs|cjs|php|py|rb|rs|scala|sh|sql|swift|tsx?|vue|svelte|ps1|json|ya?ml|toml)$/i;

export function classifyPath(path: string): WorkspaceFileKind {
  const p = path.replace(/\\/g, "/");
  if (TEST_PATH.test(p)) return "test";
  if (LOCK_PATH.test(p)) return "lock";
  if (CONFIG_PATH.test(p)) return "config";
  if (DOCS_PATH.test(p)) return "docs";
  if (CODE_EXT.test(p)) return "source";
  return "other";
}

export function isTestPath(path: string): boolean {
  return classifyPath(path) === "test";
}

// ── Task classification ─────────────────────────────────────────────────────

const FIX_VERB = /\b(fix|fixes|fixing|repair|resolve|correct|patch|debug)\w*\b/i;
const DEFECT_NOUN = /\b(bugs?|issues?|defects?|regressions?|broken|incorrect|wrong|fail\w*|errors?|crash\w*|problems?|exception)\b/i;
const REFACTOR_VERB = /\b(refactor\w*|clean\s*up|extract|de-?dup\w*|simplif\w+|restructur\w+|re-?organi[sz]\w+|modulari[sz]\w+|consolidat\w+|rename)\b/i;
const CHANGE_VERB = /\b(add|adds|adding|implement\w*|create|build|introduce|support|write|wire|integrate|extend|update|change|modify|migrate|upgrade|remove|delete|replace|rewrite|improve|optimi[sz]e|convert)\b/i;
const DOCS_NOUN = /\b(readme|documentation|docs?|doc\s*comments?|docstrings?|changelog|markdown|\.md\b|guide|tutorial|wiki|api\s+reference|comments?)\b/i;
const INSPECT_VERB = /\b(explain|describe|summari[sz]e|what\s+(does|is|are)|how\s+(does|do|is)|review|audit|analy[sz]e|inspect|investigate|look\s+(at|into)|tell\s+me|list|show\s+me|find\s+out|report\s+on|assess|compare|why\s+(does|is))\b/i;
const MENTIONS_TESTS = /\btests?\b|\btest\s+suite\b|\bspecs?\b/i;
const PROHIBITS_TEST_EDITS =
  /\b(?:do not|don't|never|must not|should not|without)\b[^.]{0,80}\b(?:modify|modifying|change|changing|edit|editing|touch|touching|alter|altering|delete|deleting|remove|removing|rewrite|rewriting|weaken|weakening|skip|skipping)\b[^.]{0,60}\btests?\b|\b(?:leave|keep)\b[^.]{0,30}\btests?\b[^.]{0,30}\b(?:unchanged|as is|intact)\b/i;
const ASKS_TEST_CHANGES = /\b(?:update|rewrite|change|modify|fix|remove|delete|replace|adjust)\b[^.]{0,40}\b(?:the\s+)?(?:existing\s+|old\s+|obsolete\s+|failing\s+|broken\s+)?tests?\b/i;
const ASKS_VERIFICATION = /\b(verify|confirm|make\s+sure|ensure|prove|reproduce|demonstrate)\b[^.]{0,80}\b(fixed|resolved|works?|passes|passing|corrected|no\s+longer)\b/i;

export function isDefectFixTask(task: string): boolean {
  return FIX_VERB.test(task) && DEFECT_NOUN.test(task);
}

export function prohibitsTestEdits(task: string): boolean {
  return PROHIBITS_TEST_EDITS.test(task);
}

/** Strip prohibition clauses so "do not modify the tests" does not read as a change request. */
function withoutProhibitions(text: string): string {
  return text.replace(/\b(?:do not|don't|never|without|must not|should not|avoid)\b[^.;\n]*/gi, " ");
}

export function classifyTaskKind(task: string): TaskKind {
  const text = withoutProhibitions(task);
  const docsTarget = DOCS_NOUN.test(text);
  const changeIntent = CHANGE_VERB.test(text) || FIX_VERB.test(text) || REFACTOR_VERB.test(text);
  if (!changeIntent) return INSPECT_VERB.test(text) ? "inspect" : "other";
  // A docs-only request: documentation is the target and nothing points at
  // code behaviour (source paths, logic, crashes, tests, implementation).
  if (docsTarget && !/\b(src|source code|the code|logic|crash\w*|exception|tests?|implement\w*|refactor\w*)\b/i.test(text.replace(new RegExp(DOCS_NOUN.source, "gi"), " "))) return "docs";
  if (isDefectFixTask(text)) return "bugfix";
  if (REFACTOR_VERB.test(text)) return "refactor";
  if (/\b(add|adds|adding|implement\w*|create|build|introduce|support|write|wire|integrate|extend|new)\b/i.test(text)) return "feature";
  return "other";
}

// ── Test output parsing ─────────────────────────────────────────────────────

function count(re: RegExp, text: string): number {
  return (text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) ?? []).length;
}

/** Rough shape of a test file: how many cases, assertions and skips it declares. */
export function testShape(source: string): { cases: number; assertions: number; skips: number } {
  return {
    cases:
      count(/(?:^|[^\w.$])(?:it|test)(?:\.(?:only|concurrent|each))?\s*\(/m, source) +
      count(/^\s*def\s+test_\w*\s*\(/m, source) +
      count(/^\s*func\s+Test\w*\s*\(/m, source) +
      count(/#\[test\]/m, source),
    assertions: count(/\bexpect\s*\(|\bassert(?:\.\w+)?\s*\(|\bassert\s+\w|\bt\.(?:equal|deepEqual|ok|is|true|false|throws|not\w*)\s*\(|\bself\.assert\w+\s*\(|\bassert_eq!|\bassert!/, source),
    skips: count(/\.(?:skip|todo)\s*\(|\bx(?:it|test|describe)\s*\(|@pytest\.mark\.skip|\bt\.Skip\(|#\[ignore\]/, source),
  };
}

export interface TestCounts { total: number; passed: number; failed: number }

/** Parse a test runner's own summary. Returns null when no summary is recognisable. */
export function parseTestCounts(output: string): TestCounts | null {
  const n = (m: RegExpMatchArray | null, i = 1) => (m && m[i] !== undefined ? Number(m[i]) : undefined);

  // node:test (TAP "# tests 8" or spec reporter "ℹ tests 8")
  const nodeTests = n(output.match(/(?:^|\n)\s*(?:#|ℹ|i)\s*tests\s+(\d+)/));
  if (nodeTests !== undefined) {
    const pass = n(output.match(/(?:^|\n)\s*(?:#|ℹ|i)\s*pass\s+(\d+)/)) ?? 0;
    const fail = n(output.match(/(?:^|\n)\s*(?:#|ℹ|i)\s*fail\s+(\d+)/)) ?? 0;
    const cancelled = n(output.match(/(?:^|\n)\s*(?:#|ℹ|i)\s*cancelled\s+(\d+)/)) ?? 0;
    return { total: nodeTests, passed: pass, failed: fail + cancelled };
  }
  // jest: "Tests:       1 failed, 7 passed, 8 total"
  const jest = output.match(/Tests:\s+(?:(\d+)\s+failed,\s+)?(?:\d+\s+skipped,\s+)?(?:\d+\s+todo,\s+)?(?:(\d+)\s+passed,\s+)?(\d+)\s+total/);
  if (jest) return { total: Number(jest[3]), passed: Number(jest[2] ?? 0), failed: Number(jest[1] ?? 0) };
  // vitest: "Tests  1 failed | 7 passed (8)"
  const vitest = output.match(/Tests\s+(?:(\d+)\s+failed\s*\|?\s*)?(?:(\d+)\s+passed\s*\|?\s*)?(?:\d+\s+skipped\s*)?\((\d+)\)/);
  if (vitest) return { total: Number(vitest[3]), passed: Number(vitest[2] ?? 0), failed: Number(vitest[1] ?? 0) };
  // mocha: "7 passing" / "1 failing"
  const mochaPass = n(output.match(/(\d+)\s+passing\b/));
  if (mochaPass !== undefined) {
    const failing = n(output.match(/(\d+)\s+failing\b/)) ?? 0;
    return { total: mochaPass + failing, passed: mochaPass, failed: failing };
  }
  // pytest: "=== 7 passed, 1 failed in 0.12s ==="
  const pytest = output.match(/=+\s*([^=\n]*\b(?:passed|failed)\b[^=\n]*)\s*=+/);
  if (pytest) {
    const line = pytest[1]!;
    const passed = n(line.match(/(\d+)\s+passed/)) ?? 0;
    const failed = (n(line.match(/(\d+)\s+failed/)) ?? 0) + (n(line.match(/(\d+)\s+errors?/)) ?? 0);
    return { total: passed + failed, passed, failed };
  }
  // go test: "ok  pkg 0.1s" / "FAIL" lines with "--- FAIL: TestX"
  if (/^(?:ok|FAIL)\s+\S+/m.test(output)) {
    const failed = count(/^--- FAIL: /m, output);
    const passed = count(/^--- PASS: /m, output);
    if (passed + failed > 0) return { total: passed + failed, passed, failed };
  }
  return null;
}

/**
 * Names of failing tests, where the runner reports them. node:test's spec
 * reporter repeats every failure in a trailing "failing tests:" recap, so only
 * the result section before that recap is read. Distinct failing tests that
 * share a name are kept as one name (names are compared, not counted).
 */
export function parseFailingTests(output: string): string[] {
  const body = output.split(/\n[ \t]*(?:✖|×)[ \t]*failing tests:/i)[0] ?? output;
  const names = new Set<string>();
  const take = (re: RegExp) => {
    for (const m of body.matchAll(re)) {
      const name = m[1]?.trim();
      if (name && !/^(?:tests?|suites?|pass|fail(?:ing)?|cancelled|skipped|todo|duration_ms)\b/i.test(name)) names.add(name);
    }
  };
  take(/^[ \t]*not ok \d+ - (.+?)[ \t]*(?:#.*)?$/gm);           // node:test TAP
  take(/^[ \t]*✖ (.+?)(?: \([\d.]+ ?m?s\))?[ \t]*$/gm);          // node:test spec
  take(/^[ \t]*✕ (.+?)(?: \([\d.]+ ?m?s\))?[ \t]*$/gm);          // jest
  take(/^[ \t]*[×✗] (.+?)(?: [\d.]+ ?ms)?[ \t]*$/gm);           // vitest
  take(/^FAILED (\S+?)(?: - .*)?$/gm);                           // pytest
  take(/^--- FAIL: (\S+)/gm);                                    // go
  return [...names];
}

// ── Command/test receipt helpers ────────────────────────────────────────────

const TEST_COMMAND =
  /^(?:npx\s+|pnpm\s+exec\s+|yarn\s+)?(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|node\s+(?:--[\w-]+(?:=\S+)?\s+)*--test\b|vitest\b|jest\b|mocha\b|pytest\b|python3?\s+-m\s+(?:pytest|unittest)\b|go\s+test\b|cargo\s+test\b|deno\s+test\b)/i;
const NARROWING_FLAG =
  /(?:^|\s)(?:--test-name-pattern|--testNamePattern|--test-only|--grep|--only|--filter|--testPathPattern|--bail|-t|-g|-k|-x|-run)(?=[=\s]|$)/;
/** "Alternative verification: <method>" / "Verified by: <method>" — the worker naming how it checked the behaviour. */
const ALTERNATIVE_VERIFICATION =
  /^[ \t>*#-]*(?:\*\*)?(?:alternative verification|verification method|verified (?:by|with|via))(?:\*\*)?[ \t]*:[ \t]*(.{12,})$/gim;
const BUILD_CHECK_COMMAND =
  /^(?:npx\s+|pnpm\s+exec\s+|yarn\s+)?(?:tsc\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|typecheck|type-check|check)\b|cargo\s+(?:build|check|clippy)\b|go\s+(?:build|vet)\b|mypy\b|pyright\b|python3?\s+-m\s+(?:compileall|py_compile)\b|javac\b|mvn\s+(?:compile|verify)\b|gradle\w*\s+(?:build|compileJava)\b|dotnet\s+build\b)/i;
const MUTATING_TOOL = /(^|[_-])(write|edit|modify|delete|remove|move|rename|create|patch|apply|replace)([_-]|$)|edit_block/i;
// A shell redirect writes a file; an arrow (`=>`, `->`) or a comparison inside a
// quoted script does not.
const MUTATING_COMMAND = /(?:^|[\s;&|])(?:sed\s+-i|perl\s+-pi|mv|cp|rm|tee|git\s+(?:apply|checkout|restore|reset))\b|(?:^|[^\d&=<>|-])>{1,2}\s*[^&\s>=]/i;

function rawRecord(event: ToolEvent): Record<string, unknown> {
  return event.raw && typeof event.raw === "object" ? (event.raw as Record<string, unknown>) : {};
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+\d?>&\d\b/g, "").replace(/\s+/g, " ").trim();
}

/** The segment of a compound command (a && b; c) that runs tests, if any. */
export function testSegment(command: string): string | null {
  for (const segment of command.split(/&&|;|\|\|/)) {
    const s = normalizeCommand(segment);
    if (TEST_COMMAND.test(s)) return s;
  }
  return null;
}

export function isFullSuiteCommand(command: string, projectTestCommand?: string): boolean {
  let segment = testSegment(command);
  if (!segment) return false;
  if (/\|/.test(segment)) segment = segment.split("|")[0]!.trim();
  if (projectTestCommand && segment === normalizeCommand(projectTestCommand)) return true;
  if (NARROWING_FLAG.test(segment)) return false;
  // `npm test -- <args>` forwards arguments to the runner.
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\s+--\s+\S/.test(segment)) return false;
  // Positional file/directory arguments select a subset of tests.
  const tokens = segment.split(" ");
  const base = tokens.findIndex((t) => /^(?:test|--test|vitest|jest|mocha|pytest|unittest|cargo|deno|run)$/.test(t));
  const positional = tokens.slice(base + 1).filter((t) => !t.startsWith("-") && t !== "test" && t !== "run" && t !== "./...");
  return positional.length === 0;
}

interface TestRun extends WorkspaceTestRun { index: number }

/** Test runs from the event sequence, enriched with host-observed source state when available. */
function collectTestRuns(events: readonly ToolEvent[], hostRuns: readonly WorkspaceTestRun[] | undefined, projectTestCommand?: string): TestRun[] {
  const runs: TestRun[] = [];
  const unmatchedHost = [...(hostRuns ?? [])];
  events.forEach((event, index) => {
    const raw = rawRecord(event);
    const command = typeof raw["command"] === "string" ? raw["command"] : "";
    if (!command || !/(?:run_command|execute_command|start_process|shell)/i.test(event.tool)) return;
    if (!testSegment(command)) return;
    const output = typeof raw["_outputForProof"] === "string" ? raw["_outputForProof"] : "";
    const exitCode = typeof raw["_exitCodeForProof"] === "number" ? raw["_exitCodeForProof"] : undefined;
    // Pair with the host's record of the same command (same order of execution).
    const hostIndex = unmatchedHost.findIndex((h) => normalizeCommand(h.command) === normalizeCommand(command));
    const host = hostIndex >= 0 ? unmatchedHost.splice(hostIndex, 1)[0] : undefined;
    runs.push({
      index,
      tool: event.tool,
      command,
      cwd: typeof raw["cwd"] === "string" ? raw["cwd"] : undefined,
      ok: event.ok,
      exitCode: host?.exitCode ?? exitCode,
      output: output || host?.output || "",
      fullSuite: isFullSuiteCommand(command, projectTestCommand),
      sourceState: host?.sourceState ?? "unknown",
    });
  });
  return runs;
}

function lastMutationIndex(events: readonly ToolEvent[]): number {
  let last = -1;
  events.forEach((event, index) => {
    if (!event.ok) return;
    const raw = rawRecord(event);
    const command = typeof raw["command"] === "string" ? raw["command"] : "";
    if (MUTATING_TOOL.test(event.tool) || (command && MUTATING_COMMAND.test(command) && !testSegment(command))) last = index;
  });
  return last;
}

/** Index of the first mutation of a non-test file (adding a regression test may precede reproduction). */
function firstSourceMutationIndex(events: readonly ToolEvent[]): number {
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (!event.ok) continue;
    const raw = rawRecord(event);
    const command = typeof raw["command"] === "string" ? raw["command"] : "";
    if (command && MUTATING_COMMAND.test(command) && !testSegment(command)) return i;
    if (MUTATING_TOOL.test(event.tool)) {
      const path = String(raw["path"] ?? raw["file_path"] ?? raw["filePath"] ?? "");
      if (!path || !isTestPath(path)) return i;
    }
  }
  return events.length;
}

// ── Issues ──────────────────────────────────────────────────────────────────

function issue(severity: Issue["severity"], code: string, category: Issue["category"], description: string, evidence: string, fix: string): RawIssue {
  return { severity, code, category, description, expected_receipt: fix, evidence, fix_hint: fix, message: description, suggestedFix: fix };
}

const UNVERIFIED = "Not verified (insufficient evidence): ";
const UNREADABLE = "Not verified (evidence could not be interpreted): ";

export interface WorkspaceVerificationResult {
  issues: RawIssue[];
  verification: VerificationStatus;
  /** Behavioural receipts recorded on the final source, for the criteria ledger. */
  receipts: BehaviouralReceipt[];
}

// ── Main check ──────────────────────────────────────────────────────────────

export function runWorkspaceVerificationChecks(input: PappyInput): WorkspaceVerificationResult {
  const task = input.task ?? "";
  const kind = classifyTaskKind(task);
  const workspace = input.workspace;
  const reasons: string[] = [];
  const issues: RawIssue[] = [];

  if (!workspace) {
    return { issues, verification: { status: "not_applicable", taskKind: kind, reasons: ["no workspace evidence supplied"], testEvidence: false }, receipts: [] };
  }

  if (!workspace.available) {
    const needsEvidence = kind !== "inspect" && kind !== "other";
    if (needsEvidence) {
      issues.push(issue("HIGH", "EVIDENCE_UNAVAILABLE", "Proof",
        `${UNVERIFIED}the workspace could not be compared before and after the run (${workspace.reason ?? "snapshot unavailable"}).`,
        `workspace.available=false; reason=${workspace.reason ?? "unknown"}`,
        "Run the task in a readable workspace, or verify the change manually."));
    }
    return { issues, verification: { status: "unavailable", taskKind: kind, reasons: [workspace.reason ?? "snapshot unavailable"], testEvidence: false }, receipts: [] };
  }

  const changes = workspace.changes;
  const byKind = (k: WorkspaceFileKind) => changes.filter((c) => c.kind === k);
  const testChanges = byKind("test");
  const existingTestChanges = testChanges.filter((c) => c.status !== "added");
  const docsChanges = byKind("docs");
  // "Code-like" changes: anything that is not a test, documentation or a lockfile.
  const sourceChanges = changes.filter((c) => c.kind !== "test" && c.kind !== "docs" && c.kind !== "lock" && c.status !== "deleted");
  const codeChanges = sourceChanges.filter((c) => c.kind === "source");
  let status: VerificationStatus["status"] = "verified";
  let testEvidence = false;
  const downgrade = (to: VerificationStatus["status"], reason: string) => {
    const rank = { verified: 0, unverified: 1, uninterpretable: 1, unavailable: 2, contradicted: 3, not_applicable: 0 } as const;
    if (rank[to] > rank[status]) status = to;
    reasons.push(reason);
  };

  if (workspace.partial && kind !== "inspect" && kind !== "other") {
    issues.push(issue("HIGH", "EVIDENCE_PARTIAL", "Proof",
      `${UNVERIFIED}the workspace inventory hit a limit (${workspace.reason ?? "limit"}), so some changes may not have been compared.`,
      `workspace.partial=true; reason=${workspace.reason ?? "unknown"}`,
      "Narrow the workspace root or raise the evidence limits so every file can be compared."));
    downgrade("unverified", "partial workspace inventory");
  }

  // ── Universal: existing tests left intact ─────────────────────────────────
  const prohibited = prohibitsTestEdits(task);
  const testChangesRequested = !prohibited && ASKS_TEST_CHANGES.test(withoutProhibitions(task));
  for (const change of existingTestChanges) {
    if (change.status === "deleted") {
      issues.push(issue(testChangesRequested ? "MEDIUM" : "CRITICAL", "TEST_FILE_DELETED", "Safety",
        `Existing test file ${change.path} was deleted${testChangesRequested ? " (the request mentioned changing tests; confirm this was intended)" : ""}.`,
        `deleted: ${change.path}`,
        "Restore the deleted test file; never delete tests to make a suite pass."));
      if (!testChangesRequested) downgrade("contradicted", `test file deleted: ${change.path}`);
      continue;
    }
    if (change.before === undefined || change.after === undefined) continue;
    const before = testShape(change.before);
    const after = testShape(change.after);
    if (after.cases < before.cases || after.assertions < before.assertions || after.skips > before.skips) {
      issues.push(issue(testChangesRequested ? "MEDIUM" : "CRITICAL", "TEST_FILES_MODIFIED_WEAKENED", "Safety",
        `Existing tests in ${change.path} were weakened (test cases ${before.cases}→${after.cases}, assertions ${before.assertions}→${after.assertions}, skips ${before.skips}→${after.skips})${testChangesRequested ? "; the request mentioned changing tests, confirm this was intended" : ""}.`,
        `before/after content comparison of ${change.path}`,
        "Restore the original tests; do not remove, skip, or loosen tests to force a pass."));
      if (!testChangesRequested) downgrade("contradicted", `tests weakened: ${change.path}`);
    }
  }
  if (prohibited && existingTestChanges.length > 0) {
    issues.push(issue("CRITICAL", "TEST_EDIT_PROHIBITED", "Safety",
      `The user said not to modify the existing tests, but ${existingTestChanges.map((c) => c.path).join(", ")} changed.`,
      `workspace changes: ${existingTestChanges.map((c) => `${c.status}:${c.path}`).join(", ")}`,
      "Revert the test changes and fix the source code instead."));
    downgrade("contradicted", "tests edited against the user's instruction");
  }

  // ── Universal: user restrictions and control files ────────────────────────
  const deleted = changes.filter((c) => c.status === "deleted");
  if (input.constraints?.forbidDeletes && deleted.length > 0) {
    issues.push(issue("HIGH", "FORBIDDEN_DELETE_DETECTED", "Safety",
      `Files were deleted although deletions were forbidden: ${deleted.map((c) => c.path).join(", ")}.`,
      `deleted: ${deleted.map((c) => c.path).join(", ")}`, "Restore the deleted files."));
    downgrade("contradicted", "forbidden deletion");
  }
  const controlChanges = changes.filter((c) => (c.kind === "config" || c.kind === "lock") && !/\b(package\.json|dependenc|config|script|workflow|lockfile|upgrade|install)\b/i.test(task));
  if (controlChanges.length > 0 && kind !== "inspect") {
    issues.push(issue("MEDIUM", "CONTROL_FILES_CHANGED", "Safety",
      `Test/build configuration or lockfiles changed although the request did not ask for it: ${controlChanges.map((c) => c.path).join(", ")}.`,
      `workspace changes: ${controlChanges.map((c) => `${c.status}:${c.path}`).join(", ")}`,
      "Confirm the configuration change was required; altering test or build configuration can mask failures."));
    downgrade("unverified", "unrequested configuration change");
  }

  // ── Universal: agent-reported writes that changed nothing ─────────────────
  const changedPaths = new Set(changes.map((c) => c.path));
  const noOps = (input.filesChanged ?? []).filter((f) => f.changeType !== "D" && !changedPaths.has(f.path.replace(/\\/g, "/").replace(/^\.\//, "")));
  if (noOps.length > 0) {
    issues.push(issue("LOW", "NO_OP_WRITE", "Consistency",
      `Reported writes left these files unchanged: ${noOps.map((f) => f.path).join(", ")}.`,
      "agent-reported filesChanged vs workspace snapshot", "No action needed."));
  }

  // ── Task-specific evidence ────────────────────────────────────────────────
  const events = [...(input.priorToolEvents ?? []), ...(input.toolEvents ?? [])];
  const runs = collectTestRuns(events, workspace.testRuns, workspace.testCommand);
  const lastChange = lastMutationIndex(events);
  const receipts: BehaviouralReceipt[] = [];
  const requirementText = [task, ...(input.goals ?? [])].join("\n");
  const requirementTerms = distinctiveTerms(requirementText);
  const requirementSymbols = extractCriterionSymbols(requirementText);
  /** Content of test files that exist on disk after the run (what a final suite actually executed). */
  const finalTestContent = testChanges.filter((c) => c.status !== "deleted").map((c) => c.after ?? "").join("\n");

  const requireSourceChange = (code: string, what: string) => {
    if (sourceChanges.length > 0) return true;
    const claimed = (input.filesChanged ?? []).map((f) => f.path).filter((p) => !isTestPath(p));
    issues.push(issue("HIGH", code, "Proof",
      claimed.length > 0
        ? `No source file differs from its starting content; files reported as written (${claimed.join(", ")}) are unchanged on disk, so ${what}.`
        : `No source file was changed, so ${what}.`,
      `workspace changes: ${changes.map((c) => `${c.status}:${c.path}`).join(", ") || "none"}`,
      "Make the change in the source code; rewriting a file with identical content is not a change."));
    downgrade("contradicted", "no real source change");
    return false;
  };

  /** Full-suite receipt after the last change: returns the final run, or records why there is none. */
  const finalFullRun = (prefix: string, missingSeverity: "MEDIUM" | "HIGH" = "HIGH"): TestRun | null => {
    const fullRuns = runs.filter((r) => r.fullSuite);
    // Host-observed state wins; event ordering is the fallback when the runtime could not fingerprint.
    const finalRuns = fullRuns.filter((r) => r.sourceState === "final" || (r.sourceState === "unknown" && r.index > lastChange));
    const after = runs.filter((r) => r.sourceState === "final" || (r.sourceState === "unknown" && r.index > lastChange));
    if (finalRuns.length === 0) {
      if (after.length > 0) {
        issues.push(issue(missingSeverity, `${prefix}_TEST_SUBSET_ONLY`, "Proof",
          `${UNVERIFIED}only a subset of the tests was run after the last change (${after.map((r) => r.command).join("; ")}); a passing subset does not show the full suite passes.`,
          `test runs after last change: ${after.map((r) => r.command).join("; ")}`,
          `Run the full test suite${workspace.testCommand ? ` (${workspace.testCommand})` : ""} after the change.`));
      } else if (fullRuns.length > 0) {
        issues.push(issue(missingSeverity, `${prefix}_TESTS_NOT_RERUN`, "Proof",
          `${UNVERIFIED}the full test suite was not run again after the last change, so the final code is untested.`,
          `last change at tool event #${lastChange}; full runs: ${fullRuns.map((r) => `#${r.index} (${r.sourceState})`).join(", ")}`,
          "Re-run the full test suite after the final change."));
      } else {
        issues.push(issue(missingSeverity, `${prefix}_TEST_RECEIPT_MISSING`, "Proof",
          `${UNVERIFIED}no test run was recorded, so there is no independent evidence the change works.`,
          `test runs: ${runs.length}`,
          `Run the full test suite${workspace.testCommand ? ` (${workspace.testCommand})` : ""} after the change.`));
      }
      downgrade("unverified", "no full-suite test receipt after the last change");
      return null;
    }
    const final = finalRuns[finalRuns.length - 1]!;
    const counts = parseTestCounts(final.output);
    if (!counts || counts.total === 0) {
      issues.push(issue("HIGH", `${prefix}_TEST_RESULT_UNREADABLE`, "Proof",
        `${UNREADABLE}the final test run (${final.command}) produced no recognisable test summary, so its result cannot be verified.`,
        `output excerpt: ${final.output.slice(0, 200) || "(none recorded)"}`,
        "Run the project's test command without truncating or filtering its output."));
      downgrade("uninterpretable", "final test output unreadable");
      return null;
    }
    if (!final.ok || counts.failed > 0 || (final.exitCode !== undefined && final.exitCode !== 0)) {
      issues.push(issue("HIGH", `${prefix}_TESTS_FAILING`, "Proof",
        `The final full test run failed: ${counts.failed} of ${counts.total} tests failing${final.ok ? "" : " (non-zero exit)"}.`,
        `${final.command}: total=${counts.total} passed=${counts.passed} failed=${counts.failed} ok=${final.ok} exit=${final.exitCode ?? "?"}`,
        "Fix the code until the full test suite passes."));
      downgrade("contradicted", "final test suite failing");
      return null;
    }
    const earlierTotals = runs.filter((r) => r.fullSuite && r.index < final.index).map((r) => parseTestCounts(r.output)?.total ?? 0);
    const maxEarlier = Math.max(0, ...earlierTotals);
    if (counts.total < maxEarlier) {
      issues.push(issue("CRITICAL", `${prefix}_TEST_COUNT_DROPPED`, "Safety",
        `The final run executed ${counts.total} tests, fewer than the ${maxEarlier} an earlier full run executed.`,
        `${final.command}: total=${counts.total}; earlier max=${maxEarlier}`,
        "Restore the missing tests; the suite must not shrink to pass."));
      downgrade("contradicted", "test count dropped");
      return null;
    }
    testEvidence = true;
    return final;
  };

  /** Tests added on disk (new file, or new cases/assertions in an existing one) that the final suite then ran. */
  const regressionTestReceipt = (final: TestRun): BehaviouralReceipt | null => {
    const added = testChanges.filter((c) => {
      if (c.status === "deleted" || !c.after) return false;
      const after = testShape(c.after);
      if (after.cases === 0 || after.assertions === 0) return false;
      if (c.status === "added") return true;
      const before = testShape(c.before ?? "");
      return after.cases > before.cases || after.assertions > before.assertions;
    });
    if (added.length === 0) return null;
    return {
      kind: "regression_test",
      command: final.command,
      sourceState: final.sourceState,
      text: `${added.map((c) => c.after).join("\n")}\n${final.output}`.toLowerCase(),
      coversTask: false,
      summary: `tests added in ${added.map((c) => c.path).join(", ")} and executed by ${final.command} on the final source (${parseTestCounts(final.output)?.total ?? "?"} tests passing)`,
    };
  };

  /** Whether command output names what the request is about (never a bare success, never just a file name). */
  const relevantToRequest = (text: string): { relevant: boolean; matched: string[] } => {
    const lower = withoutFilePaths(text).toLowerCase();
    const symbols = requirementSymbols.filter((s) => lower.includes(s.toLowerCase()));
    const terms = matchedTerms(lower, requirementTerms);
    const relevant = symbols.length > 0 || terms.length >= 2 || (requirementTerms.length <= 2 && terms.length >= 1);
    return { relevant, matched: [...new Set([...symbols, ...terms])] };
  };

  /** Host-recorded commands that ran after the last change and succeeded with readable output. */
  const commandsAfterLastChange = (): Array<{ index: number; command: string; output: string; exitCode?: number; ok: boolean }> => {
    const out: Array<{ index: number; command: string; output: string; exitCode?: number; ok: boolean }> = [];
    events.forEach((event, index) => {
      if (index <= lastChange) return;
      const raw = rawRecord(event);
      const command = typeof raw["command"] === "string" ? raw["command"].trim() : "";
      if (!command || !/(?:run_command|execute_command|start_process|shell)/i.test(event.tool)) return;
      const output = typeof raw["_outputForProof"] === "string" ? raw["_outputForProof"] : "";
      const exitCode = typeof raw["_exitCodeForProof"] === "number" ? raw["_exitCodeForProof"] : undefined;
      out.push({ index, command, output, exitCode, ok: event.ok });
    });
    return out;
  };

  /**
   * An explicitly documented alternative verification: the account names the
   * method, the named command really ran after the last change, succeeded with
   * readable output, and that output is about the request. The same command
   * run before the first source change with a different or failing result
   * makes it a before-and-after receipt.
   */
  const documentedAlternative = (): BehaviouralReceipt | { rejected: string } | null => {
    const statements = [...(input.outputText ?? "").matchAll(ALTERNATIVE_VERIFICATION)].map((m) => m[1]!.trim());
    if (statements.length === 0) return null;
    const candidates = commandsAfterLastChange();
    let rejected = "the documented method does not name a command that ran after the last change";
    for (const statement of statements) {
      const cited = candidates.filter((c) => statement.includes(c.command) || statement.includes(c.command.split(/\s+/)[0]!));
      for (const c of cited) {
        if (!c.ok || (c.exitCode !== undefined && c.exitCode !== 0)) { rejected = `the cited command failed (${c.command})`; continue; }
        if (!c.output.trim()) { rejected = `the cited command produced no output to judge (${c.command})`; continue; }
        const { relevant, matched } = relevantToRequest(`${c.command}\n${c.output}`);
        if (!relevant) { rejected = `the cited command's output does not mention what the request is about (${c.command})`; continue; }
        const firstSourceChange = firstSourceMutationIndex(events);
        const before = events.slice(0, firstSourceChange).find((e) => {
          const raw = rawRecord(e);
          return typeof raw["command"] === "string" && normalizeCommand(raw["command"]) === normalizeCommand(c.command);
        });
        const beforeOutput = before ? String(rawRecord(before)["_outputForProof"] ?? "") : "";
        const beforeAndAfter = !!before && (!before.ok || beforeOutput !== c.output);
        return {
          kind: beforeAndAfter ? "reproduction" : "validation_command",
          command: c.command,
          sourceState: "unknown",
          text: `${c.command}\n${c.output}`.toLowerCase(),
          coversTask: true,
          summary: `${beforeAndAfter ? "before-and-after" : "documented"} verification: ${c.command} ran after the last change (exit ${c.exitCode ?? 0}), output names ${matched.slice(0, 4).join(", ")}${beforeAndAfter ? "; the same command gave a different result before the source changed" : ""}`,
        };
      }
    }
    return { rejected };
  };

  /** A build or type check that ran after the last change and passed. */
  const buildCheckReceipt = (): BehaviouralReceipt | null => {
    const c = commandsAfterLastChange().find((x) => BUILD_CHECK_COMMAND.test(x.command) && x.ok && (x.exitCode === undefined || x.exitCode === 0));
    if (!c) return null;
    return { kind: "build_check", command: c.command, sourceState: "unknown", text: `${c.command}\n${c.output}`.toLowerCase(), coversTask: true,
      summary: `build/type check passed after the last change: ${c.command}` };
  };

  const behaviourMissing = (code: string, what: string, howTo: string) => {
    issues.push(issue("HIGH", code, "Proof", `${UNVERIFIED}${what}`, `behavioural receipts on the final source: none; test runs: ${runs.length}; commands after last change: ${commandsAfterLastChange().map((c) => c.command).join("; ") || "none"}`, howTo));
    downgrade("unverified", "no behavioural evidence on the final source");
  };

  // "Do not modify the existing tests" is a prohibition, not a request for a test run.
  const testsExpected = MENTIONS_TESTS.test(withoutProhibitions(task)) || (!!workspace.testCommand && codeChanges.length > 0);

  switch (kind) {
    case "bugfix": {
      if (!requireSourceChange("FIX_SOURCE_CHANGE_MISSING", "the reported bug cannot have been fixed in the code")) break;
      if (testsExpected) {
        const final = finalFullRun("FIX");
        if (!final) break;
        // Reproduction: a run on the task-start source that showed failures, whose
        // failing tests pass in the final run.
        const firstSourceChange = firstSourceMutationIndex(events);
        const reproductions = runs
          .filter((r) => r.sourceState === "baseline" || (r.sourceState === "unknown" && r.index < firstSourceChange))
          .map((r) => ({ run: r, counts: parseTestCounts(r.output), failing: parseFailingTests(r.output) }))
          .filter((x) => (x.counts?.failed ?? 0) > 0 || x.failing.length > 0);
        const finalPassing = new Set(parseFailingTests(final.output));
        const resolved = reproductions.find((x) =>
          x.failing.length > 0 ? x.failing.every((name) => final.output.includes(name) && !finalPassing.has(name)) : true);
        const regression = regressionTestReceipt(final);
        if (regression) receipts.push(regression);
        if (resolved) {
          receipts.push({ kind: "reproduction", command: final.command, sourceState: final.sourceState, text: `${final.output}\n${finalTestContent}`.toLowerCase(), coversTask: true,
            summary: `reproduced then resolved: ${resolved.failing.length > 0 ? resolved.failing.join("; ") : `${resolved.counts?.failed ?? "?"} failing test(s)`} failed on the task-start source and the full suite (${final.command}) passes on the final source` });
        } else {
          // Reproduction is required evidence only when the user asked for the
          // problem to be verified as resolved; otherwise the passing suite on
          // the final source is the behavioural receipt, with a note.
          const asked = ASKS_VERIFICATION.test(task);
          issues.push(issue(asked ? "HIGH" : "LOW", "FIX_REPRODUCTION_MISSING", "Proof",
            `${asked ? UNVERIFIED : ""}${reproductions.length > 0
              ? "tests that failed before the fix do not all appear as passing in the final run."
              : "no test run showed the reported failure before the source was changed, so the passing suite is not shown to cover the reported bug."}`,
            `runs before first source change: ${runs.filter((r) => r.sourceState === "baseline" || r.index < firstSourceChange).length}; failing tests before: ${reproductions.flatMap((x) => x.failing).join("; ") || "none"}`,
            "Run the tests before changing the code to show the failure, then again after the fix."));
          if (asked) downgrade("unverified", "reported failure not reproduced before the fix");
          else receipts.push({ kind: "full_suite", command: final.command, sourceState: final.sourceState, text: `${final.output}\n${finalTestContent}`.toLowerCase(), coversTask: true,
            summary: `full suite (${final.command}) passes on the final source: ${parseTestCounts(final.output)?.total ?? "?"} tests` });
        }
        break;
      }
      // No test suite to run: the fix needs an explicitly documented, recorded,
      // relevant verification. A source edit alone is not a behavioural receipt.
      const alt = documentedAlternative();
      if (alt && !("rejected" in alt)) { receipts.push(alt); reasons.push(`no test command in the workspace: ${alt.summary}`); break; }
      behaviourMissing("FIX_BEHAVIOUR_EVIDENCE_MISSING",
        `the source changed, but nothing recorded shows the reported defect is resolved: no test ran and ${alt ? alt.rejected : "no verification method was documented"}. A modified file does not prove a correction.`,
        "Run a test that reproduces the defect before and after the fix, or add a line \"Alternative verification: <command you ran after the fix>\" whose recorded output shows the corrected behaviour.");
      break;
    }
    case "refactor": {
      if (!requireSourceChange("REFACTOR_SOURCE_CHANGE_MISSING", "nothing was refactored")) break;
      if (testsExpected) {
        const final = finalFullRun("REFACTOR");
        if (!final) break;
        const baseline = runs.find((r) => r.fullSuite && r.sourceState === "baseline" && parseTestCounts(r.output)?.failed === 0);
        receipts.push({ kind: "full_suite", command: final.command, sourceState: final.sourceState, text: `${final.output}\n${finalTestContent}`.toLowerCase(), coversTask: true,
          summary: `full suite (${final.command}) passes on the final source: ${parseTestCounts(final.output)?.total ?? "?"} tests${baseline ? ", the same suite passed on the task-start source" : ""}` });
        break;
      }
      // No test suite: a passing build/type check or a documented equivalence
      // check stands in, and the status says runtime equivalence was not shown.
      const alt = documentedAlternative();
      if (alt && !("rejected" in alt)) { receipts.push(alt); reasons.push(`no test command in the workspace: ${alt.summary}`); break; }
      const build = buildCheckReceipt();
      if (build) {
        receipts.push(build);
        reasons.push(`no test command in the workspace: ${build.summary}; runtime equivalence is not shown by tests`);
        issues.push(issue("LOW", "REFACTOR_RUNTIME_EQUIVALENCE_NOT_SHOWN", "Proof",
          `The refactor is verified by a build/type check only (${build.command}); no test shows the runtime behaviour is unchanged.`,
          build.summary, "Add or run a test that exercises the refactored code if behavioural equivalence matters here."));
        break;
      }
      behaviourMissing("REFACTOR_BEHAVIOUR_EVIDENCE_MISSING",
        `the source changed, but nothing recorded shows the behaviour is preserved: no test, build or type check ran after the change${alt ? ` and ${alt.rejected}` : ""}.`,
        "Run the test suite, a build/type check, or a documented equivalence check after the refactor.");
      break;
    }
    case "feature": {
      if (!requireSourceChange("FEATURE_CHANGE_MISSING", "the requested behaviour was not implemented")) break;
      let final: TestRun | null = null;
      if (testsExpected) {
        final = finalFullRun("FEATURE");
        if (!final) break;
        const regression = regressionTestReceipt(final);
        if (regression) receipts.push(regression);
        receipts.push({ kind: "full_suite", command: final.command, sourceState: final.sourceState, text: `${final.output}\n${finalTestContent}`.toLowerCase(), coversTask: false,
          summary: `full suite (${final.command}) passes on the final source: ${parseTestCounts(final.output)?.total ?? "?"} tests` });
      }
      const alt = documentedAlternative();
      if (alt && !("rejected" in alt)) receipts.push(alt);
      // A passing suite shows no regression; the feature itself must be exercised
      // by something that names it: a test, or a documented validation command.
      const exercised = receipts.some((r) => r.coversTask || relevantToRequest(r.text).relevant);
      if (!exercised) {
        behaviourMissing("FEATURE_BEHAVIOUR_EVIDENCE_MISSING",
          final
            ? `the implementation is on disk and the existing suite passes, but nothing recorded exercises the requested functionality (${[...requirementSymbols, ...requirementTerms].slice(0, 5).join(", ")}): the presence of the code is not evidence that it works.`
            : `the implementation is on disk, but no test or documented validation ran after the change${alt && "rejected" in alt ? ` and ${alt.rejected}` : ""}: the presence of the code is not evidence that it works.`,
          "Add a test with assertions for the requested behaviour and run the suite, or add a line \"Alternative verification: <command you ran after the change>\" whose recorded output shows the feature working.");
      }
      break;
    }
    case "docs": {
      const docsAfter = docsChanges.filter((c) => c.status !== "deleted");
      if (docsAfter.length === 0) {
        issues.push(issue("HIGH", "DOCS_CHANGE_MISSING", "Proof",
          "No documentation file was changed, so the requested documentation work was not done.",
          `workspace changes: ${changes.map((c) => `${c.status}:${c.path}`).join(", ") || "none"}`,
          "Make the requested documentation change."));
        downgrade("contradicted", "no documentation change");
      } else {
        // The final content on disk must carry what was asked for; the worker's
        // description of the edit is not evidence of the document's contents.
        const content = docsAfter.map((c) => c.after ?? "").join("\n");
        const { covered, matched, terms } = textCoversRequirement(content, requirementText);
        if (!docsAfter.some((c) => typeof c.after === "string")) {
          issues.push(issue("HIGH", "DOCS_CONTENT_UNREADABLE", "Proof",
            `${UNREADABLE}the changed documentation (${docsAfter.map((c) => c.path).join(", ")}) has no captured content to check against the request.`,
            `workspace changes: ${docsAfter.map((c) => `${c.status}:${c.path}`).join(", ")}`, "Keep documentation files small enough for the runtime to capture."));
          downgrade("uninterpretable", "documentation content not captured");
        } else if (!covered) {
          issues.push(issue("HIGH", "DOCS_CONTENT_MISSING", "Proof",
            `${UNVERIFIED}the documentation changed, but its final content does not cover what was requested (missing: ${terms.filter((t) => !matched.includes(t)).slice(0, 6).join(", ") || "the requested item"}).`,
            `final content of ${docsAfter.map((c) => c.path).join(", ")} matched ${matched.length}/${terms.length} requested terms: ${matched.join(", ") || "none"}`,
            "Write the requested item into the document itself."));
          downgrade("unverified", "documentation content does not cover the request");
        } else {
          receipts.push({ kind: "final_content", command: "", sourceState: "final", text: content.toLowerCase(), coversTask: true,
            summary: `final content of ${docsAfter.map((c) => c.path).join(", ")} covers the request (${matched.slice(0, 5).join(", ")})` });
        }
      }
      if (codeChanges.length > 0) {
        issues.push(issue("MEDIUM", "DOCS_UNREQUESTED_SOURCE_CHANGE", "Safety",
          `Source files changed during a documentation task: ${codeChanges.map((c) => c.path).join(", ")}.`,
          `workspace changes: ${codeChanges.map((c) => `${c.status}:${c.path}`).join(", ")}`,
          "Keep documentation tasks to documentation files, or confirm the source change was intended."));
        downgrade("unverified", "unrequested source change");
      }
      break;
    }
    case "inspect": {
      // Any real modification contradicts a request that asked only for analysis.
      const real = changes.filter((c) => c.kind !== "other" || c.status !== "added");
      if (real.length > 0) {
        issues.push(issue("HIGH", "INSPECT_UNREQUESTED_CHANGE", "Safety",
          `Files changed although the request only asked for inspection or explanation: ${real.map((c) => c.path).join(", ")}.`,
          `workspace changes: ${real.map((c) => `${c.status}:${c.path}`).join(", ")}`,
          "Do not modify files when the user only asked for analysis."));
        downgrade("contradicted", "files modified during an inspection-only request");
      }
      break;
    }
    default:
      break;
  }

  if (status === "verified" && reasons.length === 0) reasons.push(kind === "inspect" || kind === "other" ? "no unexpected workspace changes" : "evidence consistent with the request");
  const verification: VerificationStatus = { status, taskKind: kind, reasons, testEvidence };
  if (receipts.length > 0) verification.behaviouralEvidence = receipts.map((r) => r.summary);
  return { issues, verification, receipts };
}
