import type { OrcaFileChange, OrcaMaestroResult } from "@clawde/orca-core";

export interface ParsedCall {
  tool: string;
  input: Record<string, unknown>;
}

export interface AgentLoopThought {
  iteration: number;
  thought: string;
  observation: string;
  next: string;
}

export interface AgentLoopLoopEvidence {
  iteration: number;
  repeatedCall: string;
  occurrences: number;
}

export type AgentLoopStopReason =
  | "done"
  | "max_iterations"
  | "loop_detected"
  | "parse_failure_loop"
  | "no_final_output"
  | "gate_blocked"
  | "error";

export interface AgentLoopResult {
  text: string;
  toolEvents: NonNullable<OrcaMaestroResult["toolEvents"]>;
  filesChanged: OrcaFileChange[];
  thoughts: AgentLoopThought[];
  iterationCount: number;
  stoppedBecause: AgentLoopStopReason;
  loopEvidence?: AgentLoopLoopEvidence;
  error?: string;
}
