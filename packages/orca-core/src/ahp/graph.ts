/**
 * AHP Packet Graph — serialization, inspection, and formatting helpers.
 *
 * Provides a flat, JSON-serializable representation of the root/child packet
 * hierarchy so it can be persisted with a run record and inspected after the
 * fact without requiring the full AHPPacket object graph.
 *
 * Canonical home: packages/orca-core/src/ahp/graph.ts
 */

import type { AHPPacket, AHPEvalMeta } from "./types.js";
import { AHPLifecycle, AHPVerdict } from "./types.js";

// ---------------------------------------------------------------------------
// Serializable shapes
// ---------------------------------------------------------------------------

/**
 * Minimal serializable snapshot of one AHP packet.
 * Contains everything needed for debugging / inspection without carrying
 * the full AHPPacket shape's mutable references.
 */
export interface AHPPacketGraphNode {
  /** Packet identifier — matches AHPPacket.id. */
  id:            string;
  /** Role: "Root" | "Child" | undefined for legacy packets. */
  role?:         string;
  /** ID of the parent packet, undefined on root. */
  parentPacketId?: string;
  /** IDs of child packets registered under this node (root only). */
  childPacketIds?: string[];
  /** Lifecycle at serialization time. */
  lifecycle:     AHPLifecycle;
  /** Verdict from Pappy verification (PASS | WARN | FAIL | undefined). */
  verdict?:      string;
  /** Objective text from the original task spec. */
  objective:     string;
  /** Number of trace entries recorded. */
  traceCount:    number;
  /** ISO string of the first trace entry timestamp, if any. */
  firstTraceAt?:  string;
  /** ISO string of the last trace entry timestamp, if any. */
  lastTraceAt?:   string;
  /** Structured eval metadata from Pappy (if present). */
  evalMeta?:     {
    taskType:       string;
    mergedAcCount:  number;
    derivedAcCount: number;
  };
  /** ISO string when the packet transitioned into RUNNING. */
  startedAt?:    string;
  /** ISO string when the packet reached a terminal lifecycle state. */
  completedAt?:  string;
}

/**
 * The full serializable packet graph for a single run.
 * Root + zero-or-more children captured at run completion time.
 *
 * Stored as JSON in RunRecord.ahpPacketGraph and optionally in
 * OrcaPipelineTrace.finalResult.ahpPacketGraph.
 */
