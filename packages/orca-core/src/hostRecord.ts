/**
 * The host's record of what a task did — built from evidence the runtime
 * captured (workspace inventory, host-observed tool events per pass, test runs
 * with their source state), never from a worker's account.
 *
 * Found in live rehearsal A6: the first pass fixed src/parse.js but did not
 * re-run the tests; Pappy asked for verification; the repair worker was told
 * only Pappy's issues, found the fix already on disk, and reported that "the
 * fix was already in place — someone had corrected parse.js in a prior
 * session". The final message repeated it. Two uses here:
 *
 *   - a repair worker gets a compact account of what earlier passes changed
 *     and which tests ran on which source, and what is actually outstanding;
 *   - the final explanation is checked against the record: a statement that a
 *     change pre-existed, came from someone else, or was made in a pass that
 *     made no such change is corrected from the record (or the uncertainty is
 *     stated). Attribution is never invented: a change with no host-recorded
 *     write is "origin unknown".
 */
import { isAbsolute, relative, resolve } from "node:path";
import type { WorkspaceEvidence } from "@clawde/pappy-core";
import type { OrcaToolEvent } from "./types.js";

/** One worker pass of the task and the tool events the host recorded for it. */
export interface PassLogEntry {
  pass: number;
  /** "first pass", "repair pass 1", … */
  label: string;
  role?: string;
  toolEvents: readonly OrcaToolEvent[];
}

export interface HostRecordChange {
  path: string;
  status: "added" | "modified" | "deleted";
  /**
   * this_task  a write by one of this task's passes is recorded for the path
   * contested  more than one worker wrote it in the same pass
   * unknown    the file changed but no write by this task was recorded (an
   *            external change, or one Orca cannot attribute)
   */
  attribution: "this_task" | "contested" | "unknown";
  /** Pass labels whose recorded writes touched the path. */
  passes: string[];
  writers: string[];
}

export interface HostRecordTestRun {
  command: string;
  sourceState: "baseline" | "final" | "intermediate" | "unknown";
  ok: boolean;
  exitCode?: number;
  passed?: number;
  failed?: number;
}

export interface HostRecord {
  available: boolean;
  changes: HostRecordChange[];
  testRuns: HostRecordTestRun[];
  /** A full-suite run on the final source passed. */
  finalSourceTested: boolean;
  /** The task's worker passes in order ("first pass", "repair pass 1", …). */
  passLabels: string[];
  /** Plain-language account, a few lines. */
  text: string;
}

const WRITE_TOOLS = /^(write_file|edit_file|create_file|apply_patch|replace_in_file|str_replace|append_file|move_file|delete_file)$/i;
const FILE_CHANGE_MARKER = /<!--\s*Files changed:\s*([\s\S]*?)\s*-->/i;

function normalize(path: string, root: string | undefined): string {
  const absolute = root && !isAbsolute(path) ? resolve(root, path) : path;
  const rel = root && isAbsolute(absolute) ? relative(root, absolute) : path;
  const forward = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return process.platform === "win32" ? forward.toLowerCase() : forward;
}

/** Paths a tool event wrote, as the host recorded them. */
function writtenPaths(event: OrcaToolEvent): string[] {
  const raw = (event.raw ?? {}) as Record<string, unknown>;
  if (!event.ok) return [];
  if (WRITE_TOOLS.test(event.tool)) {
    return ["path", "file", "target", "destination"].map((k) => raw[k]).filter((v): v is string => typeof v === "string" && v.length > 0);
  }
  if (event.tool === "run_command") {
    const out = typeof raw["_outputForProof"] === "string" ? (raw["_outputForProof"] as string) : "";
    const m = FILE_CHANGE_MARKER.exec(out);
    if (m) {
      try {
        const list = JSON.parse(m[1]!) as Array<{ path?: unknown }>;
        return list.map((c) => c.path).filter((p): p is string => typeof p === "string");
      } catch { /* unreadable marker: nothing claimed */ }
    }
  }
  return [];
}

