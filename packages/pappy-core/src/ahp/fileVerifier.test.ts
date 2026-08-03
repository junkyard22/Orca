/**
 * Pappy — File Change Verifier unit tests
 *
 * Covers:
 *   - extractExpectedPaths: backtick, double-quote, single-quote, bare slash paths
 *   - verifyFileChanges with TaskType.FileWrite: all three checks
 *   - verifyFileChanges with TaskType.CodeEdit: two checks (content + side effects)
 *   - verifyFileChanges with other task types: returns empty overrides
 *   - Integration: actual file content check via workspaceRoot (tmp files)
 *   - Edge cases: empty filesChanged, no paths in objective, deletions
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs   from "fs";
import * as path from "path";
import * as os   from "os";
import { AHPLifecycle } from "@clawde/miranda-core";
import type { AHPPacket } from "@clawde/miranda-core";
import { TaskType } from "./taskClassifier.js";
import { extractExpectedPaths, verifyFileChanges } from "./fileVerifier.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePacket(
  objective: string,
  acs: string[] = [],
): AHPPacket {
  return {
    id:        "test-fp",
    objective,
    lifecycle: AHPLifecycle.RUNNING,
    inputs:    [],
    constraints: [],
    expectedOutput: { schema: {}, acceptanceCriteria: acs },
    trace: [],
    meta: {
      ackRequired: false,
      createdAt:   new Date().toISOString(),
      updatedAt:   new Date().toISOString(),
    },
  };
}

type FileItem = { path: string; diff?: string; changeType?: "A" | "M" | "D" };

// ---------------------------------------------------------------------------
// extractExpectedPaths
// ---------------------------------------------------------------------------

describe("extractExpectedPaths", () => {
  it("extracts backtick-quoted paths", () => {
    const paths = extractExpectedPaths("Create `src/auth/login.ts` with the new handler");
    expect(paths).toContain("src/auth/login.ts");
  });

  it("extracts double-quoted paths", () => {
    const paths = extractExpectedPaths(`Write "config/settings.json" with defaults`);
    expect(paths).toContain("config/settings.json");
  });

  it("extracts single-quoted paths", () => {
    const paths = extractExpectedPaths("Save the output to 'dist/bundle.js'");
    expect(paths).toContain("dist/bundle.js");
  });

  it("extracts bare slash paths", () => {
    const paths = extractExpectedPaths("Generate src/utils/helpers.ts for utilities");
    expect(paths).toContain("src/utils/helpers.ts");
  });

  it("returns empty array when no file paths are present", () => {
    expect(extractExpectedPaths("Explain what recursion means")).toHaveLength(0);
  });

  it("ignores paths without a recognised extension", () => {
    // "some/path/without" has no extension — should not be extracted
    const paths = extractExpectedPaths("Touch some/path/without and also src/real.ts");
    expect(paths).not.toContain("some/path/without");
    expect(paths).toContain("src/real.ts");
  });

  it("deduplicates extracted paths", () => {
    const paths = extractExpectedPaths("`src/foo.ts` and `src/foo.ts` again");
    expect(paths.filter((p) => p === "src/foo.ts")).toHaveLength(1);
  });

  it("does not extract plain words with spaces", () => {
    const paths = extractExpectedPaths("`not a path with spaces.ts`");
    expect(paths).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// verifyFileChanges — non-file task types
// ---------------------------------------------------------------------------

describe("verifyFileChanges — non-file task types", () => {
  it("returns empty overrides for Explanation tasks", () => {
    const packet = makePacket("Explain what dependency injection means");
    const result = verifyFileChanges(packet, {}, TaskType.Explanation);
    expect(result.size).toBe(0);
  });

  it("returns empty overrides for Research tasks", () => {
    const packet = makePacket("Research the best caching strategies");
    const result = verifyFileChanges(packet, {}, TaskType.Research);
    expect(result.size).toBe(0);
  });

  it("returns empty overrides for Other tasks", () => {
    const packet = makePacket("Do the thing");
    const result = verifyFileChanges(packet, {}, TaskType.Other);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyFileChanges — FileWrite task type
// ---------------------------------------------------------------------------

describe("verifyFileChanges — FileWrite: file exists check", () => {
  it("passes when expected path appears in filesChanged", () => {
    const packet = makePacket("Create the file `src/auth.ts`");
    const files: FileItem[] = [{ path: "src/auth.ts", changeType: "A" }];
    const overrides = verifyFileChanges(packet, { filesChanged: files }, TaskType.FileWrite);

    const check = overrides.get("file exists at expected path")!;
    expect(check).toBeDefined();
    expect(check.passed).toBe(true);
    expect(check.evidence).toContain("src/auth.ts");
  });

  it("fails when expected path is missing from filesChanged and workspaceRoot not given", () => {
    const packet = makePacket("Create the file `src/missing.ts`");
    const files: FileItem[] = [{ path: "src/other.ts", changeType: "A" }];
    const overrides = verifyFileChanges(packet, { filesChanged: files }, TaskType.FileWrite);

    const check = overrides.get("file exists at expected path")!;
    expect(check.passed).toBe(false);
    expect(check.evidence).toContain("src/missing.ts");
  });

  it("passes with suffix match (absolute path in filesChanged, relative in objective)", () => {
    const packet = makePacket("Create `utils/format.ts`");
    const files: FileItem[] = [{ path: "/workspace/project/utils/format.ts", changeType: "A" }];
    const overrides = verifyFileChanges(packet, { filesChanged: files }, TaskType.FileWrite);

    expect(overrides.get("file exists at expected path")!.passed).toBe(true);
  });

  it("fails closed when an ambiguous file-write task has no file receipt", () => {
    const packet = makePacket("Write a config file for the server");
    const overrides = verifyFileChanges(packet, { filesChanged: [] }, TaskType.FileWrite);
    const check = overrides.get("file exists at expected path")!;
    expect(check.passed).toBe(false);
    expect(check.evidence).toContain("no explicit");
  });

  it("produces overrides for all three FileWrite ACs", () => {
    const packet = makePacket("Create `dist/out.js`");
    const overrides = verifyFileChanges(
      packet,
      { filesChanged: [{ path: "dist/out.js", changeType: "A", diff: "export const x = 1;" }] },
      TaskType.FileWrite,
    );
    expect(overrides.has("file exists at expected path")).toBe(true);
    expect(overrides.has("content matches described intent")).toBe(true);
    expect(overrides.has("no unintended files created")).toBe(true);
    // CodeEdit ACs must NOT be in overrides
    expect(overrides.has("the change matches the described intent")).toBe(false);
  });
});

describe("verifyFileChanges — FileWrite: content match check", () => {
  it("passes when diff contains keywords from objective", () => {
    const packet = makePacket("Create an authentication module with login function");
    const files: FileItem[] = [{
      path:       "src/auth.ts",
      changeType: "A",
      diff:       "export function login(user: string) { return authenticate(user); }",
    }];
    const overrides = verifyFileChanges(packet, { filesChanged: files }, TaskType.FileWrite);
    expect(overrides.get("content matches described intent")!.passed).toBe(true);
  });

  it("fails closed when filesChanged has no content receipt", () => {
    const packet = makePacket("Create a handler with logging");
    const overrides = verifyFileChanges(packet, { filesChanged: [] }, TaskType.FileWrite);
    const check = overrides.get("content matches described intent")!;
    expect(check.passed).toBe(false);
    expect(check.evidence).toContain("no file content");
  });

  it("fails when diff content has no keywords matching objective", () => {
    const packet = makePacket("Create a TypeScript authentication handler with JWT validation");
    const files: FileItem[] = [{
      path:       "src/unrelated.ts",
      changeType: "A",
      diff:       "const x = 1; const y = 2; const z = x + y;",
    }];
    const overrides = verifyFileChanges(packet, { filesChanged: files }, TaskType.FileWrite);
    // authentication, handler, validation keywords should not appear in the diff
    expect(overrides.get("content matches described intent")!.passed).toBe(false);
  });

  it("does not treat a deleted file as a content receipt", () => {
    const packet = makePacket("Delete the old logger");
    const files: FileItem[] = [{ path: "src/logger.ts", changeType: "D" }];
    const overrides = verifyFileChanges(packet, { filesChanged: files }, TaskType.FileWrite);
    expect(overrides.get("content matches described intent")!.passed).toBe(false);
  });
});

describe("verifyFileChanges — FileWrite: no unintended files check", () => {
  it("passes when all changed files are within expected scope", () => {
    const packet = makePacket("Create `src/auth.ts`");
    const files: FileItem[] = [{ path: "src/auth.ts", changeType: "A" }];
    const overrides = verifyFileChanges(packet, { filesChanged: files }, TaskType.FileWrite);
    expect(overrides.get("no unintended files created")!.passed).toBe(true);
  });

  it("fails when an unexpected deletion occurs", () => {
    const packet = makePacket("Create `src/auth.ts`");
    const files: FileItem[] = [
      { path: "src/auth.ts",    changeType: "A" },
      { path: "src/legacy.ts", changeType: "D" }, // unexpected deletion
    ];
    const overrides = verifyFileChanges(packet, { filesChanged: files }, TaskType.FileWrite);
    const check = overrides.get("no unintended files created")!;
    expect(check.passed).toBe(false);
    expect(check.evidence).toContain("src/legacy.ts");
  });

  it("passes with no filesChanged", () => {
    const packet = makePacket("Create `src/foo.ts`");
    const overrides = verifyFileChanges(packet, { filesChanged: [] }, TaskType.FileWrite);
    expect(overrides.get("no unintended files created")!.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyFileChanges — CodeEdit task type
// ---------------------------------------------------------------------------

describe("verifyFileChanges — CodeEdit", () => {
  it("produces overrides only for CodeEdit ACs (not FileWrite ACs)", () => {
    const packet = makePacket("Refactor the authentication module");
    const overrides = verifyFileChanges(packet, { filesChanged: [] }, TaskType.CodeEdit);

    expect(overrides.has("the change matches the described intent")).toBe(true);
    expect(overrides.has("no unintended files modified")).toBe(true);
    // FileWrite-only ACs must not be set
    expect(overrides.has("file exists at expected path")).toBe(false);
    expect(overrides.has("content matches described intent")).toBe(false);
    // "existing tests continue to pass" should also NOT be in overrides
    expect(overrides.has("existing tests continue to pass")).toBe(false);
  });

  it("passes change-matches when modified file diff reflects objective", () => {
    const packet = makePacket("Refactor the authentication module to remove duplication");
    const files: FileItem[] = [{
      path:       "src/auth.ts",
      changeType: "M",
      // diff contains 'refactor', 'authentication', 'module', 'duplication' keywords
      diff:       "// refactor: authentication module — removed duplication\n" +
                  "export function authenticate(user: string) { return verifyToken(user); }",
    }];
    const overrides = verifyFileChanges(packet, { filesChanged: files }, TaskType.CodeEdit);
    expect(overrides.get("the change matches the described intent")!.passed).toBe(true);
  });

  it("fails no-unintended-modifications when out-of-scope file is changed", () => {
    const packet = makePacket("Fix the bug in `src/parser.ts`");
    const files: FileItem[] = [
      { path: "src/parser.ts",       changeType: "M" },
      { path: "public/styles.css",   changeType: "M" }, // completely unrelated directory
    ];
    const overrides = verifyFileChanges(packet, { filesChanged: files }, TaskType.CodeEdit);
    const check = overrides.get("no unintended files modified")!;
    expect(check.passed).toBe(false);
    expect(check.evidence).toContain("public/styles.css");
  });

  it("passes no-unintended-modifications when changes stay within expected scope dir", () => {
    const packet = makePacket("Update `src/auth/login.ts` and `src/auth/logout.ts`");
    const files: FileItem[] = [
      { path: "src/auth/login.ts",  changeType: "M" },
      { path: "src/auth/logout.ts", changeType: "M" },
      { path: "src/auth/types.ts",  changeType: "M" }, // same directory — in scope
    ];
    const overrides = verifyFileChanges(packet, { filesChanged: files }, TaskType.CodeEdit);
    expect(overrides.get("no unintended files modified")!.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyFileChanges — disk integration (uses a real tmp dir)
// ---------------------------------------------------------------------------

describe("verifyFileChanges — disk integration", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pappy-fv-"));
    // Create a real test file
    fs.writeFileSync(
      path.join(tmpDir, "handler.ts"),
      "export function handleRequest(req: Request) { return authenticate(req); }",
      "utf8",
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("file exists check passes when file is on disk (even with empty filesChanged)", () => {
    const packet = makePacket("Create `handler.ts` for request handling");
    const overrides = verifyFileChanges(
      packet,
      { filesChanged: [], workspaceRoot: tmpDir },
      TaskType.FileWrite,
    );
    expect(overrides.get("file exists at expected path")!.passed).toBe(true);
  });

  it("content check reads actual file content from disk", () => {
    const packet = makePacket("Create a handler that authenticates the request");
    const files: FileItem[] = [{ path: "handler.ts", changeType: "A" }];
    const overrides = verifyFileChanges(
      packet,
      { filesChanged: files, workspaceRoot: tmpDir },
      TaskType.FileWrite,
    );
    // 'authenticate' is in both the objective and the file → should match
    expect(overrides.get("content matches described intent")!.passed).toBe(true);
  });

  it("file exists check fails for a path not on disk", () => {
    const packet = makePacket("Create `nonexistent.ts`");
    const overrides = verifyFileChanges(
      packet,
      { filesChanged: [], workspaceRoot: tmpDir },
      TaskType.FileWrite,
    );
    expect(overrides.get("file exists at expected path")!.passed).toBe(false);
    expect(overrides.get("file exists at expected path")!.evidence).toContain("nonexistent.ts");
  });

  it("does not read an expected absolute path outside the workspace", () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pappy-fv-outside-"));
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "secret", "utf8");

    try {
      const packet = makePacket(`Create '${outsideFile}'`);
      const overrides = verifyFileChanges(
        packet,
        { filesChanged: [], workspaceRoot: tmpDir },
        TaskType.FileWrite,
      );
      expect(overrides.get("file exists at expected path")!.passed).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("does not accept an out-of-workspace filesChanged entry as a receipt", () => {
    const outsideFile = path.resolve(tmpDir, "..", "outside-receipt.txt");
    const packet = makePacket(`Create '${outsideFile}'`);
    const overrides = verifyFileChanges(
      packet,
      {
        filesChanged: [{ path: outsideFile, changeType: "A", diff: "outside" }],
        workspaceRoot: tmpDir,
      },
      TaskType.FileWrite,
    );

    expect(overrides.get("file exists at expected path")!.passed).toBe(false);
  });
});
