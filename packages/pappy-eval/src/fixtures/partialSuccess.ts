import type { EvalFixture } from "../types.js";

export const partialSuccessFixtures: EvalFixture[] = [
  {
    id: "partial_success-001",
    category: "partial_success",
    task: "Add CSV and JSON export options to the reports module.",
    acceptanceCriteria: ["Reports module must support exporting to CSV.", "Reports module must support exporting to JSON."],
    agentClaim: "Implemented CSV export for the reports module, including a new exportToCsv function and tests.",
    filesChanged: [
      {
        path: "packages/orca-core/src/reports/exportCsv.ts",
        changeType: "A",
        diff: '+export function exportToCsv(rows) {\n+  return rows.map(r => r.join(",")).join("\\n");\n+}',
      },
      {
        path: "packages/orca-core/src/reports/exportCsv.test.ts",
        changeType: "A",
        diff: '+it("joins rows with commas", () => { expect(exportToCsv([["a","b"]])).toBe("a,b"); });',
      },
    ],
    diffSummary: "Added exportCsv.ts implementing CSV export with a corresponding test.",
    testOutput: "exportCsv.test.ts\n  joins rows with commas\n\n1 passed, 0 failed",
    toolTrace: [{ tool: "run_command", ok: true, summary: "pnpm vitest run exportCsv.test.ts — 1 passed, 0 failed" }],
    expectedVerdict: "repair",
    expectedTrainingEligibility: "needs_human_review",
    expectedReason:
      "CSV export is implemented and tested, but the JSON export acceptance criterion was not addressed at all — partial completion needing a repair pass.",
  },
  {
    id: "partial_success-002",
    category: "partial_success",
    task: "Add input sanitization to the comment form (strip HTML tags and trim whitespace).",
    acceptanceCriteria: [
      "Comment form must strip HTML tags from submitted text before saving.",
      "Comment form must trim leading and trailing whitespace from submitted text before saving.",
    ],
    agentClaim:
      "Added HTML tag stripping to the comment form's sanitizeComment function, with tests verifying tags are removed.",
    filesChanged: [
      {
        path: "packages/ext-web/src/comments/sanitize.ts",
        changeType: "A",
        diff: '+export function sanitizeComment(text) {\n+  return text.replace(/<[^>]*>/g, "");\n+}',
      },
      {
        path: "packages/ext-web/src/comments/sanitize.test.ts",
        changeType: "A",
        diff: '+it("strips html tags", () => { expect(sanitizeComment("<b>hi</b>")).toBe("hi"); });',
      },
    ],
    diffSummary: "Added sanitize.ts that strips HTML tags from comment text via a regex replace.",
    testOutput: "sanitize.test.ts\n  strips html tags\n\n1 passed, 0 failed",
    toolTrace: [{ tool: "run_command", ok: true, summary: "pnpm vitest run sanitize.test.ts — 1 passed, 0 failed" }],
    expectedVerdict: "repair",
    expectedTrainingEligibility: "needs_human_review",
    expectedReason:
      "HTML stripping is implemented and tested, but whitespace trimming was never addressed — partial completion needing a repair pass.",
  },
  {
    id: "partial_success-003",
    category: "partial_success",
    task: "Add dark mode support to the settings panel (toggle + persisted preference).",
    acceptanceCriteria: [
      "Settings panel must include a dark mode toggle control.",
      "The selected dark mode preference must persist across app restarts.",
    ],
    agentClaim: "Added a dark mode toggle to the settings panel UI.",
    filesChanged: [
      {
        path: "apps/desktop/src/settings/DarkModeToggle.tsx",
        changeType: "A",
        diff: '+export function DarkModeToggle({ value, onChange }) {\n+  return <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} />;\n+}',
      },
    ],
    diffSummary: "Added DarkModeToggle.tsx, a checkbox control wired to onChange.",
    testOutput: "No automated tests were added for this change.",
    toolTrace: [],
    expectedVerdict: "repair",
    expectedTrainingEligibility: "needs_human_review",
    expectedReason:
      "The dark mode toggle control was added, but the persistence requirement was never addressed — partial completion needing a repair pass.",
  },
];
