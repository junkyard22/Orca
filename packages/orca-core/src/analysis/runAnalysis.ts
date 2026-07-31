/**
 * runAnalysis.ts — Execution record writer for every Orca run.
 *
 * Produces two artifacts in a per-run directory:
 *   run-analysis.md    — human-readable structured transcript
 *   run-events.json    — machine-readable event stream
 *
 * Data sources (all real runtime events — no fabrication):
 *   OrcaPipelineTrace  — the recordTrace() entries already written in runtime.ts
 *                        covers: task received, workspace, permissions, dewey brief,
 *                        miranda checkpoints, maestro start/result, QC start/result,
 *                        repair passes, task completed/aborted/error
 *   OrcaEvent stream   — emitter events buffered via runtime.on()
 *                        covers: role start/done, agent loop iterations, subagents,
 *                        pipeline:summary with full AC + issues table
 *
 * Integration:
 *   createRunAnalysisWriter(outDir) → returns a writeTrace function you can
 *   pass directly to createOrcaRuntime({ writeTrace }).
 *   The returned function also exposes .attachRuntime(runtime) so it can
 *   subscribe to OrcaEvents during the run.
 *
 * Redaction:
 *   Secrets (API keys, bearer tokens, etc.) are stripped by default.
 *   Set ORCA_FULL_TRACE=true to disable redaction for local debugging.
 *
 * No fake thoughts. No simulated introspection. Only recorded events.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { OrcaPipelineTrace, OrcaPipelineTraceEntry, OrcaRuntime, OrcaEvent } from "../types.js";
import { redactValue, isFullTraceMode } from "./redact.js";

// ---------------------------------------------------------------------------
// Profiling emitter (inert unless ORCA_PROFILE=1 installed a hook)
//
// scripts/profiling/emit.ts documents a `trace_write` phase, but nothing ever
// emitted one, so the cost of writing these artifacts fell into the profiler's
// unattributed "other" bucket.
// ---------------------------------------------------------------------------

type OrcaProfileEvent = Record<string, unknown>;
type OrcaProfileEmitter = (event: OrcaProfileEvent) => void;

function emitOrcaProfileEvent(event: OrcaProfileEvent): void {
  const emitter = (globalThis as typeof globalThis & {
    __orcaProfileEmit?: OrcaProfileEmitter;
  }).__orcaProfileEmit;
  emitter?.(event);
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export interface RunAnalysisWriter {
  /**
   * Call this immediately after createOrcaRuntime() to subscribe to events.
   * Must be called before executeTask() runs or events will be missed.
   */
  attachRuntime(runtime: OrcaRuntime): void;

  /**
   * Pass this directly to createOrcaRuntime({ writeTrace }).
   * Called automatically by orca-core after every task completes or aborts.
   */
  writeTrace(trace: OrcaPipelineTrace): Promise<void>;
}

/**
 * Creates a RunAnalysisWriter that writes artifacts to:
 *   <outDir>/<runId>/run-analysis.md
 *   <outDir>/<runId>/run-events.json
 *
 * @param outDir  Directory that will contain per-run sub-folders.
 *                Created automatically if it doesn't exist.
 */
