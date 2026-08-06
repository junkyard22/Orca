import { describe, expect, it } from "vitest";
import { extractCriterionSymbols, findCriterionSymbols } from "./criterionSymbols.js";

describe("extractCriterionSymbols", () => {
  it("pulls a camelCase symbol out of a behavioural criterion", () => {
    expect(
      extractCriterionSymbols(
        "formatRelativeDate must return a non-negative, human-readable string for future dates.",
      ),
    ).toEqual(["formatRelativeDate"]);
  });

  it("handles the other real shapes", () => {
    expect(extractCriterionSymbols("Add a computeBackoffMs(attempt) helper.")).toContain("computeBackoffMs");
    expect(extractCriterionSymbols("uploadBackupToS3 must upload the buffer.")).toContain("uploadBackupToS3");
    expect(extractCriterionSymbols("The `run_command` tool must be used.")).toContain("run_command");
    expect(extractCriterionSymbols("Call `initSqlJs()` at startup.")).toContain("initSqlJs");
    expect(extractCriterionSymbols("get_user_by_email must query the table.")).toContain("get_user_by_email");
  });

  it("extracts nothing from prose, so prose stays fail-closed", () => {
    // The load-bearing case. If ordinary words counted as symbols, every
    // criterion would find a match somewhere and the fail-closed default —
    // the thing that closed the QC bypass — would be undone.
    expect(extractCriterionSymbols("Output is exactly one line of syntactically valid Python code")).toEqual([]);
    expect(extractCriterionSymbols("The line implements a theorem prover for first-order logic")).toEqual([]);
    expect(extractCriterionSymbols("Existing date formatting tests must continue to pass.")).toEqual([]);
    expect(extractCriterionSymbols("Output must be self-contained and require no setup")).toEqual([]);
  });

  it("ignores tokens too short to be meaningful", () => {
    expect(extractCriterionSymbols("aB cD")).toEqual([]);
  });

  it("does not treat a sentence-initial capital as camelCase", () => {
    expect(extractCriterionSymbols("Return the value unchanged.")).toEqual([]);
  });
});

describe("findCriterionSymbols", () => {
  const symbols = ["formatRelativeDate"];

  it("finds a symbol present in the changed code", () => {
    const r = findCriterionSymbols(symbols, "src/date.ts export function formatRelativeDate() {}", "");
    expect(r.inCode).toEqual(["formatRelativeDate"]);
    expect(r.inAccount).toEqual([]);
  });

  it("finds a symbol present only in the agent's account", () => {
    // The realistic case: a unified diff changes a function's body without
    // restating its name, so the symbol appears in the write-up and not the diff.
    const r = findCriterionSymbols(symbols, "-  const diff = a - b;\n+  const d = b - a;", "Fixed formatRelativeDate for future dates.");
    expect(r.inCode).toEqual([]);
    expect(r.inAccount).toEqual(["formatRelativeDate"]);
  });

  it("matches case-insensitively", () => {
    expect(findCriterionSymbols(symbols, "FORMATRELATIVEDATE", "").inCode).toEqual(["formatRelativeDate"]);
  });

  it("finds nothing when the symbol is absent from both", () => {
    const r = findCriterionSymbols(symbols, "unrelated change", "did something else");
    expect(r.inCode).toEqual([]);
    expect(r.inAccount).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Behaviour through the real gate
//
// The eval suite does not distinguish these two cases — mutating the
// corroboration guard to `true` leaves all 23 fixtures unchanged. Without these
// tests the guard would be unverified, which is how a defensive check quietly
// stops doing anything.
// ---------------------------------------------------------------------------

describe("symbol receipts through evaluateWithPappy", () => {
  const base = {
    task: "Fix formatRelativeDate so it handles future dates.",
    goals: ["formatRelativeDate must return a non-negative string for future dates"],
    outputText: "Fixed formatRelativeDate to detect future dates and return 'in 3 days'.",
    filesChanged: [
      { path: "src/date.ts", changeType: "M" as const, diff: "+  return d >= 0 ? `in ${n} days` : `${n} days ago`;" },
    ],
  };

  it("PROVES the criterion when a tool event corroborates the account", async () => {
    const { evaluateWithPappy } = await import("../pappy.js");
    const r = evaluateWithPappy({
      ...base,
      toolEvents: [{ tool: "run_command", ok: true, summary: "2 passed, 0 failed" }],
    });
    const ac1 = r.receipt_ledger.find((e) => e.ref === "AC1");
    expect(ac1?.status).toBe("PROVED");
  });

  it("only PARTIALs when the agent's account is the sole evidence", async () => {
    // The symbol is named in the write-up and absent from the diff, and no tool
    // ran. The agent authored the only thing vouching for it, so this warns
    // rather than proving — and must not be MISSING either, which would fail
    // work that is very likely correct.
    const { evaluateWithPappy } = await import("../pappy.js");
    const r = evaluateWithPappy({ ...base, toolEvents: [] });
    const ac1 = r.receipt_ledger.find((e) => e.ref === "AC1");
    expect(ac1?.status).toBe("PARTIAL");
    expect(r.issues.some((i) => i.code === "RECEIPT_PARTIAL" && i.severity === "MEDIUM")).toBe(true);
  });

  it("still fails closed when the criterion names no symbol at all", async () => {
    // Prompt D's shape. No symbol means no receipt, regardless of activity —
    // this is the QC bypass staying closed.
    const { evaluateWithPappy } = await import("../pappy.js");
    const r = evaluateWithPappy({
      task: "Write a one-line theorem prover.",
      goals: ["The line implements a theorem prover for first-order logic"],
      outputText: "Here it is. Though this only does propositional resolution, not first-order logic.",
      filesChanged: [{ path: "prover.py", changeType: "A" as const, diff: "+(lambda C: ...)" }],
      toolEvents: [{ tool: "run_command", ok: true, summary: "Syntax OK" }],
    });
    expect(r.receipt_ledger.find((e) => e.ref === "AC1")?.status).toBe("MISSING");
    expect(r.verdict).toBe("FAIL");
  });
});
