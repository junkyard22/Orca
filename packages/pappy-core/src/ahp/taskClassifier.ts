/**
 * Pappy — Task Type Classifier
 *
 * Classifies an AHPPacket's objective into a coarse task category, then
 * derives a set of measurable default acceptance criteria for that category.
 *
 * Default ACs are merged with any ACs already present on the packet's
 * expectedOutput.acceptanceCriteria before evaluation.  Packet-level ACs
 * always take precedence: derived ACs are only appended if they are not
 * already present (case-insensitive exact match).
 */

import type { AHPPacket } from "@clawde/miranda-core";

// ---------------------------------------------------------------------------
// Task type taxonomy
// ---------------------------------------------------------------------------

export enum TaskType {
  /** Running commands, scripts, build/test/lint pipelines. */
  CommandExecution = "command_execution",
  /** Writing new source code (functions, classes, modules). */
  CodeGeneration = "code_generation",
  /** Modifying existing source code (fix, refactor, update). */
  CodeEdit       = "code_edit",
  /** Writing/creating/saving files on disk. */
  FileWrite      = "file_write",
  /** Research, summarization, or information gathering. */
  Research       = "research",
  /** Explaining or describing a concept. */
  Explanation    = "explanation",
  /** Anything that does not fit a more specific category. */
  Other          = "other",
}

// ---------------------------------------------------------------------------
// Keyword scoring tables
// Each entry: [keyword, weight]  (weight > 0; higher wins)
// ---------------------------------------------------------------------------

type ScoredKeyword = [string, number];

const TYPE_KEYWORDS: Record<TaskType, ScoredKeyword[]> = {
  [TaskType.CommandExecution]: [
    ["run the tests", 4],
    ["run the build", 4],
    ["run the lint", 4],
    ["run tests", 3],
    ["run build", 3],
    ["run lint", 3],
    ["npm run", 3],
    ["npm test", 3],
    ["pnpm run", 3],
    ["pnpm test", 3],
    ["yarn run", 3],
    ["yarn test", 3],
    ["run these", 3],
    ["run this", 2],
    ["build and test", 3],
    ["build/test/lint", 4],
    ["build/test", 3],
    ["execute these", 3],
    ["execute this", 2],
  ],
  [TaskType.CodeEdit]: [
    ["refactor", 3],
    ["fix", 2],
    ["debug", 3],
    ["patch", 2],
    ["update the", 2],
    ["modify", 2],
    ["change the", 2],
    ["rename", 2],
    ["rewrite", 2],
    ["broken", 2],
    ["bug", 2],
    ["edit the", 2],
  ],
  [TaskType.CodeGeneration]: [
    ["implement", 3],
    ["generate code", 3],
    ["write a function", 3],
    ["write a class", 3],
    ["write a module", 3],
    ["write an interface", 3],
    ["create a function", 3],
    ["create a class", 3],
    ["scaffold", 3],
    ["build a", 2],
    ["function", 1],
    ["class", 1],
    ["interface", 1],
    ["algorithm", 2],
    ["endpoint", 2],
    ["api", 1],
  ],
  [TaskType.FileWrite]: [
    ["write to file", 3],
    ["save to file", 3],
    ["create a file", 3],
    ["write the file", 3],
    ["output to", 2],
    ["generate a file", 3],
    ["save a file", 3],
    ["create file", 2],
    ["write file", 2],
  ],
  [TaskType.Research]: [
    ["research", 3],
    ["summarize", 3],
    ["summarise", 3],
    ["find information", 3],
    ["look up", 2],
    ["gather information", 3],
    ["analyze", 2],
    ["analyse", 2],
    ["investigate", 2],
    ["review the", 2],
    ["compare", 2],
    ["survey", 2],
  ],
  [TaskType.Explanation]: [
    ["explain", 3],
    ["what is", 2],
    ["how does", 2],
    ["describe", 2],
    ["define", 2],
    ["tell me about", 2],
    ["overview of", 2],
    ["walk me through", 2],
    ["clarify", 2],
  ],
  [TaskType.Other]: [],
};

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify the task type of an AHPPacket based on its objective text.
 *
 * Uses a weighted keyword scoring approach.  Ties are broken by the priority
 * order: CodeEdit > CodeGeneration > FileWrite > Research > Explanation > Other.
 */
