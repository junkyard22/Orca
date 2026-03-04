/**
 * Subagent types — Phase 2.1
 *
 * A SubAgent is a fully independent unit of work spawned by Maestro when a
 * user request decomposes into parallel, non-dependent subtasks.
 *
 * Lifecycle:
 *   pending → running → done | failed
 *
 * Spawning happens inside MaestroAdapter; the SubAgentSpawner interface lets
 * the runtime (or tests) inject alternative execution strategies without
 * touching the adapter.
 */

export type SubAgentStatus = "pending" | "running" | "done" | "failed";

export interface SubAgent {
  /** Unique ID — `{parentRunId}_sa{index}` */
  id: string;
  /** Role assigned by planner_deep during decomposition. */
  role: string;
  /** The specific subtask description given to this agent. */
  task: string;
  /** Run ID of the top-level task that spawned this agent. */
  parentRunId: string;
  status: SubAgentStatus;
}

export interface SubAgentResult {
  subagentId: string;
  role: string;
  task: string;
  status: "done" | "failed";
  /** Present when status === "done". */
  outputText?: string;
  /** Present when status === "failed". */
  error?: string;
}

/**
 * SubAgentSpawner — interface for creating and awaiting subagents.
 *
 * The concrete implementation in MaestroAdapter uses Promise.all() for
 * fully parallel execution. Tests can inject a sequential mock instead.
 */
export interface SubAgentSpawner {
  /**
   * Spawn a subagent to run the given task with the given role.
   * Returns immediately with the SubAgent descriptor; the agent runs async.
   */
  spawn(task: string, role: string, parentRunId: string): SubAgent;

  /**
   * Await a single subagent and return its result.
   */
  await(agentId: string): Promise<SubAgentResult>;

  /**
   * Await all agents in parallel and return all results.
   */
  awaitAll(agentIds: string[]): Promise<SubAgentResult[]>;
}
