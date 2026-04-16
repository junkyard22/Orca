/**
 * Claim-proof checks — unit tests
 *
 * Verifies that Pappy extracts file/command/test claims from outputText and
 * correctly cross-references them against the available trace.
 */

import { describe, it, expect } from "vitest";
import { runClaimProofChecks } from "./claimProof.js";

// ---------------------------------------------------------------------------
// No claims in output
// ---------------------------------------------------------------------------

describe("runClaimProofChecks — no claims", () => {
  it("returns empty issues, ledger, claims for text with no verifiable assertions", () => {
    const { issues, ledger, claims } = runClaimProofChecks({
      task: "Explain binary search.",
      outputText: "Binary search is efficient.",
    });
    // PROOF_NO_TRACE fires since there's no trace, but no claim-specific issues
    const claimIssues = issues.filter((i) => i.code === "PROOF_CLAIM_UNVERIFIED");
    expect(claimIssues).toHaveLength(0);
    expect(claims).toHaveLength(0);
    expect(ledger).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// File modification claims
// ---------------------------------------------------------------------------

describe("runClaimProofChecks — file modification claims", () => {
  it("extracts a file modification claim and marks it MISSING when no filesChanged", () => {
    const { issues, ledger, claims } = runClaimProofChecks({
      task: "Update config.",
      outputText: "I updated `config.ts` with the new settings.",
      toolEvents: [{ tool: "read_file", ok: true, summary: "read" }], // trace present
    });
    const claim = claims.find((c) => c.text.includes("config.ts"));
    expect(claim).toBeDefined();

    const entry = ledger.find((e) => e.ref === claim?.id);
    expect(entry?.status).toBe("MISSING");

    const issue = issues.find((i) => i.code === "PROOF_CLAIM_UNVERIFIED");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("HIGH"); // trace is present → HIGH
  });

  it("marks claim PROVED when matching filesChanged entry exists", () => {
    const { issues, ledger, claims } = runClaimProofChecks({
      task: "Update config.",
      outputText: "I updated `config.ts` with the new settings.",
      filesChanged: [{ path: "config.ts", changeType: "M", diff: "changed = true;" }],
    });
    const claim = claims.find((c) => c.text.includes("config.ts"));
    expect(claim).toBeDefined();

    const entry = ledger.find((e) => e.ref === claim?.id);
    expect(entry?.status).toBe("PROVED");

    const unverified = issues.filter((i) => i.code === "PROOF_CLAIM_UNVERIFIED");
    expect(unverified).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// File creation claims
// ---------------------------------------------------------------------------

describe("runClaimProofChecks — file creation claims", () => {
  it("does NOT flag creation claims when write_file succeeded for the matching path", () => {
    const { issues, claims } = runClaimProofChecks({
      task: "Create auth.ts.",
      outputText: "I created `auth.ts` for you.",
      toolEvents: [{ tool: "write_file", ok: true, summary: "written", raw: { path: "auth.ts" } }],
    });
    expect(claims.some((claim) => claim.text.includes("auth.ts"))).toBe(true);

    const unverified = issues.filter((i) => i.code === "PROOF_CLAIM_UNVERIFIED");
    expect(unverified).toHaveLength(0);
  });

  it("flags creation claims when write_file failed for the matching path", () => {
    const { issues } = runClaimProofChecks({
      task: "Create auth.ts.",
      outputText: "I created `auth.ts` for you.",
      toolEvents: [{ tool: "write_file", ok: false, summary: "write failed", raw: { path: "auth.ts" } }],
    });

    const unverified = issues.filter((i) => i.code === "PROOF_CLAIM_UNVERIFIED");
    expect(unverified.length).toBeGreaterThan(0);
  });

  it("PROVES creation claim when filesChanged has matching A entry", () => {
    const { issues } = runClaimProofChecks({
      task: "Create auth.ts.",
      outputText: "I created `auth.ts` for authentication.",
      filesChanged: [{ path: "auth.ts", changeType: "A", diff: "export {};" }],
    });
    const unverified = issues.filter((i) => i.code === "PROOF_CLAIM_UNVERIFIED");
    expect(unverified).toHaveLength(0);
  });

  it("flags creation claims when there is no matching write_file tool event and no filesChanged entry", () => {
    const { issues } = runClaimProofChecks({
      task: "Create auth.ts.",
      outputText: "I created `auth.ts` for you.",
      toolEvents: [{ tool: "read_file", ok: true, summary: "read", raw: { path: "auth.ts" } }],
    });

    const unverified = issues.filter((i) => i.code === "PROOF_CLAIM_UNVERIFIED");
    expect(unverified.length).toBeGreaterThan(0);
  });
});

describe("runClaimProofChecks — test command claims", () => {
  it("does NOT flag a tests-passed claim when a successful pytest run_command event is present", () => {
    const { issues } = runClaimProofChecks({
      task: "Create calculator and run tests.",
      outputText: "I created the files and tests passed.",
      toolEvents: [
        {
          tool: "run_command",
          ok: true,
          summary: "run_command: ok (835 chars)",
          raw: { command: "python -m pytest tmp-test/prompt2_calculator_test.py -v" },
        },
      ],
    });

    expect(issues.filter((issue) => issue.code === "PROOF_CLAIM_UNVERIFIED")).toHaveLength(0);
  });

  it("does NOT treat explicitly negated command execution as an action claim", () => {
    const { issues, claims } = runClaimProofChecks({
      task: "Check this app.",
      outputText: [
        "Runtime commands:",
        "- npm test: allowed not run - Approved recipe after preflight and classification, but audit mode is read-first and did not execute commands automatically.",
      ].join("\n"),
      toolEvents: [
        { tool: "audit_preflight", ok: true, summary: "audit_preflight: exists=true" },
        { tool: "audit_command_policy", ok: true, summary: "audit_command_policy: recipes=3; decisions=3" },
      ],
    });

    expect(claims.some((claim) => /execute/i.test(claim.text))).toBe(false);
    expect(issues.filter((issue) => issue.code === "PROOF_CLAIM_UNVERIFIED")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// No-trace instrumentation warning
// ---------------------------------------------------------------------------

describe("runClaimProofChecks — PROOF_NO_TRACE", () => {
  it("fires MEDIUM PROOF_NO_TRACE when there is output but no trace at all", () => {
    const { issues } = runClaimProofChecks({
      task: "Do something.",
      outputText: "I updated `file.txt` with the changes.",
    });
    const noTrace = issues.find((i) => i.code === "PROOF_NO_TRACE");
    expect(noTrace).toBeDefined();
    expect(noTrace!.severity).toBe("MEDIUM");
  });

  it("still fires PROOF_NO_TRACE for audit output when Orca provides no audit receipts", () => {
    const { issues } = runClaimProofChecks({
      task: "Check this app.",
      outputText: [
        "Readiness: mostly ready",
        "Observed from files/config:",
        "- package.json contains build and test scripts",
      ].join("\n"),
      metadata: { stoppedBecause: "done", audit: { mode: "project_audit" } },
    });

    const noTrace = issues.find((i) => i.code === "PROOF_NO_TRACE");
    expect(noTrace).toBeDefined();
    expect(noTrace!.severity).toBe("HIGH");
  });

  it("does NOT fire PROOF_NO_TRACE when toolEvents are present", () => {
    const { issues } = runClaimProofChecks({
      task: "Do something.",
      outputText: "Done.",
      toolEvents: [{ tool: "read_file", ok: true, summary: "read" }],
    });
    const noTrace = issues.find((i) => i.code === "PROOF_NO_TRACE");
    expect(noTrace).toBeUndefined();
  });

  it("does NOT fire PROOF_NO_TRACE when filesChanged is non-empty", () => {
    const { issues } = runClaimProofChecks({
      task: "Create something.",
      outputText: "Created.",
      filesChanged: [{ path: "new.ts", changeType: "A", diff: "x;" }],
    });
    const noTrace = issues.find((i) => i.code === "PROOF_NO_TRACE");
    expect(noTrace).toBeUndefined();
  });

  it("does NOT fire PROOF_NO_TRACE when outputText is empty", () => {
    const { issues } = runClaimProofChecks({
      task: "Do something.",
      outputText: "",
    });
    const noTrace = issues.find((i) => i.code === "PROOF_NO_TRACE");
    expect(noTrace).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Claim extraction completeness
// ---------------------------------------------------------------------------

describe("runClaimProofChecks — claim extraction", () => {
  it("gives each claim a unique ID (C1, C2, …)", () => {
    const { claims } = runClaimProofChecks({
      task: "Update files.",
      outputText:
        "I updated `a.ts` and also updated `b.ts`. I created `c.ts` as well.",
      filesChanged: [
        { path: "a.ts", changeType: "M", diff: "x;" },
        { path: "b.ts", changeType: "M", diff: "y;" },
        { path: "c.ts", changeType: "A", diff: "z;" },
      ],
    });
    const ids = claims.map((c) => c.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    expect(ids[0]).toBe("C1");
  });

  it("marks all claims as requires_proof=true", () => {
    const { claims } = runClaimProofChecks({
      task: "Update config.",
      outputText: "I updated `config.ts` and created `notes.md`.",
      filesChanged: [
        { path: "config.ts", changeType: "M", diff: "x;" },
        { path: "notes.md", changeType: "A", diff: "y;" },
      ],
    });
    expect(claims.every((c) => c.requires_proof)).toBe(true);
  });
});
