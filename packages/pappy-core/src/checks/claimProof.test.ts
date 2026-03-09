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
  it("flags HIGH when output claims file creation but no filesChanged", () => {
    const { issues, claims } = runClaimProofChecks({
      task: "Create auth.ts.",
      outputText: "I created `auth.ts` for you.",
      toolEvents: [{ tool: "write_file", ok: true, summary: "written" }],
    });
    // "created auth.ts" is claimed but no filesChanged entry
    const claimFound = claims.length > 0;
    expect(claimFound).toBe(true);

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
