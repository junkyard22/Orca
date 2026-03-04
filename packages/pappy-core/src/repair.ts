import type { Issue, RepairTask } from "./types.js";

/**
 * Group issues by category for more organized repair instructions.
 */
function groupIssuesByCategory(issues: Issue[]): Map<string, Issue[]> {
  const grouped = new Map<string, Issue[]>();
  for (const issue of issues) {
    const existing = grouped.get(issue.category) ?? [];
    existing.push(issue);
    grouped.set(issue.category, existing);
  }
  return grouped;
}

/**
 * Generate a specific, actionable repair instruction for a single issue.
 * Includes code references when available in the evidence.
 */
function buildSpecificRepairInstruction(issue: Issue): string {
  const parts: string[] = [];

  // Primary issue description
  parts.push(issue.description);

  // Extract line numbers or specific locations from evidence if present
  const lineMatch = issue.evidence.match(/line[:\s]?(\d+)/i);
  if (lineMatch) {
    parts.push(`(around line ${lineMatch[1]})`);
  }

  // Extract file references from evidence
  const fileMatch = issue.evidence.match(/["`]([^"`\s]+\.(ts|tsx|js|jsx|py|go|rs|vue|svelte))["`]/i);
  if (fileMatch) {
    parts.push(`in file "${fileMatch[1]}"`);
  }

  // Add the expected proof as a concrete target
  if (issue.expected_receipt) {
    parts.push(`Required proof: ${issue.expected_receipt}`);
  }

  return parts.join(" ");
}

export function buildRepairTask(task: string, issues: Issue[]): RepairTask {
  const highCritical = issues.filter(
    (i) => i.severity === "CRITICAL" || i.severity === "HIGH",
  );
  const medium = issues.filter((i) => i.severity === "MEDIUM");
  const low = issues.filter((i) => i.severity === "LOW");

  // Build ordered steps: address CRITICAL/HIGH first, then MEDIUM, then LOW
  const steps: string[] = [];
  const required_proofs: string[] = [];

  // Group issues by category for more targeted repairs
  const highByCategory = groupIssuesByCategory(highCritical);
  const mediumByCategory = groupIssuesByCategory(medium);

  if (highCritical.length > 0) {
    steps.push(
      `Fix ${highCritical.length} HIGH/CRITICAL issue${highCritical.length > 1 ? "s" : ""} before anything else:`,
    );
    steps.push("");

    // Process by category for grouped repairs
    for (const [category, categoryIssues] of highByCategory.entries()) {
      steps.push(`## ${category} (${categoryIssues.length} issue${categoryIssues.length > 1 ? "s" : ""})`);
      for (const issue of categoryIssues) {
        const instruction = buildSpecificRepairInstruction(issue);
        steps.push(`  [${issue.severity}] ${issue.code}: ${instruction}`);
        if (issue.expected_receipt) {
          required_proofs.push(`${issue.code}: ${issue.expected_receipt}`);
        }
      }
      steps.push("");
    }
  }

  if (medium.length > 0) {
    steps.push(`Address ${medium.length} MEDIUM issue${medium.length > 1 ? "s" : ""}:`);
    steps.push("");

    for (const [category, categoryIssues] of mediumByCategory.entries()) {
      steps.push(`## ${category} (${categoryIssues.length} issue${categoryIssues.length > 1 ? "s" : ""})`);
      for (const issue of categoryIssues) {
        const instruction = buildSpecificRepairInstruction(issue);
        steps.push(`  [${issue.severity}] ${issue.code}: ${instruction}`);
        if (issue.expected_receipt) {
          required_proofs.push(`${issue.code}: ${issue.expected_receipt}`);
        }
      }
      steps.push("");
    }
  }

  if (low.length > 0) {
    steps.push(`Consider fixing ${low.length} LOW priority issue${low.length > 1 ? "s" : ""}:`);
    steps.push("");

    for (const issue of low) {
      steps.push(`  [${issue.severity}] ${issue.code}: ${issue.description}`);
    }
    steps.push("");
  }

  steps.push(
    `Re-run the original task: "${task}"`,
    "Include all required proofs listed below in the response or run trace.",
  );

  const title =
    highCritical.length > 0
      ? `Fix ${highCritical.length} HIGH issue${highCritical.length > 1 ? "s" : ""} in: ${task.slice(0, 60)}${task.length > 60 ? "…" : ""}`
      : medium.length > 0
        ? `Resolve ${medium.length} MEDIUM issue${medium.length > 1 ? "s" : ""} in: ${task.slice(0, 60)}${task.length > 60 ? "…" : ""}`
        : `Address ${low.length} LOW issue${low.length > 1 ? "s" : ""} in: ${task.slice(0, 60)}${task.length > 60 ? "…" : ""}`;

  return { title, steps, required_proofs };
}

/**
 * Serialize a RepairTask to the legacy string format.
 * Used for backward-compat on PappyResult.repairTask.
 */
export function repairTaskToString(rt: RepairTask): string {
  const lines: string[] = [rt.title, ""];
  for (const step of rt.steps) {
    lines.push(step);
  }
  if (rt.required_proofs.length > 0) {
    lines.push("", "When done, include:");
    for (const proof of rt.required_proofs) {
      lines.push(`  - ${proof}`);
    }
  }
  return lines.join("\n");
}

