import { runPipeline } from "@clawde/miranda-core";
import type { LLMAdapter, MirandaConfig, RunRecord, StageResult } from "@clawde/miranda-core";
import type { OrcaLLMService } from "../types.js";

// Walk Miranda's stage results to find the best completed text output.
const STAGE_PREFERENCE = ["rewrite", "answer", "plan"] as const;

function extractText(record: RunRecord): string | undefined {
  for (const stageName of STAGE_PREFERENCE) {
    const stage = record.stages.find((s: StageResult) => s.stage === stageName && s.success);
    if (stage?.finalOutput) return stage.finalOutput as string | undefined;
  }
  return undefined;
}

/**
 * Wraps Miranda's full PLAN → ANSWER → CRITIQUE → REWRITE pipeline as an
 * OrcaLLMService so Maestro never calls a model directly.
 *
 * Each call to complete() runs the entire pipeline with built-in:
 *  - JSON/text validation
 *  - Per-model repair loops
 *  - Model escalation on failure
 *  - Circuit breaker / health tracking
 *  - Cost tracking
 *
 * Usage (app shell):
 *   import { OpenRouterAdapter, createDefaultConfig } from "@clawde/miranda-core";
 *   import { createMirandaLLMService } from "@clawde/orca-core";
 *
 *   const llm = createMirandaLLMService(
 *     new OpenRouterAdapter({ apiKey: process.env.OPENROUTER_KEY }),
 *     createDefaultConfig(),
 *   );
 */
export function createMirandaLLMService(
  adapter: LLMAdapter,
  config: MirandaConfig,
): OrcaLLMService {
  return {
    async complete(prompt, opts) {
      const { record } = await runPipeline(prompt, adapter, config, {
        onToken: opts?.onToken,
      });
      return { text: extractText(record) ?? "" };
    },
  };
}