export interface AHPPacketGraph {
  /** Schema version for forward-compat parsing. */
  version:    1;
  /** Serialized root packet node. */
  root:       AHPPacketGraphNode;
  /**
   * Serialized child packet nodes.
   * Empty array for single-run (Option A) tasks.
   */
  children:   AHPPacketGraphNode[];
  /** ISO timestamp when the graph was serialized. */
  capturedAt: string;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function nodeFromPacket(packet: AHPPacket): AHPPacketGraphNode {
  const trace = packet.trace ?? [];
  const evalMeta = packet.evalMeta as AHPEvalMeta | undefined;
  return {
    id:             packet.id,
    role:           packet.role,
    parentPacketId: packet.parentPacketId,
    childPacketIds: packet.childPacketIds ? [...packet.childPacketIds] : undefined,
    lifecycle:      packet.lifecycle,
    verdict:        packet.verdict,
    objective:      packet.objective,
    traceCount:     trace.length,
    firstTraceAt:   trace[0]?.timestamp,
    lastTraceAt:    trace[trace.length - 1]?.timestamp,
    evalMeta:       evalMeta
      ? {
          taskType:       evalMeta.taskType,
          mergedAcCount:  evalMeta.mergedAcceptanceCriteria?.length ?? 0,
          derivedAcCount: evalMeta.derivedAcceptanceCriteria?.length ?? 0,
        }
      : undefined,
    startedAt:   packet.meta?.startedAt,
    completedAt: packet.meta?.completedAt,
  };
}

/**
 * Build a serializable AHPPacketGraph snapshot from the root packet and
 * any child packets collected at run-finalization time.
 *
 * Safe to call with undefined/null inputs — returns a minimal graph with
 * placeholder values rather than throwing.
 */
export function serializeAHPPacketGraph(
  root: AHPPacket | undefined | null,
  children: AHPPacket[] | undefined | null,
): AHPPacketGraph {
  const capturedAt = new Date().toISOString();

  if (!root) {
    // Degenerate case: no packet data available.
    return {
      version:    1,
      root: {
        id:        "unknown",
        lifecycle: AHPLifecycle.INCONCLUSIVE,
        objective: "(no packet data)",
        traceCount: 0,
      },
      children:   [],
      capturedAt,
    };
  }

  return {
    version:    1,
    root:       nodeFromPacket(root),
    children:   (children ?? []).map(nodeFromPacket),
    capturedAt,
  };
}

// ---------------------------------------------------------------------------
// Inspection / formatting
// ---------------------------------------------------------------------------

/** Available modes for AHP packet-graph summary output. */
export type AHPGraphSummaryMode = "all" | "issues";

const LIFECYCLE_ICON: Record<string, string> = {
  [AHPLifecycle.COMPLETE]:     "✓",
  [AHPLifecycle.FAILED]:       "✗",
  [AHPLifecycle.INCONCLUSIVE]: "?",
  [AHPLifecycle.RUNNING]:      "▶",
  [AHPLifecycle.PENDING]:      "○",
};

/**
 * Returns true when a graph node is operationally interesting — i.e. it did
 * not complete cleanly.
 *
 * A node is interesting when ANY of the following hold:
 *   1. lifecycle !== COMPLETE  (covers FAILED, INCONCLUSIVE, still-RUNNING,
 *      still-PENDING at capture time — all non-success states)
 *   2. verdict is concern-level: WARN | FAIL | INCONCLUSIVE | VIOLATION
 *      (a COMPLETE packet with a warning-grade verdict is still worth flagging)
 *
 * A node is considered healthy only when lifecycle === COMPLETE with verdict
 * PASS or no verdict.
 */
export function isNodeInteresting(node: AHPPacketGraphNode): boolean {
  if (node.lifecycle !== AHPLifecycle.COMPLETE) return true;
  if (
    node.verdict === AHPVerdict.WARN        ||
    node.verdict === AHPVerdict.FAIL        ||
    node.verdict === AHPVerdict.INCONCLUSIVE ||
    node.verdict === AHPVerdict.VIOLATION
  ) return true;
  return false;
}

/**
 * Format a single packet node as display lines.
 * Internal helper shared by both full and issues formatters — do not export.
 */
function formatNodeLines(node: AHPPacketGraphNode, label: "ROOT" | "CHILD"): string[] {
  const icon = LIFECYCLE_ICON[node.lifecycle] ?? "?";
  const lines: string[] = [];
  lines.push(`${label}  ${icon} ${node.lifecycle}  ${node.id}`);
  lines.push(`      objective : ${JSON.stringify(node.objective)}`);
  if (label === "ROOT" && node.role) lines.push(`      role      : ${node.role}`);
  if (label === "CHILD" && node.parentPacketId) lines.push(`      parent    : ${node.parentPacketId}`);
  if (node.startedAt)   lines.push(`      started   : ${node.startedAt}`);
  if (node.completedAt) lines.push(`      completed : ${node.completedAt}`);
  lines.push(`      traces    : ${node.traceCount}${node.verdict ? `  verdict: ${node.verdict}` : ""}`);
  if (node.evalMeta?.taskType) {
    lines.push(`      taskType  : ${node.evalMeta.taskType}  ACs: ${node.evalMeta.mergedAcCount} (${node.evalMeta.derivedAcCount} derived)`);
  }
  if (label === "ROOT" && node.childPacketIds && node.childPacketIds.length > 0) {
    lines.push(`      children  : [${node.childPacketIds.join(", ")}]`);
  }
  return lines;
}

/**
 * Format an AHPPacketGraph as a full human-readable multi-line summary
 * (mode: "all" — all packets, full detail).
 *
 * Designed to be logged to stderr or written to a debug artifact after a run.
 * Gracefully degrades when fields are absent (e.g. older records loaded
 * from storage that pre-date hierarchy support).
 */
export function formatAHPPacketGraphSummary(graph: AHPPacketGraph | null | undefined): string {
  if (!graph) {
    return "AHP Packet Graph — no data available";
  }

  const HR = "─".repeat(60);
  const lines: string[] = [];

  lines.push(`AHP Packet Graph ${HR.slice(17)}`);
  lines.push(...formatNodeLines(graph.root, "ROOT"));
  lines.push(HR);

  if (graph.children.length === 0) {
    lines.push("(no child packets — single-run)");
  } else {
    for (const child of graph.children) {
      lines.push(...formatNodeLines(child, "CHILD"));
    }
  }

  lines.push(HR);
  lines.push(`    captured : ${graph.capturedAt}  (v${graph.version})`);

  return lines.join("\n");
}

/**
 * Format an AHPPacketGraph showing only operationally interesting packets
 * (mode: "issues").
 *
 * Returns **null** when no issues are found — use as a zero-noise guard:
 *
 *   const issues = formatAHPPacketGraphIssuesSummary(graph);
 *   if (issues) console.error(issues);
 *
 * Filtering rules:
 *   - A packet is included when isNodeInteresting() returns true.
 *   - The root is always included for context when any interesting children exist,
 *     even if the root itself is healthy.
 *   - A counts footer is always appended: total / shown / failed / inconclusive / warned.
 *
 * Returns null when graph is null/undefined, or when root is healthy and no children
 * are interesting (clean success — no output needed).
 */
export function formatAHPPacketGraphIssuesSummary(
  graph: AHPPacketGraph | null | undefined,
): string | null {
  if (!graph) return null;

  const interestingChildren = graph.children.filter(isNodeInteresting);
  const rootIsInteresting   = isNodeInteresting(graph.root);

  if (!rootIsInteresting && interestingChildren.length === 0) return null;

  const HR     = "─".repeat(60);
  const lines: string[] = [];

  const allNodes          = [graph.root, ...graph.children];
  const totalPackets      = allNodes.length;
  const shownPackets      = 1 + interestingChildren.length; // root always included for context
  const failedCount       = allNodes.filter(n =>
    n.lifecycle === AHPLifecycle.FAILED ||
    n.verdict   === AHPVerdict.FAIL     ||
    n.verdict   === AHPVerdict.VIOLATION
  ).length;
  const inconclusiveCount = allNodes.filter(n =>
    n.lifecycle === AHPLifecycle.INCONCLUSIVE ||
    n.verdict   === AHPVerdict.INCONCLUSIVE
  ).length;
  const warnedCount       = allNodes.filter(n => n.verdict === AHPVerdict.WARN).length;

  const headerLabel = `AHP Issues (${shownPackets}/${totalPackets})`;
  const headerPad   = "─".repeat(Math.max(0, 60 - headerLabel.length - 1));
  lines.push(`${headerLabel} ${headerPad}`);

  // Root always shown for context — makes child issues readable without losing
  // the overall objective and lifecycle of the run.
  // Scope the children list to only the interesting ones so healthy child IDs
  // don't appear in the issues output.
  const rootForDisplay: AHPPacketGraphNode = {
    ...graph.root,
    childPacketIds: interestingChildren.length > 0
      ? interestingChildren.map((c) => c.id)
      : undefined,
  };
  lines.push(...formatNodeLines(rootForDisplay, "ROOT"));
  lines.push(HR);

  if (interestingChildren.length === 0) {
    lines.push("(root-level issue — no child concerns)");
  } else {
    for (const child of interestingChildren) {
      lines.push(...formatNodeLines(child, "CHILD"));
    }
  }

  lines.push(HR);
  lines.push(
    `  total: ${totalPackets}  shown: ${shownPackets}` +
    `  failed: ${failedCount}  inconclusive: ${inconclusiveCount}  warned: ${warnedCount}`,
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Safe deserialization
// ---------------------------------------------------------------------------

/**
 * Parse a JSON string stored in RunRecord.ahpPacketGraph back into
 * AHPPacketGraph.
 *
 * Returns null safely when:
 * - input is null/undefined (older records without packet graph)
 * - input is not valid JSON
 * - input does not have the expected shape
 *
 * Never throws.
 */
export function parseAHPPacketGraph(json: string | null | undefined): AHPPacketGraph | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed !== "object" || parsed === null ||
      (parsed as AHPPacketGraph).version !== 1 ||
      typeof (parsed as AHPPacketGraph).root !== "object"
    ) {
      return null;
    }
    return parsed as AHPPacketGraph;
  } catch {
    return null;
  }
}
