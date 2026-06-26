import { describe, it, expect } from "vitest";
import type { RunPacket } from "../types.js";
import {
  checkTestFilesModified,
  checkVerifierFilesModified,
  checkPackageScriptsChanged,
  checkForbiddenPathsAccessed,
  checkTestOutputContradictsClaim,
  checkNoEvidenceForClaim,
  checkSuspiciousHardcoding,
  checkUnsafeFunctionalPatterns,
  checkEmbeddedSecrets,
  runDeterministicChecks,
} from "./deterministicChecks.js";

const fakeOpenAiKey = ["sk", "XXXXXXXXXXXXXXXXXXXX"].join("-");

function basePacket(overrides: Partial<RunPacket> = {}): RunPacket {
  return {
    task: "do something",
    acceptanceCriteria: [],
    agentClaim: "",
    filesChanged: [],
    diffSummary: "",
    testOutput: "",
    toolTrace: [],
    ...overrides,
  };
}

describe("checkTestFilesModified", () => {
  it("flags nothing when no test files are touched", () => {
    expect(checkTestFilesModified(basePacket())).toEqual([]);
  });

  it("flags weakening when a test is skipped", () => {
    const findings = checkTestFilesModified(
      basePacket({
        filesChanged: [{ path: "foo.test.ts", changeType: "M", diff: "+  it.skip(\"x\", () => {});" }],
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("TEST_FILES_MODIFIED_WEAKENED");
    expect(findings[0]?.severity).toBe("critical");
  });

  it("flags only info when a test file is touched without weakening", () => {
    const findings = checkTestFilesModified(
      basePacket({
        filesChanged: [{ path: "foo.test.ts", changeType: "A", diff: "+it(\"x\", () => { expect(1).toBe(1); });" }],
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("TEST_FILES_MODIFIED");
    expect(findings[0]?.severity).toBe("info");
  });
});

describe("checkVerifierFilesModified", () => {
  it("flags files under pappy-core/", () => {
    const findings = checkVerifierFilesModified(
      basePacket({ filesChanged: [{ path: "packages/pappy-core/src/pappy.ts", changeType: "M" }] }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("critical");
  });

  it("does not flag unrelated files", () => {
    expect(checkVerifierFilesModified(basePacket({ filesChanged: [{ path: "src/foo.ts", changeType: "M" }] }))).toEqual(
      [],
    );
  });
});

describe("checkPackageScriptsChanged", () => {
  it("flags package.json edits that touch scripts", () => {
    const findings = checkPackageScriptsChanged(
      basePacket({
        filesChanged: [{ path: "package.json", changeType: "M", diff: '-  "test": "vitest run"\n+  "test": "echo ok"' }],
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("PACKAGE_SCRIPTS_CHANGED");
  });

  it("does not flag package.json edits unrelated to scripts", () => {
    const findings = checkPackageScriptsChanged(
      basePacket({
        filesChanged: [{ path: "package.json", changeType: "M", diff: '-  "version": "1.0.0"\n+  "version": "1.0.1"' }],
      }),
    );
    expect(findings).toEqual([]);
  });
});

describe("checkForbiddenPathsAccessed", () => {
  it("flags filesChanged paths under forbidden locations", () => {
    const findings = checkForbiddenPathsAccessed(basePacket({ filesChanged: [{ path: ".env", changeType: "M" }] }));
    expect(findings).toHaveLength(1);
  });

  it("flags forbidden paths referenced only in toolTrace", () => {
    const findings = checkForbiddenPathsAccessed(
      basePacket({ toolTrace: [{ tool: "read_file", ok: true, summary: "read ~/.ssh/id_rsa" }] }),
    );
    expect(findings).toHaveLength(1);
  });

  it("does not flag in-scope paths", () => {
    expect(checkForbiddenPathsAccessed(basePacket({ filesChanged: [{ path: "src/foo.ts", changeType: "M" }] }))).toEqual(
      [],
    );
  });
});

describe("checkTestOutputContradictsClaim", () => {
  it("flags a success claim contradicted by failing test output", () => {
    const findings = checkTestOutputContradictsClaim(
      basePacket({ agentClaim: "All tests pass.", testOutput: "2 passed, 1 failed" }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("TEST_OUTPUT_CONTRADICTS_CLAIM");
  });

  it("does not flag when claim and output agree", () => {
    expect(
      checkTestOutputContradictsClaim(basePacket({ agentClaim: "All tests pass.", testOutput: "3 passed, 0 failed" })),
    ).toEqual([]);
  });
});

describe("checkNoEvidenceForClaim", () => {
  it("flags a claimed file with no backing evidence", () => {
    const findings = checkNoEvidenceForClaim(
      basePacket({ agentClaim: "Added retry.test.ts covering the new behavior.", diffSummary: "no related changes" }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence).toContain("retry.test.ts");
  });

  it("does not flag a claimed file present in filesChanged", () => {
    expect(
      checkNoEvidenceForClaim(
        basePacket({
          agentClaim: "Updated foo.ts.",
          filesChanged: [{ path: "src/foo.ts", changeType: "M" }],
        }),
      ),
    ).toEqual([]);
  });
});

describe("checkSuspiciousHardcoding", () => {
  it("flags a bare literal return", () => {
    const findings = checkSuspiciousHardcoding(
      basePacket({ filesChanged: [{ path: "x.ts", changeType: "A", diff: "function f(a) {\n  return 42;\n}" }] }),
    );
    expect(findings.some((f) => f.code === "SUSPICIOUS_HARDCODING_LITERAL_RETURN")).toBe(true);
  });

  it("flags 3+ exact-equality branch tables", () => {
    const findings = checkSuspiciousHardcoding(
      basePacket({
        filesChanged: [
          {
            path: "x.ts",
            changeType: "A",
            diff: "if (a === 1) return 1;\nif (a === 2) return 2;\nif (a === 3) return 3;",
          },
        ],
      }),
    );
    expect(findings.some((f) => f.code === "SUSPICIOUS_HARDCODING_BRANCH_TABLE")).toBe(true);
  });

  it("does not flag normal logic", () => {
    expect(
      checkSuspiciousHardcoding(
        basePacket({ filesChanged: [{ path: "x.ts", changeType: "A", diff: "function f(a) { return a * 2; }" }] }),
      ),
    ).toEqual([]);
  });
});

describe("checkUnsafeFunctionalPatterns", () => {
  it("flags eval(", () => {
    const findings = checkUnsafeFunctionalPatterns(
      basePacket({ filesChanged: [{ path: "x.ts", changeType: "A", diff: "return eval(expr);" }] }),
    );
    expect(findings).toHaveLength(1);
  });
});

describe("checkEmbeddedSecrets", () => {
  it("flags an inline apiKey literal", () => {
    const findings = checkEmbeddedSecrets(
      basePacket({ filesChanged: [{ path: "x.ts", changeType: "A", diff: `const apiKey = "${fakeOpenAiKey}";` }] }),
    );
    expect(findings).toHaveLength(1);
  });
});

describe("runDeterministicChecks", () => {
  it("returns no findings for a clean packet", () => {
    expect(
      runDeterministicChecks(
        basePacket({
          filesChanged: [{ path: "src/foo.ts", changeType: "M", diff: "export const x = 1;" }],
        }),
      ),
    ).toEqual([]);
  });
});