export function createRunAnalysisWriter(outDir: string): RunAnalysisWriter {
  // Buffered events per taskId - populated via runtime.on() before writeTrace fires
  const eventBuffer = new Map<string, OrcaEvent[]>();

  function bufferEvent(event: OrcaEvent): void {
    const taskId = "taskId" in event ? (event as { taskId: string }).taskId : null;
    if (!taskId) return;
    if (!eventBuffer.has(taskId)) eventBuffer.set(taskId, []);
    eventBuffer.get(taskId)!.push(event);
  }

  return {
    attachRuntime(runtime: OrcaRuntime): void {
      // Subscribe to every event type that carries useful trace information.
      // stream:token is excluded — too verbose, not structural.
      const types: Array<OrcaEvent["type"]> = [
        "task:start",
        "maestro:start",
        "maestro:done",
        "maestro:agent_start",
        "maestro:agent_done",
        "maestro:thought",
        "qc:result",
        "repair:start",
        "task:done",
        "dewey:brief",
        "miranda:checkpoint",
        "subagent:spawned",
        "subagent:done",
        "subagent:failed",
        "pipeline:summary",
      ];
      for (const type of types) {
        runtime.on(type, bufferEvent);
      }
    },

    async writeTrace(trace: OrcaPipelineTrace): Promise<void> {
      const profStart = Date.now();
      const fullTrace = isFullTraceMode();
      const safeTrace = fullTrace
        ? trace
        : (redactValue(trace) as OrcaPipelineTrace);

      const events = eventBuffer.get(trace.taskId) ?? [];
      const safeEvents = fullTrace ? events : (redactValue(events) as OrcaEvent[]);

      // Clean up buffer immediately — we no longer need it
      eventBuffer.delete(trace.taskId);

      const runDir = path.join(outDir, trace.taskId);
      fs.mkdirSync(runDir, { recursive: true });

      const mdPath = path.join(runDir, "run-analysis.md");
      const jsonPath = path.join(runDir, "run-events.json");

      // Write JSON first (raw data) then Markdown (rendered view)
      fs.writeFileSync(
        jsonPath,
        JSON.stringify({ trace: safeTrace, events: safeEvents }, null, 2),
        "utf-8",
      );

      const md = renderMarkdown(safeTrace, safeEvents);
      fs.writeFileSync(mdPath, md, "utf-8");

      emitOrcaProfileEvent({
        phase: "trace_write",
        durationMs: Date.now() - profStart,
        taskId: trace.taskId,
        entryCount: trace.entries?.length ?? 0,
        eventCount: safeEvents.length,
        // Redaction walks the whole trace, so it is a plausible cost centre and
        // worth being able to correlate against.
        redacted: !fullTrace,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function renderMarkdown(trace: OrcaPipelineTrace, events: OrcaEvent[]): string {
  const lines: string[] = [];

  const fr = trace.finalResult;
  const statusIcon = !fr
    ? "⚪"
    : fr.status === "SUCCESS"
    ? "✅"
    : fr.status === "WARN"
    ? "⚠️"
    : fr.status === "ABORTED"
    ? "🚫"
    : "❌";

  // ── Header ──────────────────────────────────────────────────────────────────
  lines.push(`# Run Analysis — ${trace.taskId}`);
  lines.push("");
  lines.push(`> Generated: ${new Date().toISOString()}`);
  lines.push(`> Status: ${statusIcon} ${fr?.status ?? "UNKNOWN"}`);
  lines.push("");

  // ── Summary table ──────────────────────────────────────────────────────────
  lines.push("## Summary");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  lines.push(`| Run ID | \`${trace.taskId}\` |`);
  lines.push(`| Created | ${trace.createdAt} |`);
  lines.push(`| Status | ${fr?.status ?? "—"} |`);
  lines.push(`| Role | ${fr?.role ?? "—"} |`);
  lines.push(`| QC Verdict | ${fr?.qcVerdict ?? "—"} |`);
  lines.push(`| Issue Count | ${fr?.issueCount ?? "—"} |`);
  lines.push(`| Repair Passes | ${fr?.repairPasses ?? 0} |`);
  lines.push(`| Duration | ${fr?.durationMs != null ? `${fr.durationMs}ms` : "—"} |`);
  lines.push("");

  // ── User Request ────────────────────────────────────────────────────────────
  lines.push("## User Request");
  lines.push("");
  lines.push("```");
  lines.push(trace.task.originalUserMessage ?? "(empty)");
  lines.push("```");
  lines.push("");

  // ── TaskSpec ────────────────────────────────────────────────────────────────
  lines.push("## Normalized TaskSpec");
  lines.push("");
  lines.push(`**Intent:** ${trace.task.intent}`);
  lines.push("");
  if (trace.task.goals?.length) {
    lines.push("**Goals:**");
    for (const g of trace.task.goals) {
      lines.push(`- ${g}`);
    }
    lines.push("");
  }
  if (trace.task.permissions) {
    const p = trace.task.permissions;
    lines.push("**Permissions:**");
    lines.push(`- fileRead: ${p.fileRead}`);
    lines.push(`- fileWrite: ${p.fileWrite}`);
    lines.push(`- shellExec: ${p.shellExec}`);
    if (p.toolsAllowed?.length) {
      lines.push(`- toolsAllowed: ${p.toolsAllowed.join(", ")}`);
    }
    lines.push("");
  }

  // ── Dewey Brief ─────────────────────────────────────────────────────────────
  const deweyEntry = findTraceEntry(trace.entries, "dewey.brief");
  if (deweyEntry) {
    lines.push("## Dewey Pre-flight Brief");
    lines.push("");
    const d = deweyEntry.detail as {
      userName?: string;
      suggestedTone?: string;
      relevantPreferences?: string[];
      relevantContext?: string[];
    } | null;
    if (d) {
      if (d.userName) lines.push(`**User:** ${d.userName}`);
      if (d.suggestedTone) lines.push(`**Tone:** ${d.suggestedTone}`);
      if (d.relevantPreferences?.length) {
        lines.push("**Preferences:**");
        for (const p of d.relevantPreferences) lines.push(`- ${p}`);
      }
      if (d.relevantContext?.length) {
        lines.push("**Context signals:**");
        for (const c of d.relevantContext) lines.push(`- ${c}`);
      }
    }
    lines.push("");
  }

  // ── Workspace Context ────────────────────────────────────────────────────────
  const wsEntry = findTraceEntry(trace.entries, "workspace.context");
  if (wsEntry?.detail) {
    lines.push("## Workspace Context");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(wsEntry.detail, null, 2));
    lines.push("```");
    lines.push("");
  }

  // ── Maestro Runs ────────────────────────────────────────────────────────────
  const maestroStartEntries = filterTraceEntries(trace.entries, (e) =>
    e.stage === "maestro.run.start",
  );
  const maestroResultEntries = filterTraceEntries(trace.entries, (e) =>
    e.stage === "maestro.run.result",
  );

  if (maestroStartEntries.length > 0) {
    lines.push("## Maestro Execution");
    lines.push("");

    for (let i = 0; i < maestroStartEntries.length; i++) {
      const startEntry = maestroStartEntries[i];
      const resultEntry = maestroResultEntries[i];
      const startData = startEntry?.detail as { attempt?: number; isRepair?: boolean } | null;
      const isRepair = startData?.isRepair ?? false;
      const attempt = startData?.attempt ?? i;

      const passLabel = isRepair ? `Repair Pass #${attempt}` : "Initial Pass";
      lines.push(`### ${passLabel}`);
      lines.push(`_at: ${startEntry?.at ?? "—"}_`);
      lines.push("");

      // Agent start / done events for this pass
      const agentStart = findEvent(events, "maestro:agent_start");
      const agentDone = findEvent(events, "maestro:agent_done");
      if (agentStart) {
        const e = agentStart as Extract<OrcaEvent, { type: "maestro:agent_start" }>;
        lines.push(`**Role:** ${e.role}`);
        if (e.doneCriteria?.length) {
          lines.push("**Done Criteria:**");
          for (const c of e.doneCriteria) lines.push(`- ${c}`);
        }
        lines.push("");
      }

      if (agentDone) {
        const e = agentDone as Extract<OrcaEvent, { type: "maestro:agent_done" }>;
        lines.push(`**Stopped because:** ${e.stoppedBecause}  |  **Iterations:** ${e.iterations}`);
        if (e.loopEvidence) {
          lines.push(`> ⚠ Loop detected: "${e.loopEvidence.repeatedCall}" called ${e.loopEvidence.occurrences}×`);
        }
        lines.push("");
      }

      // Maestro result — outputText + tool events
      if (resultEntry?.detail) {
        const res = (resultEntry.detail as { result?: Record<string, unknown> }).result;
        if (res) {
          if (res["outputText"]) {
            lines.push("**Role Output:**");
            lines.push("");
            lines.push("```");
            lines.push(String(res["outputText"]));
            lines.push("```");
            lines.push("");
          }
          const toolEvents = res["toolEvents"];
          if (Array.isArray(toolEvents) && toolEvents.length > 0) {
            lines.push("**Tool Calls:**");
            lines.push("");
            lines.push("| Tool | Status | Summary |");
            lines.push("|---|---|---|");
            for (const te of toolEvents as Array<{ tool: string; ok: boolean; summary: string }>) {
              const icon = te.ok ? "✅" : "❌";
              lines.push(`| \`${te.tool}\` | ${icon} ${te.ok ? "ok" : "failed"} | ${te.summary ?? "—"} |`);
            }
            lines.push("");
          }
          const filesChanged = res["filesChanged"];
          if (Array.isArray(filesChanged) && filesChanged.length > 0) {
            lines.push("**Files Changed:**");
            for (const fc of filesChanged as Array<{ path: string; changeType: string; diff?: string }>) {
              lines.push(`- \`${fc.path}\` (${fc.changeType})`);
            }
            lines.push("");
          }
        }
      }
    }
  }

  // ── Role Prompts ────────────────────────────────────────────────────────────
  // Covers both runner path (maestro.role.call) and desktop/maestro-core path (agent.run.start)
  const roleCallEntries = filterTraceEntries(
    trace.entries,
    (e) => e.stage === "maestro.role.call" || e.stage === "agent.run.start",
  );
  if (roleCallEntries.length > 0) {
    lines.push("## Role Prompts");
    lines.push("");
    for (const entry of roleCallEntries) {
      const d = entry.detail as {
        role?: string;
        systemPrompt?: string;
        taskPrompt?: string;
        task?: { originalUserMessage?: string };
        isRepair?: boolean;
        isSubagent?: boolean;
      } | null;
      if (!d) continue;
      const label = `${d.role ?? "unknown"}${d.isRepair ? " (repair)" : ""}${d.isSubagent ? " (subagent)" : ""}`;
      lines.push(`### ${label}`);
      lines.push(`_at: ${entry.at}_`);
      lines.push("");
      if (d.systemPrompt) {
        lines.push("<details><summary>System Prompt</summary>");
        lines.push("");
        lines.push("```");
        lines.push(d.systemPrompt);
        lines.push("```");
        lines.push("");
        lines.push("</details>");
        lines.push("");
      }
      const taskPrompt = d.taskPrompt ?? d.task?.originalUserMessage;
      if (taskPrompt) {
        lines.push("<details><summary>Task Prompt</summary>");
        lines.push("");
        lines.push("```");
        lines.push(taskPrompt);
        lines.push("```");
        lines.push("");
        lines.push("</details>");
        lines.push("");
      }
    }
  }

  // ── Tool Payloads ────────────────────────────────────────────────────────────
  const toolCallEntries = filterTraceEntries(trace.entries, (e) => e.stage === "tool.call");
  const toolResultEntries = filterTraceEntries(trace.entries, (e) => e.stage === "tool.result");
  if (toolCallEntries.length > 0) {
    lines.push("## Tool Payloads");
    lines.push("");
    for (let i = 0; i < toolCallEntries.length; i++) {
      const callEntry = toolCallEntries[i];
      const callD = callEntry?.detail as { tool?: string; input?: unknown } | null;
      const resultEntry = toolResultEntries[i];
      const resultD = resultEntry?.detail as { tool?: string; ok?: boolean; output?: string; error?: string } | null;
      if (!callD) continue;
      const icon = resultD?.ok === false ? "❌" : "✅";
      lines.push(`### ${icon} \`${callD.tool ?? "unknown"}\``);
      lines.push(`_at: ${callEntry?.at ?? "—"}_`);
      lines.push("");
      lines.push("**Input:**");
      lines.push("```json");
      lines.push(JSON.stringify(callD.input ?? {}, null, 2));
      lines.push("```");
      lines.push("");
      if (resultD) {
        lines.push(`**Result:** ${resultD.ok ? "✅ ok" : "❌ failed"}`);
        if (resultD.output) {
          const preview = resultD.output.length > 1000
            ? `${resultD.output.slice(0, 1000)}\n…(truncated)`
            : resultD.output;
          lines.push("```");
          lines.push(preview);
          lines.push("```");
        }
        if (resultD.error) {
          lines.push(`**Error:** ${resultD.error}`);
        }
        lines.push("");
      }
    }
  }

  // ── Thought Log ─────────────────────────────────────────────────────────────
  const thoughtEvents = filterEvents(events, "maestro:thought") as Array<
    Extract<OrcaEvent, { type: "maestro:thought" }>
  >;
  if (thoughtEvents.length > 0) {
    lines.push("## Agent Loop — Thought Log");
    lines.push("");
    for (const te of thoughtEvents) {
      lines.push(`### Iteration ${te.iteration}`);
      lines.push(`**Thought:** ${te.thought}`);
      lines.push(`**Observation:** ${te.observation}`);
      lines.push(`**Next:** ${te.next}`);
      lines.push("");
    }
  }

  // ── Subagents ────────────────────────────────────────────────────────────────
  const subagentSpawned = filterEvents(events, "subagent:spawned") as Array<
    Extract<OrcaEvent, { type: "subagent:spawned" }>
  >;
  if (subagentSpawned.length > 0) {
    lines.push("## Subagents");
    lines.push("");
    lines.push("| Subagent ID | Role | Task | Status |");
    lines.push("|---|---|---|---|");
    for (const e of subagentSpawned) {
      const done = findEventWhere(events, "subagent:done", (x) => x.subagentId === e.subagentId) as
        | Extract<OrcaEvent, { type: "subagent:done" }>
        | undefined;
      const failed = findEventWhere(events, "subagent:failed", (x) => x.subagentId === e.subagentId) as
        | Extract<OrcaEvent, { type: "subagent:failed" }>
        | undefined;
      const status = done ? (done.ok ? "✅ done" : "⚠ done (not ok)") : failed ? `❌ failed: ${failed.error}` : "—";
      lines.push(`| \`${e.subagentId}\` | ${e.role} | ${e.task.slice(0, 80)} | ${status} |`);
    }
    lines.push("");
  }

  // ── Miranda Gate Checks ────────────────────────────────────────────────────
  const mirandaEntries = filterTraceEntries(trace.entries, (e) =>
    e.stage.startsWith("miranda."),
  );
  const toolGateEntries = filterTraceEntries(trace.entries, (e) =>
    e.stage === "miranda.before_tool_run" || e.stage === "miranda.after_tool_run",
  );
  const qcGateEntries = filterTraceEntries(trace.entries, (e) =>
    e.stage === "miranda.before_qc" || e.stage === "miranda.after_qc",
  );
  // Also pick up miranda:checkpoint OrcaEvents
  const mirandaCheckpointEvents = filterEvents(events, "miranda:checkpoint") as Array<
    Extract<OrcaEvent, { type: "miranda:checkpoint" }>
  >;

  if (mirandaEntries.length > 0 || mirandaCheckpointEvents.length > 0) {
    lines.push("## Miranda Gate Checks");
    lines.push("");
    lines.push("| Gate | Allowed | Reason | At |");
    lines.push("|---|---|---|---|");

    // Deduplicate: trace entries already contain the QC gates
    // OrcaEvents add the QC gates too — prefer trace entries which have richer data
    const seenGates = new Set<string>();
    for (const entry of mirandaEntries) {
      const d = entry.detail as { gate?: string; allowed?: boolean; reason?: string } | null;
      const key = `${entry.stage}-${entry.at}`;
      if (seenGates.has(key)) continue;
      seenGates.add(key);
      const allowed = d?.allowed !== false;
      const icon = allowed ? "✅" : "🚫";
      lines.push(`| \`${entry.stage.replace("miranda.", "")}\` | ${icon} | ${d?.reason ?? "—"} | ${entry.at} |`);
    }
    lines.push("");

    // List any blocks separately
    const blocks = mirandaEntries.filter((e) => {
      const d = e.detail as { allowed?: boolean } | null;
      return d?.allowed === false;
    });
    if (blocks.length > 0) {
      lines.push("> 🚫 **Gate blocks:**");
      for (const b of blocks) {
        const d = b.detail as { reason?: string } | null;
        lines.push(`> - \`${b.stage}\`: ${d?.reason ?? "(no reason)"}`);
      }
      lines.push("");
    }
  }

  // ── QC Results ──────────────────────────────────────────────────────────────
  const qcStartEntries = filterTraceEntries(trace.entries, (e) => e.stage === "qc.run.start");
  const qcResultEntries = filterTraceEntries(trace.entries, (e) => e.stage === "qc.run.result");

  if (qcResultEntries.length > 0) {
    lines.push("## Pappy QC Results");
    lines.push("");

    for (let i = 0; i < qcResultEntries.length; i++) {
      const entry = qcResultEntries[i];
      const d = entry?.detail as {
        attempt?: number;
        isRepair?: boolean;
        verdict?: string;
        confidence?: number;
        issues?: Array<{ severity: string; code: string; description: string; fix_hint?: string }>;
        internalSummary?: string;
        repairTask?: string;
      } | null;
      if (!d) continue;

      const passLabel = d.isRepair ? `Repair Pass #${d.attempt}` : "Initial Pass";
      const verdictIcon =
        d.verdict === "PASS" ? "✅" : d.verdict === "WARN" ? "⚠️" : "❌";

      lines.push(`### ${passLabel} — ${verdictIcon} ${d.verdict ?? "—"}`);
      if (d.confidence != null) {
        lines.push(`_Confidence: ${Math.round(d.confidence * 100)}%_`);
      }
      if (d.internalSummary) {
        lines.push(`> ${d.internalSummary}`);
      }
      lines.push("");

      if (d.issues && d.issues.length > 0) {
        lines.push("**Issues:**");
        lines.push("");
        lines.push("| Severity | Code | Description | Fix Hint |");
        lines.push("|---|---|---|---|");
        for (const issue of d.issues) {
          lines.push(
            `| ${issue.severity} | \`${issue.code}\` | ${issue.description} | ${issue.fix_hint ?? "—"} |`,
          );
        }
        lines.push("");
      }

      if (d.repairTask) {
        lines.push("**Repair Task:**");
        lines.push("");
        lines.push("```");
        lines.push(String(d.repairTask));
        lines.push("```");
        lines.push("");
      }
    }
  }

  // ── Pipeline Summary (Acceptance Criteria) ─────────────────────────────────
  const summaryEvent = findEvent(events, "pipeline:summary") as
    | Extract<OrcaEvent, { type: "pipeline:summary" }>
    | undefined;

  if (summaryEvent) {
    lines.push("## Acceptance Criteria");
    lines.push("");

    if (summaryEvent.acceptanceCriteria?.length) {
      lines.push("| ID | Required | Criterion | Met |");
      lines.push("|---|---|---|---|");
      for (const ac of summaryEvent.acceptanceCriteria) {
        const met = ac.met ? "✅" : "❌";
        const req = ac.required ? "(required)" : "(optional)";
        lines.push(`| \`${ac.id}\` | ${req} | ${ac.text} | ${met} |`);
      }
      lines.push("");
    }
  }

  // ── Repair Log ──────────────────────────────────────────────────────────────
  const repairEntries = filterTraceEntries(trace.entries, (e) => e.stage.startsWith("repair."));
  if (repairEntries.length > 0) {
    lines.push("## Repair Activity");
    lines.push("");
    for (const entry of repairEntries) {
      const d = entry.detail;
      lines.push(`**${entry.stage}** at ${entry.at}`);
      if (d) {
        lines.push("```json");
        lines.push(JSON.stringify(d, null, 2));
        lines.push("```");
      }
      lines.push("");
    }
  }

  // ── Final Result ────────────────────────────────────────────────────────────
  lines.push("## Final Result");
  lines.push("");
  lines.push(`**Status:** ${fr?.status ?? "—"}`);
  if (fr?.summary) {
    lines.push(`**Summary:** ${fr.summary}`);
  }
  lines.push("");
  if (fr?.userFacingText) {
    lines.push("**User-facing output:**");
    lines.push("");
    lines.push("```");
    lines.push(fr.userFacingText);
    lines.push("```");
    lines.push("");
  }

  // ── Trace Entry Index ────────────────────────────────────────────────────────
  lines.push("## Trace Entry Index");
  lines.push("");
  lines.push("_All raw trace stages recorded during this run:_");
  lines.push("");
  lines.push("| # | Stage | At |");
  lines.push("|---|---|---|");
  for (let i = 0; i < trace.entries.length; i++) {
    const entry = trace.entries[i];
    if (!entry) continue;
    lines.push(`| ${i + 1} | \`${entry.stage}\` | ${entry.at} |`);
  }
  lines.push("");

  // ── Footer ──────────────────────────────────────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push(`_run-analysis.md generated by orca-core. Source: OrcaPipelineTrace v${trace.version}._`);
  if (isFullTraceMode()) {
    lines.push("_⚠ ORCA_FULL_TRACE=true — secrets may be present in this file._");
  } else {
    lines.push("_Secrets redacted. Set ORCA_FULL_TRACE=true for unredacted artifacts._");
  }
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findTraceEntry(
  entries: OrcaPipelineTraceEntry[],
  stage: string,
): OrcaPipelineTraceEntry | undefined {
  return entries.find((e) => e.stage === stage);
}

function filterTraceEntries(
  entries: OrcaPipelineTraceEntry[],
  pred: (e: OrcaPipelineTraceEntry) => boolean,
): OrcaPipelineTraceEntry[] {
  return entries.filter(pred);
}

function findEvent(events: OrcaEvent[], type: string): OrcaEvent | undefined {
  return events.find((e) => e.type === type);
}

function findEventWhere<T extends OrcaEvent>(
  events: OrcaEvent[],
  type: string,
  pred: (e: T) => boolean,
): T | undefined {
  return events.find((e) => e.type === type && pred(e as T)) as T | undefined;
}

function filterEvents(events: OrcaEvent[], type: string): OrcaEvent[] {
  return events.filter((e) => e.type === type);
}
