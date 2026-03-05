/**
 * Safety checks — unit tests
 */

import { describe, it, expect } from "vitest";
import { runSafetyChecks } from "./safety.js";
import type { PappyInput } from "../types.js";

describe("runSafetyChecks — forbidDeletes", () => {
  it("flags a deleted file when forbidDeletes is true", () => {
    const issues = runSafetyChecks({
      task: "Refactor.",
      filesChanged: [{ path: "old.ts", changeType: "D" }],
      constraints: { forbidDeletes: true },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("SAFETY_FORBIDDEN_DELETE");
    expect(issues[0].severity).toBe("CRITICAL");
    expect(issues[0].evidence).toContain("old.ts");
  });

  it("flags every deleted file individually", () => {
    const issues = runSafetyChecks({
      task: "Refactor.",
      filesChanged: [
        { path: "a.ts", changeType: "D" },
        { path: "b.ts", changeType: "D" },
      ],
      constraints: { forbidDeletes: true },
    });
    expect(issues).toHaveLength(2);
  });

  it("does NOT flag deleted file when forbidDeletes is false", () => {
    const issues = runSafetyChecks({
      task: "Remove old file.",
      filesChanged: [{ path: "old.ts", changeType: "D" }],
      constraints: { forbidDeletes: false },
    });
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag modified or added files", () => {
    const issues = runSafetyChecks({
      task: "Refactor.",
      filesChanged: [
        { path: "a.ts", changeType: "M" },
        { path: "b.ts", changeType: "A" },
      ],
      constraints: { forbidDeletes: true },
    });
    expect(issues).toHaveLength(0);
  });

  it("is a no-op when filesChanged is empty", () => {
    const issues = runSafetyChecks({
      task: "Refactor.",
      constraints: { forbidDeletes: true },
    });
    expect(issues).toHaveLength(0);
  });
});

describe("runSafetyChecks — dangerous commands", () => {
  it("flags rm -rf in outputText", () => {
    const issues = runSafetyChecks({
      task: "Clean up.",
      outputText: "Run rm -rf /data to clean up.",
    });
    const dangerous = issues.filter((i) => i.code === "SAFETY_DANGEROUS_COMMAND");
    expect(dangerous).toHaveLength(1);
    expect(dangerous[0].severity).toBe("CRITICAL");
  });

  it("flags mkfs in outputText", () => {
    const issues = runSafetyChecks({
      task: "Format disk.",
      outputText: "Run mkfs.ext4 /dev/sdb to format.",
    });
    const dangerous = issues.filter((i) => i.code === "SAFETY_DANGEROUS_COMMAND");
    expect(dangerous.length).toBeGreaterThan(0);
  });

  it("flags diskpart in outputText", () => {
    const issues = runSafetyChecks({
      task: "Partition drive.",
      outputText: "Use diskpart to manage your partitions.",
    });
    const dangerous = issues.filter((i) => i.code === "SAFETY_DANGEROUS_COMMAND");
    expect(dangerous).toHaveLength(1);
  });

  it("flags rm --recursive in outputText", () => {
    const issues = runSafetyChecks({
      task: "Delete directory.",
      outputText: "rm --recursive ./build",
    });
    const dangerous = issues.filter((i) => i.code === "SAFETY_DANGEROUS_COMMAND");
    expect(dangerous).toHaveLength(1);
  });

  it("does not flag safe shell commands", () => {
    const issues = runSafetyChecks({
      task: "List files.",
      outputText: "Run ls -la to list files. Use cp to copy.",
    });
    const dangerous = issues.filter((i) => i.code === "SAFETY_DANGEROUS_COMMAND");
    expect(dangerous).toHaveLength(0);
  });

  it("returns empty array when no outputText", () => {
    const issues = runSafetyChecks({
      task: "Something.",
    });
    expect(issues).toHaveLength(0);
  });
});
