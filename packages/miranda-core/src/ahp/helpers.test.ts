/**
 * AHP helpers — unit tests
 *
 * Covers: createRootPacket, createChildPacket, registerChildOnRoot,
 *         deriveRootLifecycleFromChildren, appendAHPTrace, isTerminalAHPLifecycle.
 */

import { describe, it, expect } from "vitest";
import { AHPLifecycle, AHPPacketRole } from "./types.js";
import type { AHPPacket } from "./types.js";
import {
  appendAHPTrace,
  isTerminalAHPLifecycle,
  createRootPacket,
  createChildPacket,
  registerChildOnRoot,
  deriveRootLifecycleFromChildren,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoot(id = "root-1"): AHPPacket {
  return createRootPacket({
    id,
    objective: "Test objective",
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
// createRootPacket
// ---------------------------------------------------------------------------

describe("createRootPacket", () => {
  it("sets role to Root", () => {
    expect(makeRoot().role).toBe(AHPPacketRole.Root);
  });

  it("sets lifecycle to PENDING", () => {
    expect(makeRoot().lifecycle).toBe(AHPLifecycle.PENDING);
  });

  it("has no parentPacketId", () => {
    expect(makeRoot().parentPacketId).toBeUndefined();
  });

  it("initialises childPacketIds as empty array", () => {
    expect(makeRoot().childPacketIds).toEqual([]);
  });

  it("populates id and objective verbatim", () => {
    const p = createRootPacket({
      id: "my-run-root",
      objective:      "Do the thing",
      expectedOutput: { schema: {}, acceptanceCriteria: ["AC1"] },
    });
    expect(p.id).toBe("my-run-root");
    expect(p.objective).toBe("Do the thing");
  });

  it("uses provided acceptance criteria", () => {
    const p = createRootPacket({
      id: "r1",
      objective: "x",
      expectedOutput: { schema: {}, acceptanceCriteria: ["goal A", "goal B"] },
    });
    expect(p.expectedOutput.acceptanceCriteria).toEqual(["goal A", "goal B"]);
  });

  it("initialises trace as empty array", () => {
    expect(makeRoot().trace).toEqual([]);
  });

  it("sets meta ackRequired to false", () => {
    expect(makeRoot().meta.ackRequired).toBe(false);
  });

  it("sets meta createdAt and updatedAt to ISO strings", () => {
    const p = makeRoot();
    expect(() => new Date(p.meta.createdAt)).not.toThrow();
    expect(() => new Date(p.meta.updatedAt)).not.toThrow();
    expect(p.meta.createdAt).toBe(p.meta.updatedAt);
  });

  it("leaves startedAt and completedAt undefined", () => {
    const p = makeRoot();
    expect(p.meta.startedAt).toBeUndefined();
    expect(p.meta.completedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createChildPacket
// ---------------------------------------------------------------------------

describe("createChildPacket", () => {
  it("sets role to Child", () => {
    expect(makeChild("root-1").role).toBe(AHPPacketRole.Child);
  });

  it("sets parentPacketId to the provided parent id", () => {
    expect(makeChild("root-abc").parentPacketId).toBe("root-abc");
  });

  it("sets lifecycle to PENDING", () => {
    expect(makeChild("root-1").lifecycle).toBe(AHPLifecycle.PENDING);
  });

  it("does NOT have a childPacketIds array (leaf packet)", () => {
    // childPacketIds is only initialised on root packets
    expect(makeChild("root-1").childPacketIds).toBeUndefined();
  });

  it("populates id and objective verbatim", () => {
    const c = createChildPacket("root-1", {
      id: "branch-2",
      objective: "Branch work",
      expectedOutput: { schema: {}, acceptanceCriteria: [] },
    });
    expect(c.id).toBe("branch-2");
    expect(c.objective).toBe("Branch work");
  });

  it("accepts distinct acceptance criteria from the root", () => {
    const c = createChildPacket("root-1", {
      id: "c1",
      objective: "write a sorting function",
      expectedOutput: { schema: {}, acceptanceCriteria: ["sorts correctly"] },
    });
    expect(c.expectedOutput.acceptanceCriteria).toContain("sorts correctly");
  });

  it("does not share the trace array with any other packet object", () => {
    const c1 = makeChild("root-1", "c1");
    const c2 = makeChild("root-1", "c2");
    expect(c1.trace).not.toBe(c2.trace);
  });
});

// ---------------------------------------------------------------------------
// registerChildOnRoot
// ---------------------------------------------------------------------------

describe("registerChildOnRoot", () => {
  it("appends child id to root.childPacketIds", () => {
    const root  = makeRoot();
    const child = makeChild(root.id);
    registerChildOnRoot(root, child);
    expect(root.childPacketIds).toContain(child.id);
  });

  it("is idempotent — calling twice does not duplicate the id", () => {
    const root  = makeRoot();
    const child = makeChild(root.id);
    registerChildOnRoot(root, child);
    registerChildOnRoot(root, child);
    expect(root.childPacketIds?.filter((id) => id === child.id)).toHaveLength(1);
  });

  it("can register multiple different children", () => {
    const root = makeRoot();
    const c1   = makeChild(root.id, "c1");
    const c2   = makeChild(root.id, "c2");
    const c3   = makeChild(root.id, "c3");
    registerChildOnRoot(root, c1);
    registerChildOnRoot(root, c2);
    registerChildOnRoot(root, c3);
    expect(root.childPacketIds).toEqual(["c1", "c2", "c3"]);
  });

  it("initialises childPacketIds on a root that somehow has undefined (defensive)", () => {
    const root = makeRoot();
    // Simulate a legacy root where the array was not initialised
    (root as { childPacketIds?: string[] }).childPacketIds = undefined;
    const child = makeChild(root.id);
    registerChildOnRoot(root, child);
    expect(root.childPacketIds).toContain(child.id);
  });

  it("does not mutate the child packet", () => {
    const root  = makeRoot();
    const child = makeChild(root.id);
    const childBefore = JSON.stringify(child);
    registerChildOnRoot(root, child);
    // Child should be unchanged (its parentPacketId was already set by createChildPacket)
    expect(JSON.stringify(child)).toBe(childBefore);
  });
});

// ---------------------------------------------------------------------------
// deriveRootLifecycleFromChildren
// ---------------------------------------------------------------------------

describe("deriveRootLifecycleFromChildren", () => {
  function childWith(lifecycle: AHPLifecycle): AHPPacket {
    const c = makeChild("root-1", `c-${lifecycle}`);
    c.lifecycle = lifecycle;
    return c;
  }

  it("returns INCONCLUSIVE when children list is empty", () => {
    expect(deriveRootLifecycleFromChildren([])).toBe(AHPLifecycle.INCONCLUSIVE);
  });

  it("returns COMPLETE when all children are COMPLETE", () => {
    expect(deriveRootLifecycleFromChildren([
      childWith(AHPLifecycle.COMPLETE),
      childWith(AHPLifecycle.COMPLETE),
    ])).toBe(AHPLifecycle.COMPLETE);
  });

  it("returns FAILED when any child is FAILED (others COMPLETE)", () => {
    expect(deriveRootLifecycleFromChildren([
      childWith(AHPLifecycle.COMPLETE),
      childWith(AHPLifecycle.FAILED),
    ])).toBe(AHPLifecycle.FAILED);
  });

  it("returns INCONCLUSIVE when any child is INCONCLUSIVE (higher precedence than FAILED)", () => {
    expect(deriveRootLifecycleFromChildren([
      childWith(AHPLifecycle.FAILED),
      childWith(AHPLifecycle.INCONCLUSIVE),
    ])).toBe(AHPLifecycle.INCONCLUSIVE);
  });

  it("returns INCONCLUSIVE when any child is INCONCLUSIVE (others COMPLETE)", () => {
    expect(deriveRootLifecycleFromChildren([
      childWith(AHPLifecycle.COMPLETE),
      childWith(AHPLifecycle.INCONCLUSIVE),
    ])).toBe(AHPLifecycle.INCONCLUSIVE);
  });

  it("returns INCONCLUSIVE when children are still RUNNING (non-terminal mix)", () => {
    expect(deriveRootLifecycleFromChildren([
      childWith(AHPLifecycle.RUNNING),
      childWith(AHPLifecycle.COMPLETE),
    ])).toBe(AHPLifecycle.INCONCLUSIVE);
  });

  it("returns INCONCLUSIVE for a single PENDING child", () => {
    expect(deriveRootLifecycleFromChildren([
      childWith(AHPLifecycle.PENDING),
    ])).toBe(AHPLifecycle.INCONCLUSIVE);
  });

  it("returns FAILED for a single FAILED child", () => {
    expect(deriveRootLifecycleFromChildren([
      childWith(AHPLifecycle.FAILED),
    ])).toBe(AHPLifecycle.FAILED);
  });

  it("returns COMPLETE for a single COMPLETE child", () => {
    expect(deriveRootLifecycleFromChildren([
      childWith(AHPLifecycle.COMPLETE),
    ])).toBe(AHPLifecycle.COMPLETE);
  });

  it("INCONCLUSIVE > FAILED > COMPLETE precedence with all three present", () => {
    expect(deriveRootLifecycleFromChildren([
      childWith(AHPLifecycle.COMPLETE),
      childWith(AHPLifecycle.FAILED),
      childWith(AHPLifecycle.INCONCLUSIVE),
    ])).toBe(AHPLifecycle.INCONCLUSIVE);
  });

  it("FAILED > COMPLETE when no INCONCLUSIVE", () => {
    expect(deriveRootLifecycleFromChildren([
      childWith(AHPLifecycle.COMPLETE),
      childWith(AHPLifecycle.COMPLETE),
      childWith(AHPLifecycle.FAILED),
    ])).toBe(AHPLifecycle.FAILED);
  });

  it("accepts ReadonlyArray input (type compatibility)", () => {
    const children: ReadonlyArray<AHPPacket> = [childWith(AHPLifecycle.COMPLETE)];
    expect(deriveRootLifecycleFromChildren(children)).toBe(AHPLifecycle.COMPLETE);
  });
});

// ---------------------------------------------------------------------------
// Hierarchy integrity: root/child independence
// ---------------------------------------------------------------------------

describe("Packet hierarchy integrity", () => {
  it("root and child do not share a meta object", () => {
    const root  = makeRoot();
    const child = makeChild(root.id);
    expect(root.meta).not.toBe(child.meta);
  });

  it("child knows its parent id; root knows the child id after registration", () => {
    const root  = makeRoot("root-42");
    const child = makeChild("root-42", "child-7");
    registerChildOnRoot(root, child);

    expect(child.parentPacketId).toBe("root-42");
    expect(root.childPacketIds).toContain("child-7");
  });

  it("root and child have distinct ids", () => {
    const root  = makeRoot("root-x");
    const child = makeChild("root-x", "child-x");
    expect(root.id).not.toBe(child.id);
  });

  it("worker trace appended to child does not appear on root", () => {
    const root  = makeRoot();
    const child = makeChild(root.id);
    appendAHPTrace(child, {
      timestamp: new Date().toISOString(),
      state: AHPLifecycle.RUNNING,
      actor: "worker",
      note: "worker did work",
    });
    expect(root.trace).toHaveLength(0);
    expect(child.trace).toHaveLength(1);
  });

  it("parallel children with concurrent trace appends do not share state", () => {
    const root = makeRoot();
    const c1   = makeChild(root.id, "c1");
    const c2   = makeChild(root.id, "c2");

    appendAHPTrace(c1, { timestamp: "t1", state: AHPLifecycle.RUNNING, actor: "worker-a" });
    appendAHPTrace(c1, { timestamp: "t2", state: AHPLifecycle.COMPLETE, actor: "worker-a" });
    appendAHPTrace(c2, { timestamp: "t3", state: AHPLifecycle.RUNNING, actor: "worker-b" });

    expect(c1.trace).toHaveLength(2);
    expect(c2.trace).toHaveLength(1);
    expect(root.trace).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// isTerminalAHPLifecycle (already covered in evaluator tests — sanity check)
// ---------------------------------------------------------------------------

describe("isTerminalAHPLifecycle", () => {
  it("COMPLETE is terminal", () => expect(isTerminalAHPLifecycle(AHPLifecycle.COMPLETE)).toBe(true));
  it("FAILED is terminal",   () => expect(isTerminalAHPLifecycle(AHPLifecycle.FAILED)).toBe(true));
  it("INCONCLUSIVE is terminal", () => expect(isTerminalAHPLifecycle(AHPLifecycle.INCONCLUSIVE)).toBe(true));
  it("PENDING is not terminal",  () => expect(isTerminalAHPLifecycle(AHPLifecycle.PENDING)).toBe(false));
  it("RUNNING is not terminal",  () => expect(isTerminalAHPLifecycle(AHPLifecycle.RUNNING)).toBe(false));
});
