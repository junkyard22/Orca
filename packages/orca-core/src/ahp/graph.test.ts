/**
 * AHP Packet Graph — unit and integration tests
 *
 * Covers: serializeAHPPacketGraph, formatAHPPacketGraphSummary,
 *         isNodeInteresting, formatAHPPacketGraphIssuesSummary,
 *         parseAHPPacketGraph, SqliteStore round-trip, backward compat.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  serializeAHPPacketGraph,
  formatAHPPacketGraphSummary,
  formatAHPPacketGraphIssuesSummary,
  isNodeInteresting,
  parseAHPPacketGraph,
} from "./graph.js";
import {
  AHPLifecycle,
  AHPPacketRole,
  AHPVerdict,
  createRootPacket,
  createChildPacket,
  registerChildOnRoot,
  appendAHPTrace,
} from "./types.js";
import type { AHPPacket } from "./types.js";
import { SqliteStore } from "../persistence/sqliteStore.js";
import type { RunRecord } from "../persistence/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRoot(id = "root-1", objective = "Test objective"): AHPPacket {
  return createRootPacket({
    id,
    objective,
    expectedOutput: { schema: {}, acceptanceCriteria: [] },
  });
}

function makeChild(parentId: string, id = "child-1"): AHPPacket {
  return createChildPacket(parentId, {
    id,
    objective: "Child objective",
    expectedOutput: { schema: {}, acceptanceCriteria: [] },
  });
}

// ---------------------------------------------------------------------------
// serializeAHPPacketGraph
// ---------------------------------------------------------------------------

describe("serializeAHPPacketGraph", () => {
  it("root-only: produces correct shape with version=1", () => {
    const root = makeRoot();
    const graph = serializeAHPPacketGraph(root, []);

    expect(graph.version).toBe(1);
    expect(graph.root.id).toBe(root.id);
    expect(graph.children).toHaveLength(0);
    expect(typeof graph.capturedAt).toBe("string");
  });

  it("root-only: root node has correct lifecycle and objective", () => {
    const root = makeRoot("r1", "my objective");
    root.lifecycle = AHPLifecycle.COMPLETE;
    const graph = serializeAHPPacketGraph(root, []);

    expect(graph.root.lifecycle).toBe(AHPLifecycle.COMPLETE);
    expect(graph.root.objective).toBe("my objective");
  });

  it("root+children: includes all child nodes in order", () => {
    const root = makeRoot("r2");
    const c1 = makeChild("r2", "c1");
    const c2 = makeChild("r2", "c2");
    registerChildOnRoot(root, c1);
    registerChildOnRoot(root, c2);

    const graph = serializeAHPPacketGraph(root, [c1, c2]);

    expect(graph.children).toHaveLength(2);
    expect(graph.children[0].id).toBe("c1");
    expect(graph.children[1].id).toBe("c2");
  });

  it("root+children: child nodes carry parentPacketId", () => {
    const root = makeRoot("r3");
    const child = makeChild("r3", "c3");
    registerChildOnRoot(root, child);

    const graph = serializeAHPPacketGraph(root, [child]);

    expect(graph.children[0].parentPacketId).toBe("r3");
  });

  it("root node carries childPacketIds from the root packet", () => {
    const root = makeRoot("r4");
    const child = makeChild("r4", "c4");
    registerChildOnRoot(root, child);

    const graph = serializeAHPPacketGraph(root, [child]);

    expect(graph.root.childPacketIds).toEqual(["c4"]);
  });

  it("evalMeta is preserved on root node when present", () => {
    const root = makeRoot("r5");
    (root as AHPPacket & { evalMeta?: unknown }).evalMeta = {
      taskType: "code_edit",
      derivedAcceptanceCriteria: ["a", "b"],
      mergedAcceptanceCriteria: ["x", "a", "b"],
    };

    const graph = serializeAHPPacketGraph(root, []);

    expect(graph.root.evalMeta?.taskType).toBe("code_edit");
    expect(graph.root.evalMeta?.mergedAcCount).toBe(3);
    expect(graph.root.evalMeta?.derivedAcCount).toBe(2);
  });

  it("traceCount reflects actual trace entries", () => {
    const root = makeRoot("r6");
    appendAHPTrace(root, { timestamp: new Date().toISOString(), state: AHPLifecycle.RUNNING, actor: "test" });
    appendAHPTrace(root, { timestamp: new Date().toISOString(), state: AHPLifecycle.COMPLETE, actor: "test" });

    const graph = serializeAHPPacketGraph(root, []);

    expect(graph.root.traceCount).toBe(2);
  });

  it("firstTraceAt and lastTraceAt are set from trace entries", () => {
    const root = makeRoot("r7");
    const t1 = "2026-01-01T00:00:00.000Z";
    const t2 = "2026-01-01T00:01:00.000Z";
    appendAHPTrace(root, { timestamp: t1, state: AHPLifecycle.RUNNING,  actor: "test" });
    appendAHPTrace(root, { timestamp: t2, state: AHPLifecycle.COMPLETE, actor: "test" });

    const graph = serializeAHPPacketGraph(root, []);

    expect(graph.root.firstTraceAt).toBe(t1);
    expect(graph.root.lastTraceAt).toBe(t2);
  });

  it("verdict is preserved on root node", () => {
    const root = makeRoot("r8");
    root.verdict = AHPVerdict.PASS;

    const graph = serializeAHPPacketGraph(root, []);

    expect(graph.root.verdict).toBe(AHPVerdict.PASS);
  });

  it("role is preserved on root node", () => {
    const root = makeRoot("r9");

    const graph = serializeAHPPacketGraph(root, []);

    expect(graph.root.role).toBe(AHPPacketRole.Root);
  });

  it("null/undefined root returns degenerate graph without throwing", () => {
    const graph = serializeAHPPacketGraph(null, []);

    expect(graph.version).toBe(1);
    expect(graph.root.id).toBe("unknown");
    expect(graph.root.lifecycle).toBe(AHPLifecycle.INCONCLUSIVE);
    expect(graph.children).toHaveLength(0);
  });

  it("undefined children treated as empty array", () => {
    const root = makeRoot("r10");
    const graph = serializeAHPPacketGraph(root, undefined);

    expect(graph.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// formatAHPPacketGraphSummary
// ---------------------------------------------------------------------------

describe("formatAHPPacketGraphSummary", () => {
  it("contains root id and lifecycle", () => {
    const root = makeRoot("root-fmt-1");
    root.lifecycle = AHPLifecycle.COMPLETE;
    const graph = serializeAHPPacketGraph(root, []);
    const summary = formatAHPPacketGraphSummary(graph);

    expect(summary).toContain("root-fmt-1");
    expect(summary).toContain("COMPLETE");
  });

  it("contains objective text", () => {
    const root = makeRoot("root-fmt-2", "refactor sort function");
    const graph = serializeAHPPacketGraph(root, []);
    const summary = formatAHPPacketGraphSummary(graph);

    expect(summary).toContain("refactor sort function");
  });

  it("single-run note appears when no children", () => {
    const root = makeRoot("root-fmt-3");
    const graph = serializeAHPPacketGraph(root, []);
    const summary = formatAHPPacketGraphSummary(graph);

    expect(summary).toContain("single-run");
  });

  it("child id and lifecycle appear when children present", () => {
    const root = makeRoot("root-fmt-4");
    const child = makeChild("root-fmt-4", "child-fmt-4");
    child.lifecycle = AHPLifecycle.FAILED;
    registerChildOnRoot(root, child);

    const graph = serializeAHPPacketGraph(root, [child]);
    const summary = formatAHPPacketGraphSummary(graph);

    expect(summary).toContain("child-fmt-4");
    expect(summary).toContain("FAILED");
  });

  it("evalMeta taskType and AC counts appear when present", () => {
    const root = makeRoot("root-fmt-5");
    (root as AHPPacket & { evalMeta?: unknown }).evalMeta = {
      taskType: "code_generation",
      derivedAcceptanceCriteria: ["x"],
      mergedAcceptanceCriteria: ["y", "x"],
    };
    const graph = serializeAHPPacketGraph(root, []);
    const summary = formatAHPPacketGraphSummary(graph);

    expect(summary).toContain("code_generation");
    expect(summary).toContain("ACs: 2");
  });

  it("capturedAt appears in summary", () => {
    const root = makeRoot("root-fmt-6");
    const graph = serializeAHPPacketGraph(root, []);
    const summary = formatAHPPacketGraphSummary(graph);

    expect(summary).toContain(graph.capturedAt);
    expect(summary).toContain("v1");
  });

  it("null input returns safe fallback string without throwing", () => {
    const summary = formatAHPPacketGraphSummary(null);

    expect(typeof summary).toBe("string");
    expect(summary.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// parseAHPPacketGraph
// ---------------------------------------------------------------------------

describe("parseAHPPacketGraph", () => {
  it("round-trips a valid graph through JSON", () => {
    const root = makeRoot("parse-1");
    const graph = serializeAHPPacketGraph(root, []);
    const json = JSON.stringify(graph);
    const parsed = parseAHPPacketGraph(json);

    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe(1);
    expect(parsed!.root.id).toBe(root.id);
    expect(parsed!.children).toHaveLength(0);
  });

  it("returns null for invalid JSON", () => {
    expect(parseAHPPacketGraph("{not valid json")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseAHPPacketGraph(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseAHPPacketGraph(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseAHPPacketGraph("")).toBeNull();
  });

  it("returns null when version field is missing", () => {
    const json = JSON.stringify({ root: { id: "x" }, children: [] });
    expect(parseAHPPacketGraph(json)).toBeNull();
  });

  it("returns null when version field is wrong", () => {
    const json = JSON.stringify({ version: 99, root: { id: "x" }, children: [] });
    expect(parseAHPPacketGraph(json)).toBeNull();
  });

  it("returns null when root field is missing", () => {
    const json = JSON.stringify({ version: 1, children: [] });
    expect(parseAHPPacketGraph(json)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SqliteStore round-trip
// ---------------------------------------------------------------------------

describe("SqliteStore + ahpPacketGraph round-trip", () => {
  let store: SqliteStore;

  beforeEach(async () => {
    store = new SqliteStore(":memory:");
    // Brief delay for store initialization
    await new Promise((r) => setTimeout(r, 100));
  });

  afterEach(() => {
    store.close();
  });

  it("persists and retrieves ahpPacketGraph JSON blob", async () => {
    const root = makeRoot("store-rt-1");
    const graph = serializeAHPPacketGraph(root, []);
    const graphJson = JSON.stringify(graph);

    const run: RunRecord = {
      id: "store-rt-run-1",
      createdAt: new Date().toISOString(),
      intent: "test round-trip",
      status: "SUCCESS",
      ahpPacketGraph: graphJson,
    };

    await store.saveRun(run, [], [], []);
    const retrieved = await store.getRun("store-rt-run-1");

    expect(retrieved).not.toBeNull();
    expect(retrieved!.ahpPacketGraph).toBe(graphJson);

    const parsedBack = parseAHPPacketGraph(retrieved!.ahpPacketGraph);
    expect(parsedBack).not.toBeNull();
    expect(parsedBack!.root.id).toBe("store-rt-1");
  });

  it("serialized graph survives children", async () => {
    const root = makeRoot("store-rt-2");
    const c1 = makeChild("store-rt-2", "store-rt-child-1");
    const c2 = makeChild("store-rt-2", "store-rt-child-2");
    registerChildOnRoot(root, c1);
    registerChildOnRoot(root, c2);

    const graph = serializeAHPPacketGraph(root, [c1, c2]);
    const run: RunRecord = {
      id: "store-rt-run-2",
      createdAt: new Date().toISOString(),
      intent: "hierarchy round-trip",
      status: "SUCCESS",
      ahpPacketGraph: JSON.stringify(graph),
    };

    await store.saveRun(run, [], [], []);
    const retrieved = await store.getRun("store-rt-run-2");
    const parsedBack = parseAHPPacketGraph(retrieved?.ahpPacketGraph);

    expect(parsedBack).not.toBeNull();
    expect(parsedBack!.children).toHaveLength(2);
    expect(parsedBack!.children[0].id).toBe("store-rt-child-1");
  });

  it("old records without ahpPacketGraph load safely (backward compat)", async () => {
    const run: RunRecord = {
      id: "store-old-1",
      createdAt: new Date().toISOString(),
      intent: "legacy run",
      status: "SUCCESS",
      // no ahpPacketGraph field
    };

    await store.saveRun(run, [], [], []);
    const retrieved = await store.getRun("store-old-1");

    expect(retrieved).not.toBeNull();
    expect(retrieved!.ahpPacketGraph).toBeUndefined();
    expect(parseAHPPacketGraph(retrieved!.ahpPacketGraph)).toBeNull();
  });

  it("getRecentRuns also returns ahpPacketGraph blob", async () => {
    const root = makeRoot("store-recent-1");
    const graph = serializeAHPPacketGraph(root, []);
    const run: RunRecord = {
      id: "store-recent-run-1",
      createdAt: new Date().toISOString(),
      intent: "recent runs test",
      status: "SUCCESS",
      ahpPacketGraph: JSON.stringify(graph),
    };

    await store.saveRun(run, [], [], []);
    const runs = await store.getRecentRuns(10);
    const found = runs.find((r) => r.id === "store-recent-run-1");

    expect(found).not.toBeUndefined();
    expect(found!.ahpPacketGraph).toBeDefined();
    const parsedBack = parseAHPPacketGraph(found!.ahpPacketGraph);
    expect(parsedBack!.root.id).toBe("store-recent-1");
  });
});

// ---------------------------------------------------------------------------
// isNodeInteresting
// ---------------------------------------------------------------------------

describe("isNodeInteresting", () => {
  it("COMPLETE + no verdict → not interesting (healthy)", () => {
    const root = makeRoot("ni-1");
    root.lifecycle = AHPLifecycle.COMPLETE;
    const graph = serializeAHPPacketGraph(root, []);

    expect(isNodeInteresting(graph.root)).toBe(false);
  });

  it("COMPLETE + PASS verdict → not interesting", () => {
    const root = makeRoot("ni-2");
    root.lifecycle = AHPLifecycle.COMPLETE;
    root.verdict   = AHPVerdict.PASS;
    const graph = serializeAHPPacketGraph(root, []);

    expect(isNodeInteresting(graph.root)).toBe(false);
  });

  it("FAILED lifecycle → interesting", () => {
    const root = makeRoot("ni-3");
    root.lifecycle = AHPLifecycle.FAILED;
    const graph = serializeAHPPacketGraph(root, []);

    expect(isNodeInteresting(graph.root)).toBe(true);
  });

  it("INCONCLUSIVE lifecycle → interesting", () => {
    const root = makeRoot("ni-4");
    root.lifecycle = AHPLifecycle.INCONCLUSIVE;
    const graph = serializeAHPPacketGraph(root, []);

    expect(isNodeInteresting(graph.root)).toBe(true);
  });

  it("PENDING lifecycle at capture time → interesting", () => {
    const root = makeRoot("ni-5"); // createRootPacket starts at PENDING
    const graph = serializeAHPPacketGraph(root, []);

    expect(isNodeInteresting(graph.root)).toBe(true);
  });

  it("COMPLETE + WARN verdict → interesting", () => {
    const root = makeRoot("ni-6");
    root.lifecycle = AHPLifecycle.COMPLETE;
    root.verdict   = AHPVerdict.WARN;
    const graph = serializeAHPPacketGraph(root, []);

    expect(isNodeInteresting(graph.root)).toBe(true);
  });

  it("COMPLETE + FAIL verdict → interesting", () => {
    const root = makeRoot("ni-7");
    root.lifecycle = AHPLifecycle.COMPLETE;
    root.verdict   = AHPVerdict.FAIL;
    const graph = serializeAHPPacketGraph(root, []);

    expect(isNodeInteresting(graph.root)).toBe(true);
  });

  it("COMPLETE + VIOLATION verdict → interesting", () => {
    const root = makeRoot("ni-8");
    root.lifecycle = AHPLifecycle.COMPLETE;
    root.verdict   = AHPVerdict.VIOLATION;
    const graph = serializeAHPPacketGraph(root, []);

    expect(isNodeInteresting(graph.root)).toBe(true);
  });

  it("COMPLETE + INCONCLUSIVE verdict → interesting", () => {
    const root = makeRoot("ni-9");
    root.lifecycle = AHPLifecycle.COMPLETE;
    root.verdict   = AHPVerdict.INCONCLUSIVE;
    const graph = serializeAHPPacketGraph(root, []);

    expect(isNodeInteresting(graph.root)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatAHPPacketGraphIssuesSummary
// ---------------------------------------------------------------------------

describe("formatAHPPacketGraphIssuesSummary", () => {
  // ----- null / no-issue guards -----

  it("returns null for null graph input", () => {
    expect(formatAHPPacketGraphIssuesSummary(null)).toBeNull();
  });

  it("returns null for undefined graph input", () => {
    expect(formatAHPPacketGraphIssuesSummary(undefined)).toBeNull();
  });

  it("returns null when root is healthy and no children", () => {
    const root = makeRoot("iss-clean-1");
    root.lifecycle = AHPLifecycle.COMPLETE;
    root.verdict   = AHPVerdict.PASS;
    const graph = serializeAHPPacketGraph(root, []);

    expect(formatAHPPacketGraphIssuesSummary(graph)).toBeNull();
  });

  it("returns null when all packets are healthy (root + children)", () => {
    const root = makeRoot("iss-clean-2");
    root.lifecycle = AHPLifecycle.COMPLETE;
    root.verdict   = AHPVerdict.PASS;
    const c1 = makeChild("iss-clean-2", "iss-clean-c1");
    c1.lifecycle = AHPLifecycle.COMPLETE;
    c1.verdict   = AHPVerdict.PASS;
    const c2 = makeChild("iss-clean-2", "iss-clean-c2");
    c2.lifecycle = AHPLifecycle.COMPLETE;
    c2.verdict   = AHPVerdict.PASS;
    registerChildOnRoot(root, c1);
    registerChildOnRoot(root, c2);
    const graph = serializeAHPPacketGraph(root, [c1, c2]);

    expect(formatAHPPacketGraphIssuesSummary(graph)).toBeNull();
  });

  // ----- single-run root issues -----

  it("root FAILED single-run → non-null output containing root id", () => {
    const root = makeRoot("iss-root-fail");
    root.lifecycle = AHPLifecycle.FAILED;
    root.verdict   = AHPVerdict.FAIL;
    const graph = serializeAHPPacketGraph(root, []);
    const summary = formatAHPPacketGraphIssuesSummary(graph);

    expect(summary).not.toBeNull();
    expect(summary).toContain("iss-root-fail");
    expect(summary).toContain("FAILED");
    expect(summary).toContain("verdict: FAIL");
  });

  it("root FAILED single-run → shows root-level-issue note (no child concerns)", () => {
    const root = makeRoot("iss-root-note");
    root.lifecycle = AHPLifecycle.FAILED;
    const graph = serializeAHPPacketGraph(root, []);

    expect(formatAHPPacketGraphIssuesSummary(graph)).toContain("root-level issue");
  });

  it("root INCOMPLETE + WARN verdict → shown (COMPLETE+WARN is interesting)", () => {
    const root = makeRoot("iss-root-warn");
    root.lifecycle = AHPLifecycle.COMPLETE;
    root.verdict   = AHPVerdict.WARN;
    const graph = serializeAHPPacketGraph(root, []);
    const summary = formatAHPPacketGraphIssuesSummary(graph);

    expect(summary).not.toBeNull();
    expect(summary).toContain("iss-root-warn");
    expect(summary).toContain("verdict: WARN");
  });

  // ----- child filtering -----

  it("excludes healthy child, includes failing child", () => {
    const root = makeRoot("iss-filter");
    root.lifecycle = AHPLifecycle.COMPLETE;
    root.verdict   = AHPVerdict.PASS;
    const healthyChild = makeChild("iss-filter", "iss-filter-healthy");
    healthyChild.lifecycle = AHPLifecycle.COMPLETE;
    healthyChild.verdict   = AHPVerdict.PASS;
    const failingChild = makeChild("iss-filter", "iss-filter-bad");
    failingChild.lifecycle = AHPLifecycle.FAILED;
    failingChild.verdict   = AHPVerdict.FAIL;
    registerChildOnRoot(root, healthyChild);
    registerChildOnRoot(root, failingChild);
    const graph = serializeAHPPacketGraph(root, [healthyChild, failingChild]);
    const summary = formatAHPPacketGraphIssuesSummary(graph);

    expect(summary).not.toBeNull();
    expect(summary).not.toContain("iss-filter-healthy");
    expect(summary).toContain("iss-filter-bad");
  });

  it("includes root context even when root is healthy but a child failed", () => {
    const root = makeRoot("iss-root-ctx", "top-level objective");
    root.lifecycle = AHPLifecycle.COMPLETE;
    root.verdict   = AHPVerdict.PASS;
    const bad = makeChild("iss-root-ctx", "iss-root-ctx-child");
    bad.lifecycle = AHPLifecycle.INCONCLUSIVE;
    registerChildOnRoot(root, bad);
    const graph = serializeAHPPacketGraph(root, [bad]);
    const summary = formatAHPPacketGraphIssuesSummary(graph);

    expect(summary).toContain("iss-root-ctx");     // root id present for context
    expect(summary).toContain("top-level objective"); // root objective present
    expect(summary).toContain("iss-root-ctx-child"); // bad child present
  });

  it("INCONCLUSIVE child → included in issues output", () => {
    const root = makeRoot("iss-inconc-root");
    root.lifecycle = AHPLifecycle.COMPLETE;
    root.verdict   = AHPVerdict.PASS;
    const child = makeChild("iss-inconc-root", "iss-inconc-child");
    child.lifecycle = AHPLifecycle.INCONCLUSIVE;
    registerChildOnRoot(root, child);
    const graph = serializeAHPPacketGraph(root, [child]);

    expect(formatAHPPacketGraphIssuesSummary(graph)).toContain("iss-inconc-child");
  });

  it("WARN-verdict child → included in issues output", () => {
    const root = makeRoot("iss-warn-root");
    root.lifecycle = AHPLifecycle.COMPLETE;
    root.verdict   = AHPVerdict.PASS;
    const child = makeChild("iss-warn-root", "iss-warn-child");
    child.lifecycle = AHPLifecycle.COMPLETE;
    child.verdict   = AHPVerdict.WARN;
    registerChildOnRoot(root, child);
    const graph = serializeAHPPacketGraph(root, [child]);

    expect(formatAHPPacketGraphIssuesSummary(graph)).toContain("iss-warn-child");
  });

  // ----- counts footer -----

  it("counts footer present with total/shown/failed/inconclusive/warned", () => {
    const root = makeRoot("iss-counts-root");
    root.lifecycle = AHPLifecycle.COMPLETE;
    root.verdict   = AHPVerdict.PASS;
    const c1 = makeChild("iss-counts-root", "iss-counts-c1");
    c1.lifecycle = AHPLifecycle.FAILED;
    c1.verdict   = AHPVerdict.FAIL;
    const c2 = makeChild("iss-counts-root", "iss-counts-c2");
    c2.lifecycle = AHPLifecycle.INCONCLUSIVE;
    const c3 = makeChild("iss-counts-root", "iss-counts-c3");
    c3.lifecycle = AHPLifecycle.COMPLETE;
    c3.verdict   = AHPVerdict.WARN;
    registerChildOnRoot(root, c1);
    registerChildOnRoot(root, c2);
    registerChildOnRoot(root, c3);
    const graph = serializeAHPPacketGraph(root, [c1, c2, c3]);
    const summary = formatAHPPacketGraphIssuesSummary(graph)!;

    expect(summary).toContain("total: 4");  // root + 3 children
    expect(summary).toContain("shown: 4");  // root (context) + 3 bad children
    expect(summary).toContain("failed: 1");
    expect(summary).toContain("inconclusive: 1");
    expect(summary).toContain("warned: 1");
  });

  it("header shows shown/total ratio", () => {
    const root = makeRoot("iss-hdr-root");
    root.lifecycle = AHPLifecycle.COMPLETE;
    root.verdict   = AHPVerdict.PASS;
    const bad = makeChild("iss-hdr-root", "iss-hdr-bad");
    bad.lifecycle = AHPLifecycle.FAILED;
    const good = makeChild("iss-hdr-root", "iss-hdr-good");
    good.lifecycle = AHPLifecycle.COMPLETE;
    good.verdict   = AHPVerdict.PASS;
    registerChildOnRoot(root, bad);
    registerChildOnRoot(root, good);
    const graph = serializeAHPPacketGraph(root, [bad, good]);
    const summary = formatAHPPacketGraphIssuesSummary(graph)!;

    // total=3, shown=2 (root for context + 1 bad child)
    expect(summary).toContain("(2/3)");
  });

  // ----- existing full-summary unchanged -----

  it("formatAHPPacketGraphSummary output is unchanged for root-only healthy graph", () => {
    const root = makeRoot("compat-root-1", "build the thing");
    root.lifecycle = AHPLifecycle.COMPLETE;
    root.verdict   = AHPVerdict.PASS;
    const graph = serializeAHPPacketGraph(root, []);
    const summary = formatAHPPacketGraphSummary(graph);

    expect(summary).toContain("AHP Packet Graph");
    expect(summary).toContain("compat-root-1");
    expect(summary).toContain("COMPLETE");
    expect(summary).toContain("(no child packets — single-run)");
    expect(summary).toContain("captured");
    // does NOT contain the issues-mode header
    expect(summary).not.toContain("AHP Issues");
  });

  it("formatAHPPacketGraphSummary includes ALL children including healthy ones", () => {
    const root = makeRoot("compat-root-2");
    root.lifecycle = AHPLifecycle.COMPLETE;
    const good = makeChild("compat-root-2", "compat-good");
    good.lifecycle = AHPLifecycle.COMPLETE;
    good.verdict   = AHPVerdict.PASS;
    const bad = makeChild("compat-root-2", "compat-bad");
    bad.lifecycle = AHPLifecycle.FAILED;
    registerChildOnRoot(root, good);
    registerChildOnRoot(root, bad);
    const graph = serializeAHPPacketGraph(root, [good, bad]);
    const summary = formatAHPPacketGraphSummary(graph);

    // full summary shows BOTH children
    expect(summary).toContain("compat-good");
    expect(summary).toContain("compat-bad");
  });
});
