/**
 * Fix verification — what a "find and fix the bug" task must prove.
 *
 * Commands completing is not the same as the request being satisfied. For a
 * defect-fix task this check requires, from evidence the agent cannot author:
 *
 *   - a real source change (before/after contents from the runtime's workspace
 *     snapshot; rewriting a file with identical content is not a change)
 *   - existing tests not deleted, weakened, or — when the user said so — edited
 *   - a full-suite test run after the last change, with a readable result,
 *     zero failures, and no fewer tests than earlier full runs reported
 *   - the originally failing behaviour resolved: either an earlier failing run
 *     now passes, or the pre-existing tests are untouched and all pass
 *
 * It applies only when the runtime supplied workspace evidence (`input.workspace`);
 * if the runtime could not snapshot the workspace, a fix cannot be verified and
 * the check fails closed.
 */
import type { Issue, PappyInput, ToolEvent, WorkspaceFileChange } from "../types.js";

type RawIssue = Omit<Issue, "issueId">;

const TEST_PATH = /(^|\/)(__tests__|tests?|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/i;
const NON_SOURCE_PATH = /\.(md|markdown|txt|log|lock)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|(^|\/)\.orca[^/]*$/i;

const FIX_VERB = /\b(fix|repair|resolve|correct)\w*\b/i;
const DEFECT_NOUN = /\b(bugs?|issues?|defects?|regressions?|broken|incorrect|wrong|fail\w*|errors?|crash\w*|problems?)\b/i;
const MENTIONS_TESTS = /\btests?\b|\btest suite\b|\bspecs?\b/i;
const PROHIBITS_TEST_EDITS =
  /\b(?:do not|don't|never|must not|should not|without)\b[^.]{0,80}\b(?:modify|modifying|change|changing|edit|editing|touch|touching|alter|altering|delete|deleting|remove|removing|rewrite|rewriting|weaken|weakening|skip|skipping)\b[^.]{0,60}\btests?\b|\b(?:leave|keep)\b[^.]{0,30}\btests?\b[^.]{0,30}\b(?:unchanged|as is|intact)\b/i;

const MUTATING_TOOL = /(^|[_-])(write|edit|modify|delete|remove|move|rename|create|patch|apply|replace)([_-]|$)|edit_block/i;
const MUTATING_COMMAND = /(?:^|[\s;&|])(?:sed\s+-i|perl\s+-pi|mv|cp|rm|tee|git\s+(?:apply|checkout|restore|reset))\b|(?:^|[^\d&])>{1,2}\s*[^&\s]/i;

const TEST_COMMAND =
  /^(?:npx\s+|pnpm\s+exec\s+|yarn\s+)?(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|node\s+(?:--[\w-]+(?:=\S+)?\s+)*--test\b|vitest\b|jest\b|mocha\b|pytest\b|python3?\s+-m\s+(?:pytest|unittest)\b|go\s+test\b|cargo\s+test\b|deno\s+test\b)/i;
const NARROWING_FLAG =
  /(?:^|\s)(?:--test-name-pattern|--testNamePattern|--test-only|--grep|--only|--filter|--testPathPattern|--bail|-t|-g|-k|-x)(?=[=\s]|$)/;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path.replace(/\\/g, "/"));
}

export function isDefectFixTask(task: string): boolean {
  return FIX_VERB.test(task) && DEFECT_NOUN.test(task);
}

export function prohibitsTestEdits(task: string): boolean {
  return PROHIBITS_TEST_EDITS.test(task);
}

function count(re: RegExp, text: string): number {
  return (text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) ?? []).length;
}

