import type { Issue, RepairTask } from "./types.js";

export function buildRepairTask(task: string, issues: Issue[]): RepairTask {
  const highCritical = issues.filter(
    (i) => i.severity === "CRITICAL" || i.severity === "HIGH",
  );
  const medium = issues.filter((i) => i.severity === "MEDIUM");

  // Build ordered steps: address CRITICAL/HIGH first, then MEDIUM
  const steps: string[] = [];
  const required_proofs: string[] = [];

  if (highCritical.length > 0) {
    steps.push(
      `Fix ${highCritical.length} HIGH/CRITICAL issue${highCritical.length > 1 ? "s" : ""} before anything else:`,
    );
    for (const issue of highCritical) {
      steps.push(`  [${issue.severity}] ${issue.code}: ${issue.fix_hint}`);
      if (issue.expected_receipt) {
        required_proofs.push(`${issue.code}: ${issue.expected_receipt}`);
      }
    }
  }

  if (medium.length > 0) {
    steps.push(`Address ${medium.length} MEDIUM issue${medium.length > 1 ? "s" : ""}:`);
    for (const issue of medium) {
      steps.push(`  [${issue.severity}] ${issue.code}: ${issue.fix_hint}`);
      if (issue.expected_receipt) {
        required_proofs.push(`${issue.code}: ${issue.expected_receipt}`);
      }
    }
  }

  steps.push(
    `Re-run the original task: "${task}"`,
    "Include all required proofs listed below in the response or run trace.",
  );

  const title =
    highCritical.length > 0
      ? `Fix ${highCritical.length} HIGH issue${highCritical.length > 1 ? "s" : ""} in: ${task.slice(0, 60)}${task.length > 60 ? "…" : ""}`
      : `Resolve ${medium.length} MEDIUM issue${medium.length > 1 ? "s" : ""} in: ${task.slice(0, 60)}${task.length > 60 ? "…" : ""}`;

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

