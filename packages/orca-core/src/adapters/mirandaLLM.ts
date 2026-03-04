import { runPipeline } from "@clawde/miranda-core";
import type { LLMAdapter, MirandaConfig, RunRecord, StageResult } from "@clawde/miranda-core";
import type { OrcaLLMService } from "../types.js";

// Walk Miranda's stage results to find the best completed text output.
const STAGE_PREFERENCE = ["rewrite", "answer", "plan"] as const;

/**
 * Strip Miranda's pipeline scaffolding headings from the final output.
 * The ANSWER/REWRITE contracts require the model to produce:
 *   ## Plan (summary) / ## Answer / ## Edge cases & checks / ## Next steps
 * These are useful for pipeline validation but should not be exposed to the
 * end user verbatim. Extract the content under ## Answer; if the section
 * doesn't exist (e.g. model ignored the contract), return the full text.
 */
function stripPipelineScaffolding(raw: string): string {
  // Try to extract just the ## Answer section body.
  const match = raw.match(/##\s*Answer\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (match?.[1]) return match[1].trim();
  // Fallback: remove only the ## Plan (summary) section (internal self-talk),
  // leave the rest intact.
  return raw.replace(/##\s*Plan\s*\(summary\)[\s\S]*?(?=\n##\s|$)/i, "").trim();
}

function extractText(record: RunRecord): string | undefined {
  for (const stageName of STAGE_PREFERENCE) {
    const stage = record.stages.find((s: StageResult) => s.stage === stageName && s.success);
    if (stage?.finalOutput) return stripPipelineScaffolding(stage.finalOutput as string);
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