/** Test counts from common runners' summaries (node:test, TAP, Jest/Vitest, pytest). */
export function parseTestCounts(output: string): { passed: number; failed: number } | undefined {
  const node = /ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/.exec(output);
  if (node) return { passed: Number(node[1]), failed: Number(node[2]) };
  const tap = /^# pass (\d+)[\s\S]*?^# fail (\d+)/m.exec(output);
  if (tap) return { passed: Number(tap[1]), failed: Number(tap[2]) };
  const jest = /Tests?:\s+(?:(\d+) failed,\s*)?(?:\d+ skipped,\s*)?(\d+) passed/.exec(output);
  if (jest) return { passed: Number(jest[2]), failed: Number(jest[1] ?? 0) };
  const pytest = /(?:(\d+) failed,\s*)?(\d+) passed/.exec(output);
  if (pytest && /=+.*(passed|failed).*=+/.test(output)) return { passed: Number(pytest[2]), failed: Number(pytest[1] ?? 0) };
  return undefined;
}

const SOURCE_STATE = { baseline: "the task-start source", final: "the current source", intermediate: "an intermediate source", unknown: "an unrecorded source state" } as const;

export function buildHostRecord(evidence: WorkspaceEvidence | undefined, passLog: readonly PassLogEntry[], workspaceRoot?: string): HostRecord {
  if (!evidence || !evidence.available) {
    return { available: false, changes: [], testRuns: [], finalSourceTested: false, passLabels: passLog.map((p) => p.label), text: "Orca has no workspace record for this task, so it cannot say what changed or which tests ran." };
  }
  const contested = new Set((evidence.contested ?? []).map((c) => normalize(c.path, workspaceRoot)));
  const changes: HostRecordChange[] = evidence.changes.map((c) => {
    const key = normalize(c.path, workspaceRoot);
    const passes = passLog.filter((p) => p.toolEvents.some((e) => writtenPaths(e).some((w) => normalize(w, workspaceRoot) === key))).map((p) => p.label);
    const writers = c.writers ?? [];
    const attribution: HostRecordChange["attribution"] = contested.has(key) ? "contested" : passes.length > 0 || writers.length > 0 ? "this_task" : "unknown";
    return { path: c.path, status: c.status, attribution, passes, writers };
  });
  const testRuns: HostRecordTestRun[] = (evidence.testRuns ?? []).map((r) => {
    const counts = parseTestCounts(r.output ?? "");
    return { command: r.command, sourceState: r.sourceState, ok: r.ok, ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}), ...(counts ?? {}) };
  });
  const finalSourceTested = (evidence.testRuns ?? []).some((r) => r.sourceState === "final" && r.fullSuite && r.ok);

  const lines: string[] = ["Host record of this task so far (recorded by Orca's runtime, not any worker's account):"];
  if (changes.length === 0) lines.push("- No file in the workspace has changed since the task started.");
  for (const c of changes) {
    const who = c.attribution === "this_task"
      ? `changed by this task${c.passes.length ? ` in the ${c.passes.join(" and the ")}` : ""}${c.writers.length ? ` (${c.writers.join(", ")})` : ""}`
      : c.attribution === "contested"
        ? "written by more than one worker in the same pass: which write survived is not known"
        : "changed during the task, but no write by this task was recorded for it: its origin is unknown";
    lines.push(`- ${c.path} (${c.status}) — ${who}.`);
  }
  if (testRuns.length === 0) lines.push("- No test run was recorded.");
  else {
    const runs = testRuns.map((r) => `\`${r.command}\` on ${SOURCE_STATE[r.sourceState]}: ${r.ok ? "passed" : "failed"}${r.passed !== undefined ? ` (${r.passed} passed, ${r.failed} failed)` : r.exitCode !== undefined ? ` (exit ${r.exitCode})` : ""}`);
    lines.push(`- Test runs: ${runs.join("; ")}.`);
    if (!testRuns.some((r) => r.sourceState === "final")) lines.push("- No test has run on the current source.");
  }
  return { available: true, changes, testRuns, finalSourceTested, passLabels: passLog.map((p) => p.label), text: lines.join("\n") };
}

// ── Checking an explanation against the record ──────────────────────────────