export function classifyTaskType(packet: AHPPacket): TaskType {
  const text = packet.objective.toLowerCase();

  // Ordered priority — first type >= best score wins ties
  const PRIORITY: TaskType[] = [
    TaskType.CommandExecution,
    TaskType.CodeEdit,
    TaskType.CodeGeneration,
    TaskType.FileWrite,
    TaskType.Research,
    TaskType.Explanation,
    TaskType.Other,
  ];

  let bestType  = TaskType.Other;
  let bestScore = 0;

  for (const type of PRIORITY) {
    const keywords = TYPE_KEYWORDS[type];
    let score = 0;
    for (const [kw, weight] of keywords) {
      if (text.includes(kw)) score += weight;
    }
    // First-found wins ties (PRIORITY order already encodes intent)
    if (score > bestScore) {
      bestScore = score;
      bestType  = type;
    }
  }

  return bestType;
}

// ---------------------------------------------------------------------------
// Default acceptance criteria per task type
// ---------------------------------------------------------------------------

/** Immutable default ACs for each task category. */
const DEFAULT_ACS: Readonly<Record<TaskType, readonly string[]>> = {
  [TaskType.CommandExecution]: [
    "output contains command execution results",
    "commands ran to completion",
    "no unintended files modified",
  ],
  [TaskType.CodeGeneration]: [
    "compiles without errors",
    "implements the described interface",
    "avoids unjustified hardcoded values",
  ],
  [TaskType.CodeEdit]: [
    "existing tests continue to pass",
    "the change matches the described intent",
    "no unintended files modified",
  ],
  [TaskType.FileWrite]: [
    "file exists at expected path",
    "content matches described intent",
    "no unintended files created",
  ],
  [TaskType.Research]: [
    "covers the key points from the source",
    "does not hallucinate facts",
    "appropriate length",
  ],
  [TaskType.Explanation]: [
    "clearly explains the concept",
    "uses accurate terminology",
    "appropriate level of detail",
  ],
  [TaskType.Other]: [],
};

/**
 * Return the default acceptance criteria for a given task type.
 * Returns a fresh (mutable) copy — safe to push/splice.
 */
export function deriveDefaultACs(taskType: TaskType): string[] {
  return [...DEFAULT_ACS[taskType]];
}

// ---------------------------------------------------------------------------
// Soft / hard AC classification
// ---------------------------------------------------------------------------

/**
 * Priority of an acceptance criterion:
 *   hard — structural or factual; failures drive FAIL/WARN verdicts directly.
 *   soft — stylistic or subjective; soft-only failures downgrade FAIL → WARN.
 */
export type ACPriority = "hard" | "soft";

/**
 * Default ACs that are stylistic/subjective rather than structural.
 * A FAIL verdict requires at least one hard AC to be failing;
 * if only soft ACs fail the verdict is downgraded to WARN.
 */
const SOFT_DEFAULT_ACS = new Set<string>([
  "appropriate length",
  "appropriate level of detail",
]);

/**
 * Return the priority of an acceptance criterion text.
 *
 * All user-authored (packet-level) ACs are treated as hard — the author
 * explicitly chose them, so they carry full weight.
 *
 * Only the specific derived default ACs listed in SOFT_DEFAULT_ACS are soft.
 */
export function getACPriority(acText: string): ACPriority {
  return SOFT_DEFAULT_ACS.has(acText.toLowerCase().trim()) ? "soft" : "hard";
}

// ---------------------------------------------------------------------------
// AC merge — packet ACs take precedence
// ---------------------------------------------------------------------------

/**
 * Merge packet-level ACs with derived defaults.
 *
 * Rules:
 *   - Packet ACs are placed first and take precedence.
 *   - Derived ACs are appended only if they are not already present in the
 *     packet list (case-insensitive exact match).
 *
 * This means a task author can override (by including a matching text) or
 * suppress a default AC (by having packet ACs that already cover it).
 */
export function mergeAcceptanceCriteria(
  packetACs: readonly string[],
  derived: readonly string[],
): string[] {
  const existing = new Set(packetACs.map((ac) => ac.toLowerCase().trim()));
  const toAdd    = derived.filter((ac) => !existing.has(ac.toLowerCase().trim()));
  return [...packetACs, ...toAdd];
}
