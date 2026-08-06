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