/** Says the change was already there, or came from someone or somewhere else. */
const PRE_EXISTING = [
  /\b(?:fix|change|correction|code|implementation|guard|handling)\b[^.\n]{0,60}\b(?:was|were|is|had been)\s+already\s+(?:in place|there|present|applied|made|done|correct|fixed)/i,
  /\balready\s+(?:in place|fixed|corrected|applied|correct|implemented|present)\b/i,
  /\b(?:prior|previous|earlier|another|separate)\s+(?:session|run|conversation|developer|commit)\b/i,
  /\b(?:someone|somebody|another developer|the user|a teammate)\s+(?:else\s+)?(?:had\s+|has\s+|already\s+)*(?:fixed|corrected|changed|modified|updated|patched|edited)\b/i,
  /\b(?:nothing|no (?:code )?changes?)\s+(?:was |were )?(?:needed|required|necessary)\s+(?:changing|to be changed|to change)?/i,
  /\bno (?:code )?change(?:s)? (?:was|were) (?:needed|required|made)\b/i,
];
/** The current pass says it made the change itself. */
const SELF_CLAIM = /\b(?:I|we)\s+(?:just\s+|have\s+|then\s+)?(?:changed|modified|edited|wrote|rewrote|updated|patched|fixed|added)\b|\b(?:in\s+)?this\s+(?:repair\s+)?pass\b[^.\n]{0,40}\b(?:changed|modified|edited|wrote|fixed)\b/i;

export interface ProvenanceCheck {
  contradictions: string[];
  /** A factual paragraph to append when something in the text contradicts the record. */
  correction?: string;
}

/**
 * Compare an explanation with the host record. Only contradictions the record
 * can settle are reported; when it cannot (no record), nothing is claimed.
 */
export function checkProvenance(text: string, record: HostRecord | undefined): ProvenanceCheck {
  if (!record || !record.available || !text.trim()) return { contradictions: [] };
  const contradictions: string[] = [];
  const ours = record.changes.filter((c) => c.attribution === "this_task");
  const unknown = record.changes.filter((c) => c.attribution !== "this_task");
  if (ours.length > 0 && PRE_EXISTING.some((re) => re.test(text))) {
    contradictions.push(`the text says the change was already present or made elsewhere, but the host recorded this task writing ${ours.map((c) => c.path).join(", ")}`);
  }
  if (ours.length === 0 && unknown.length > 0 && PRE_EXISTING.slice(2, 4).some((re) => re.test(text))) {
    contradictions.push(`the text names who made the change, but Orca cannot establish who changed ${unknown.map((c) => c.path).join(", ")}`);
  }
  if (record.changes.length === 0 && /\b(?:I|we)\s+(?:changed|modified|edited|wrote|updated|patched|fixed)\b/i.test(text)) {
    contradictions.push("the text says files were changed, but the host recorded no change in the workspace");
  }
  const last = record.passLabels[record.passLabels.length - 1];
  if (last && record.passLabels.length > 1 && ours.length > 0 && SELF_CLAIM.test(text)) {
    const lastWrote = ours.some((c) => c.passes.includes(last));
    if (!lastWrote) contradictions.push(`the text credits the ${last} with the change, but the host recorded it in the ${[...new Set(ours.flatMap((c) => c.passes))].join(" and the ") || "earlier passes"}`);
  }
  if (contradictions.length === 0) return { contradictions };
  const facts: string[] = [];
  for (const c of ours) facts.push(`${c.path} was changed by this task${c.passes.length ? ` in the ${c.passes.join(" and the ")}` : ""}`);
  for (const c of unknown) facts.push(`${c.path} also changed, but Orca cannot say who changed it`);
  if (record.changes.length === 0) facts.push("no file in the workspace changed during this task");
  const finalRun = [...record.testRuns].reverse().find((r) => r.sourceState === "final");
  if (finalRun) facts.push(`\`${finalRun.command}\` ran on the final source: ${finalRun.ok ? "passed" : "failed"}${finalRun.passed !== undefined ? ` (${finalRun.passed} passed, ${finalRun.failed} failed)` : ""}`);
  else facts.push("no test run on the final source was recorded");
  return { contradictions, correction: `Correction from Orca's records: ${facts.join("; ")}.` };
}

/** Append the correction (once) when the text contradicts the record. */
export function correctProvenance(text: string, record: HostRecord | undefined): { text: string; check: ProvenanceCheck } {
  const check = checkProvenance(text, record);
  if (!check.correction || text.includes("Correction from Orca's records:")) return { text, check };
  return { text: `${text.trimEnd()}\n\n${check.correction}`, check };
}
