import { createMaestroCore } from "maestro-core";
import type {
  MaestroPort,
  OrcaMaestroResult,
  OrcaRunCtx,
  OrcaTaskSpec,
} from "@clawde/orca-core";

// ---------------------------------------------------------------------------
// MaestroAdapter — wraps maestro-core's MaestroCore to satisfy MaestroPort.
//
// Responsibilities are split deliberately:
//   maestro-core.orchestrate()  →  task classification + risk metadata (sync)
//   ctx.llm.complete()          →  actual text generation (Miranda pipeline)
//
// Maestro never touches a model directly; ctx.llm is the ONLY LLM surface
// it uses (backed by Miranda's PLAN→ANSWER→CRITIQUE→REWRITE pipeline).
// ---------------------------------------------------------------------------

export function createMaestroAdapter(): MaestroPort {
  const maestro = createMaestroCore();

  return {
    async run(task: OrcaTaskSpec, ctx: OrcaRunCtx): Promise<OrcaMaestroResult> {
      // 1. Classify the task synchronously — no model call needed here.
      const orch = maestro.orchestrate(task.originalUserMessage);

      // 2. Build a structured prompt that folds all spec fields together.
      const prompt = buildPrompt(task);

      // 3. Delegate to ctx.llm — the Miranda PLAN→ANSWER→CRITIQUE→REWRITE
      //    pipeline.  This is the ONLY model surface Maestro touches.
      const { text } = await ctx.llm.complete(prompt, { maxTokens: 4096 });

      return {
        outputText: text,
        summary: [
          `run_id=${orch.run_id}`,
          `type=${String(orch.classification.type)}`,
          `risk=${orch.risk.riskScore.toFixed(2)}`,
        ].join(" "),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildPrompt(task: OrcaTaskSpec): string {
  const isRepair = task.intent === "repair";

  const preamble = isRepair
    ? "You are fixing defects identified in a previous attempt.\n" +
      "Address every issue listed in the context below without changing unrelated behaviour."
    : "You are an expert assistant. Complete the following task precisely and thoroughly.";

  const lines: string[] = [
    preamble,
    "",
    "## Intent",
    task.intent,
    "",
    "## Original Request",
    task.originalUserMessage,
    "",
    "## Goals",
    ...task.goals.map((g) => `- ${g}`),
  ];

  if (task.constraints != null && Object.keys(task.constraints).length > 0) {
    lines.push("", "## Constraints", JSON.stringify(task.constraints, null, 2));
  }

  if (task.context != null && Object.keys(task.context).length > 0) {
    lines.push("", "## Context", JSON.stringify(task.context, null, 2));
  }

  return lines.join("\n");
}
