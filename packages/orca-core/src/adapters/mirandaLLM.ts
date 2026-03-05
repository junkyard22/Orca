import { runPipeline } from "@clawde/miranda-core";
import type { LLMAdapter, MirandaConfig, RunRecord, StageResult, MirandaGate } from "@clawde/miranda-core";
import type { OrcaLLMService } from "../types.js";

// Walk Miranda's stage results to find the best completed text output.
const STAGE_PREFERENCE = ["rewrite", "answer", "plan"] as const;

/**
 * Strip Miranda's pipeline scaffolding headings from the final output.
 * The ANSWER/REWRITE contracts require the model to produce:
 *   ## Plan (summary) / ## Answer / ## Edge cases & checks / ## Next steps
 * but models sometimes use **bold** headers instead of ## headings.
 * Extract the content under the Answer section; if it can't be found,
 * strip all pipeline section headers and return the remaining content.
 */
function stripPipelineScaffolding(raw: string): string {
  // Pattern that matches a section header in either ## or ** format.
  // Captures the section name for identification.
  const SECTION_HEADER =
    /^(?:#{1,3}\s*(.+?)|\*\*(.+?):?\*\*:?)\s*$/;

  // Only treat lines as section boundaries when the header name is a known
  // Miranda pipeline stage — prevents bold subheadings inside the Answer body
  // (e.g. "**Key points:**") from being mistaken for section delimiters.
  const PIPELINE_NAMES =
    /^(plan(\s*\(summary\))?|answer|edge\s*cases?(\s*[&]\s*checks)?|next\s*steps?|critique|rewrite|considerations?|summary|explanation)$/i;

  const lines = raw.split("\n");
  const sections: Array<{ name: string; startLine: number }> = [];

  // Identify all section boundaries.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const m = line.match(SECTION_HEADER);
    if (m) {
      const name = ((m[1] ?? m[2]) || "").trim().toLowerCase();
      if (PIPELINE_NAMES.test(name)) {
        sections.push({ name, startLine: i });
      }
    }
  }

  // Find the "answer" section.
  const answerIdx = sections.findIndex((s) => s.name === "answer");
  if (answerIdx !== -1) {
    const section = sections[answerIdx];
    const nextSection = sections[answerIdx + 1];
    const start = (section?.startLine ?? 0) + 1;
    const end = nextSection ? nextSection.startLine : lines.length;
    const body = lines.slice(start, end).join("\n").trim();
    if (body.length > 0) return body;
  }

  // Fallback: strip all known pipeline section headers and return the rest.
  const PIPELINE_SECTIONS = /plan(\s*\(summary\))?|answer|edge\s*cases?(\s*[&]\s*checks)?|next\s*steps?|critique|rewrite|considerations?|summary|explanation/i;
  const cleaned = lines.filter((line) => {
    const m = line.match(SECTION_HEADER);
    if (m) {
      const name = ((m[1] ?? m[2]) || "").trim();
      if (PIPELINE_SECTIONS.test(name)) return false;
    }
    return true;
  });
  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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
  gate?: MirandaGate,
): OrcaLLMService {
  return {
    async complete(prompt, opts) {
      const { record } = await runPipeline(prompt, adapter, config, {
        onToken: opts?.onToken,
        onStreamReset: opts?.onStreamReset,
        gate,
        simple: opts?.simple,
      });
      return { text: extractText(record) ?? "" };
    },
  };
}
