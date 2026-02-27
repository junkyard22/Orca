/**
 * Miranda Core — Text Sections Validation Tests
 */

import { describe, it, expect } from "vitest";
import { validateTextSections } from "./validateTextSections.js";
import { ANSWER_REQUIRED_HEADINGS } from "../contracts/answer.js";

const VALID_TEXT = [
  "## Plan (summary)",
  "Here is my plan for this question. I will analyze it thoroughly.",
  "",
  "## Answer",
  "Binary search is an efficient algorithm for finding items in a sorted array.",
  "It works by repeatedly dividing the search interval in half.",
  "",
  "## Edge cases & checks",
  "- Empty array returns -1",
  "- Single element array",
  "",
  "## Next steps",
  "- Implement recursive version",
  "- Try with different data types",
].join("\n");

describe("validateTextSections", () => {
  it("passes when all headings are present and length is sufficient", () => {
    const result = validateTextSections(VALID_TEXT, ANSWER_REQUIRED_HEADINGS);
    expect(result.valid).toBe(true);
  });

  it("fails when a heading is missing", () => {
    const textMissingEdgeCases = [
      "## Plan (summary)",
      "A plan.",
      "## Answer",
      "An answer that is long enough to meet the minimum character count for validation.",
      "## Next steps",
      "Follow up tasks.",
    ].join("\n");

    const result = validateTextSections(
      textMissingEdgeCases,
      ANSWER_REQUIRED_HEADINGS,
      50 // Lower min for this test
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    const errors = result.errors!;
    expect(errors.some((e) => e.includes("Edge cases & checks"))).toBe(true);
  });

  it("fails on empty input", () => {
    const result = validateTextSections("", ANSWER_REQUIRED_HEADINGS);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Output is empty or whitespace-only");
  });

  it("fails on whitespace-only input", () => {
    const result = validateTextSections("   \n\t  ", ANSWER_REQUIRED_HEADINGS);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Output is empty or whitespace-only");
  });

  it("fails when text is too short", () => {
    const shortText =
      "## Plan (summary)\n## Answer\n## Edge cases & checks\n## Next steps";
    const result = validateTextSections(shortText, ANSWER_REQUIRED_HEADINGS, 200);
    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.includes("too short"))).toBe(true);
  });

  it("matches headings case-insensitively", () => {
    const mixedCase = VALID_TEXT.replace(
      "## Plan (summary)",
      "## PLAN (SUMMARY)"
    ).replace("## Edge cases & checks", "## edge cases & checks");

    const result = validateTextSections(mixedCase, ANSWER_REQUIRED_HEADINGS);
    expect(result.valid).toBe(true);
  });

  it("allows custom minimum length", () => {
    const result = validateTextSections(VALID_TEXT, ANSWER_REQUIRED_HEADINGS, 10);
    expect(result.valid).toBe(true);
  });
});