export function testShape(source: string): { cases: number; assertions: number; skips: number } {
  return {
    cases:
      count(/(?:^|[^\w.$])(?:it|test)(?:\.(?:only|concurrent))?\s*\(/m, source) +
      count(/^\s*def\s+test_\w*\s*\(/m, source) +
      count(/^\s*func\s+Test\w*\s*\(/m, source),
    assertions: count(/\bexpect\s*\(|\bassert(?:\.\w+)?\s*\(|\bt\.(?:equal|deepEqual|ok|is|true|false|throws|not\w*)\s*\(|\bself\.assert\w+\s*\(/, source),
    skips: count(/\.(?:skip|todo)\s*\(|\bx(?:it|test|describe)\s*\(|@pytest\.mark\.skip|\bt\.Skip\(/, source),
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
    return { total: nodeTests, passed: pass, failed: fail };
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
  return null;
}

interface TestRun { index: number; command: string; full: boolean; ok: boolean; output: string }

function rawRecord(event: ToolEvent): Record<string, unknown> {
  return event.raw && typeof event.raw === "object" ? (event.raw as Record<string, unknown>) : {};
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+\d?>&\d\b/g, "").replace(/\s+/g, " ").trim();
}

/** The segment of a compound command (a && b; c) that runs tests, if any. */
function testSegment(command: string): string | null {
  for (const segment of command.split(/&&|;|\|\|/)) {
    const s = normalizeCommand(segment);
    if (TEST_COMMAND.test(s)) return s;
  }
  return null;
}

function isFullSuite(segment: string, projectTestCommand?: string): boolean {
  if (/\|/.test(segment)) {
    // Piping can hide the exit status; the parsed summary still decides pass/fail,
    // but only the part before the pipe is the command that ran the tests.
    segment = segment.split("|")[0]!.trim();
  }
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

function collectTestRuns(events: readonly ToolEvent[], projectTestCommand?: string): TestRun[] {
  const runs: TestRun[] = [];
  events.forEach((event, index) => {
    const raw = rawRecord(event);
    const command = typeof raw["command"] === "string" ? raw["command"] : "";
    if (!command || !/(?:run_command|execute_command|start_process|shell)/i.test(event.tool)) return;
    const segment = testSegment(command);
    if (!segment) return;
    const output = typeof raw["_outputForProof"] === "string" ? raw["_outputForProof"] : "";
    runs.push({ index, command, full: isFullSuite(segment, projectTestCommand), ok: event.ok, output });
  });
  return runs;
}

function lastMutationIndex(events: readonly ToolEvent[]): number {
  let last = -1;
  events.forEach((event, index) => {
    if (!event.ok) return;
    const raw = rawRecord(event);
    const command = typeof raw["command"] === "string" ? raw["command"] : "";
    if (MUTATING_TOOL.test(event.tool) || (command && MUTATING_COMMAND.test(command) && !testSegment(command))) {
      last = index;
    }
  });
  return last;
}

function issue(severity: Issue["severity"], code: string, category: Issue["category"], description: string, evidence: string, fix: string): RawIssue {
  return {
    severity,
    code,
    category,
    description,
    expected_receipt: fix,
    evidence,
    fix_hint: fix,
    message: description,
    suggestedFix: fix,
  };
}

export function runFixVerificationChecks(input: PappyInput): RawIssue[] {
  const workspace = input.workspace;
  if (!workspace) return [];
  const task = input.task ?? "";
  if (!isDefectFixTask(task)) return [];
  const testsExpected = MENTIONS_TESTS.test(task) || !!workspace.testCommand;

  if (!workspace.available) {
    return [issue("HIGH", "FIX_EVIDENCE_UNAVAILABLE", "Proof",
      `The workspace could not be compared before and after the run (${workspace.reason ?? "snapshot unavailable"}), so the fix cannot be verified.`,
      `workspace.available=false; reason=${workspace.reason ?? "unknown"}`,
      "Run the fix in a workspace small enough for Orca to snapshot, or verify it manually.")];
  }

  const issues: RawIssue[] = [];
  const changes = workspace.changes;
  const isSource = (c: WorkspaceFileChange) => !isTestPath(c.path) && !NON_SOURCE_PATH.test(c.path) && c.status !== "deleted";
  const sourceChanges = changes.filter(isSource);
  const testChanges = changes.filter((c) => isTestPath(c.path));
  const existingTestChanges = testChanges.filter((c) => c.status !== "added");

  // ── A real source change ─────────────────────────────────────────────────
  if (sourceChanges.length === 0) {
    const claimed = (input.filesChanged ?? []).map((f) => f.path).filter((p) => !isTestPath(p));
    issues.push(issue("HIGH", "FIX_SOURCE_CHANGE_MISSING", "Proof",
      claimed.length > 0
        ? `No source file differs from its starting content. Files reported as written (${claimed.join(", ")}) are unchanged on disk.`
        : "No source file was changed, so the reported bug cannot have been fixed in the code.",
      `workspace changes: ${changes.map((c) => `${c.status}:${c.path}`).join(", ") || "none"}`,
      "Make the correction in the source code; rewriting a file with identical content is not a fix."));
  }

  // ── Existing tests left intact ───────────────────────────────────────────
  const prohibited = prohibitsTestEdits(task);
  for (const change of existingTestChanges) {
    if (change.status === "deleted") {
      issues.push(issue("CRITICAL", "TEST_FILE_DELETED", "Safety",
        `Existing test file ${change.path} was deleted.`, `deleted: ${change.path}`,
        "Restore the deleted test file; never delete tests to make a suite pass."));
      continue;
    }
    const before = testShape(change.before ?? "");
    const after = testShape(change.after ?? "");
    if (after.cases < before.cases || after.assertions < before.assertions || after.skips > before.skips) {
      issues.push(issue("CRITICAL", "TEST_FILES_MODIFIED_WEAKENED", "Safety",
        `Existing tests in ${change.path} were weakened (test cases ${before.cases}→${after.cases}, assertions ${before.assertions}→${after.assertions}, skips ${before.skips}→${after.skips}).`,
        `before/after content comparison of ${change.path}`,
        "Restore the original tests; do not remove, skip, or loosen tests to force a pass."));
    }
  }
  if (prohibited && existingTestChanges.length > 0) {
    issues.push(issue("CRITICAL", "TEST_EDIT_PROHIBITED", "Safety",
      `The user said not to modify the existing tests, but ${existingTestChanges.map((c) => c.path).join(", ")} changed.`,
      `workspace changes: ${existingTestChanges.map((c) => `${c.status}:${c.path}`).join(", ")}`,
      "Revert the test changes and fix the source code instead."));
  }

  if (!testsExpected) return issues;

  // ── Real, full-suite test receipt after the last change ──────────────────
  const events = input.toolEvents ?? [];
  const runs = collectTestRuns(events, workspace.testCommand);
  const lastChange = lastMutationIndex(events);
  const after = runs.filter((r) => r.index > lastChange);
  const fullAfter = after.filter((r) => r.full);

  if (fullAfter.length === 0) {
    if (after.length > 0) {
      issues.push(issue("HIGH", "FIX_TEST_SUBSET_ONLY", "Proof",
        `Only a subset of the tests was run after the last change (${after.map((r) => r.command).join("; ")}). A passing subset does not prove the full suite passes.`,
        `test runs after last change: ${after.map((r) => r.command).join("; ")}`,
        `Run the full test suite${workspace.testCommand ? ` (${workspace.testCommand})` : ""} after the fix.`));
    } else if (runs.some((r) => r.full)) {
      issues.push(issue("HIGH", "FIX_TESTS_NOT_RERUN", "Proof",
        "The full test suite was not run again after the last change, so the final code is untested.",
        `last change at tool event #${lastChange}; full runs at ${runs.filter((r) => r.full).map((r) => `#${r.index}`).join(", ")}`,
        "Re-run the full test suite after the final change."));
    } else {
      issues.push(issue("HIGH", "FIX_TEST_RECEIPT_MISSING", "Proof",
        "No test run was recorded, so there is no evidence the bug is fixed.",
        `test runs: ${runs.length}`,
        `Run the full test suite${workspace.testCommand ? ` (${workspace.testCommand})` : ""} after the fix.`));
    }
    return issues;
  }

  const final = fullAfter[fullAfter.length - 1]!;
  const counts = parseTestCounts(final.output);
  if (!counts || counts.total === 0) {
    issues.push(issue("HIGH", "FIX_TEST_RESULT_UNREADABLE", "Proof",
      `The final test run (${final.command}) produced no recognisable test summary, so its result cannot be verified.`,
      `output excerpt: ${final.output.slice(0, 200) || "(none recorded)"}`,
      "Run the project's test command without truncating or filtering its output."));
    return issues;
  }
  if (!final.ok || counts.failed > 0) {
    issues.push(issue("HIGH", "FIX_TESTS_FAILING", "Proof",
      `The final full test run failed: ${counts.failed} of ${counts.total} tests failing${final.ok ? "" : " (non-zero exit)"}.`,
      `${final.command}: total=${counts.total} passed=${counts.passed} failed=${counts.failed} ok=${final.ok}`,
      "Fix the code until the full test suite passes."));
    return issues;
  }

  const earlierFull = runs.filter((r) => r.full && r.index < final.index)
    .map((r) => ({ run: r, counts: parseTestCounts(r.output) }))
    .filter((r): r is { run: TestRun; counts: TestCounts } => r.counts !== null);
  const maxEarlierTotal = Math.max(0, ...earlierFull.map((r) => r.counts.total));
  if (counts.total < maxEarlierTotal) {
    issues.push(issue("CRITICAL", "FIX_TEST_COUNT_DROPPED", "Safety",
      `The final run executed ${counts.total} tests, fewer than the ${maxEarlierTotal} an earlier full run executed.`,
      `${final.command}: total=${counts.total}; earlier max=${maxEarlierTotal}`,
      "Restore the missing tests; the suite must not shrink to pass."));
  }

  // ── The originally failing behaviour is resolved ─────────────────────────
  const reproducedEarlier = earlierFull.some((r) => r.counts.failed > 0 || !r.run.ok);
  const testsUntouched = existingTestChanges.length === 0;
  if (!reproducedEarlier && !testsUntouched) {
    issues.push(issue("MEDIUM", "FIX_REPRODUCTION_UNPROVEN", "Proof",
      "Existing tests were changed and no earlier run showed the failure, so it is unproven that the passing suite covers the reported bug.",
      `earlier full runs: ${earlierFull.length}; changed tests: ${existingTestChanges.map((c) => c.path).join(", ")}`,
      "Run the tests before the fix to show the failure, then again after."));
  }

  // Agent-reported writes that left the file unchanged are not changes.
  const changedPaths = new Set(changes.map((c) => c.path));
  const noOps = (input.filesChanged ?? []).filter((f) => f.changeType !== "D" && !changedPaths.has(f.path.replace(/\\/g, "/")));
  if (noOps.length > 0 && sourceChanges.length > 0) {
    issues.push(issue("LOW", "NO_OP_WRITE", "Consistency",
      `Reported writes left these files unchanged: ${noOps.map((f) => f.path).join(", ")}.`,
      "agent-reported filesChanged vs workspace snapshot", "No action needed."));
  }

  return issues;
}
