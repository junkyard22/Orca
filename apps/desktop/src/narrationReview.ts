/**
 * Claire's reply is checked against what the host recorded the task doing
 * before the user sees it (1.7.0, after live rehearsal A6, where the final
 * message said "someone had corrected parse.js in a prior session" although
 * the task's own first pass had made the change). A contradiction is corrected
 * from the record; when the record cannot settle a claim, nothing is added.
 */
import { correctProvenance } from "@clawde/orca-core";
import type { HostRecord } from "@clawde/orca-core";

export function reviewNarration(reply: string, result: { hostRecord?: HostRecord }, log: (message: string) => void = () => {}): string {
  const { text, check } = correctProvenance(reply, result.hostRecord);
  if (check.contradictions.length > 0) log(`narration corrected from the host record: ${check.contradictions.join("; ")}`);
  return text;
}
