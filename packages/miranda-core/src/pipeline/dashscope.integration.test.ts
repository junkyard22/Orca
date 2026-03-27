/**
 * DashScope / qwen3.5-plus — Plan Stage Integration Test
 *
 * Uses the real OpenAICompatAdapter pointed at DashScope for the PLAN stage.
 * All other stages (answer, critique, rewrite) use an in-memory mock adapter.
 *
 * Prints the raw PLAN stage output before any parsing so you can see exactly
 * what Qwen is returning. If parsing fails, prints the raw error and the raw
 * content string (JSON-stringified for whitespace inspection).
 *
 * Run:
 *   DASHSCOPE_API_KEY=sk-xxx pnpm --filter @clawde/miranda-core test -- \
 *     --reporter=verbose src/pipeline/dashscope.integration.test.ts
 */

import { describe, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { OpenAICompatAdapter } from "../llm/openaiCompat.js";
import type { LLMAdapter } from "../llm/adapter.js";
import type { LLMRequest, LLMResponse } from "../pipeline/types.js";
import { createDefaultConfig } from "../pipeline/types.js";
import { runPipeline } from "../pipeline/mirandaPipeline.js";

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const DASHSCOPE_BASE_URL = process.env.ALIBABA_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const QWEN_MODEL = "qwen3.5-plus";
const TEST_PROMPT = "What is a monad? Explain it simply.";

// ── Mock responses for non-plan stages ──────────────────────────────────────
// These must satisfy each stage's validation contract.

const MOCK_ANSWER = [
  "## Plan (summary)",
  "Explain the concept of a monad simply, drawing on functional programming analogies.",
  "",
  "## Answer",
  "A monad is a design pattern in functional programming that lets you chain operations on wrapped values while handling side effects (like errors or async) automatically. Think of it as a box: you put a value in, you have rules for opening the box and transforming what is inside, and the box handles all the messy details — null checks, error propagation, async resolution — for you.",
  "",
  "## Edge cases & checks",
  "Different languages implement monads differently. In Haskell they are explicit. In JavaScript, Promise is monad-like but does not strictly follow the monad laws. Be careful not to conflate monads with functors or applicatives.",
  "",
  "## Next steps",
  "Try implementing a Maybe monad in your preferred language to understand the pattern hands-on. Then look at the Either/Result monad for error handling.",
].join("\n");

const MOCK_CRITIQUE = JSON.stringify({
  issues: [],
  fixes: [],
  missing: [],
  confidence: "high",
});

const MOCK_REWRITE = [
  "## Plan (summary)",
  "Refined explanation of monads with a cleaner analogy and tighter wording.",
  "",
  "## Answer",
  "A monad is a box with two rules: (1) you can put a value in, and (2) you can chain transformations without manually unwrapping the box each time. This pattern lets you compose operations safely — handling errors, async, or nullable values — without tangling your logic with control-flow boilerplate.",
  "",
  "## Edge cases & checks",
  "Monads must satisfy three laws — left identity, right identity, and associativity — for the composition to be predictable. Most practical uses (Maybe, Result, Promise) satisfy these laws implicitly.",
  "",
  "## Next steps",
  "Explore the Maybe/Option monad first, then the Either/Result monad. These two cover the vast majority of real-world monad usage.",
].join("\n");

// ── Routing adapter ──────────────────────────────────────────────────────────

/**
 * Routes plan-stage calls to `planAdapter`; routes all other calls to a
 * fixed mock response queue (answer → critique → rewrite).
 *
 * Plan stage detection: checks for "create a structured plan" in any system
 * message, which is the phrase injected by buildPlanSystemPrompt().
 */
class RoutingAdapter implements LLMAdapter {
  readonly name = "routing-dashscope-mock";
  private mockCallIndex = 0;
  private readonly mockQueue = [MOCK_ANSWER, MOCK_CRITIQUE, MOCK_REWRITE];

  constructor(private readonly planAdapter: LLMAdapter) {}

  private isPlanCall(request: LLMRequest): boolean {
    return request.messages.some(
      (m) => m.role === "system" && m.content.includes("create a structured plan"),
    );
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    if (this.isPlanCall(request)) {
      return this.planAdapter.complete(request);
    }
    const content = this.mockQueue[this.mockCallIndex % this.mockQueue.length] ?? "";
    this.mockCallIndex++;
    return {
      content,
      model: "mock",
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      durationMs: 1,
    };
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("DashScope qwen3.5-plus — plan stage integration", () => {
  it.skipIf(!DASHSCOPE_API_KEY)(
    "runs plan stage via real DashScope; mocks answer / critique / rewrite",
    async () => {
      const planAdapter = new OpenAICompatAdapter({
        baseUrl: DASHSCOPE_BASE_URL,
        apiKey: DASHSCOPE_API_KEY,
        defaultModel: QWEN_MODEL,
        // enableThinking is intentionally omitted so we observe the provider
        // default. If Qwen returns malformed JSON due to thinking mode, add:
        //   enableThinking: false
      });

      const adapter = new RoutingAdapter(planAdapter);

      const mockStage = {
        models: [{ id: "mock", label: "Mock" }],
        maxRetriesPerModel: 1,
        maxTotalAttempts: 1,
        baseTemperature: 0,
        timeoutMs: 10_000,
      };

      const config = createDefaultConfig({
        verbose: true,
        logPath: path.join(os.tmpdir(), "miranda-dashscope-test.jsonl"),
        budgetUsd: 1.0,
        stages: {
          plan: {
            models: [{ id: QWEN_MODEL, label: `Qwen: ${QWEN_MODEL} (DashScope)` }],
            maxRetriesPerModel: 1,
            maxTotalAttempts: 2,
            baseTemperature: 0.4,
            maxTokens: 2048,
            timeoutMs: 90_000,
          },
          answer:   { ...mockStage, maxTokens: 4096 },
          critique: { ...mockStage, maxTokens: 2048 },
          rewrite:  { ...mockStage, maxTokens: 4096 },
        },
      });

      let result: Awaited<ReturnType<typeof runPipeline>> | undefined;
      let pipelineError: unknown;

      try {
        result = await runPipeline(TEST_PROMPT, adapter, config);
      } catch (err) {
        pipelineError = err;
        console.log("\n=== PIPELINE THREW AN UNCAUGHT ERROR ===");
        console.log(err instanceof Error ? err.message : String(err));
        console.log("========================================\n");
        throw err;
      }

      // ── Print plan stage raw output ──────────────────────────────────────
      const planStage = result.record.stages.find((s) => s.stage === "plan");

      console.log("\n╔══════════════════════════════════════════════════════════╗");
      console.log("║    PLAN STAGE RAW OUTPUT  (before any parsing)          ║");
      console.log("╚══════════════════════════════════════════════════════════╝");

      if (!planStage || planStage.attempts.length === 0) {
        console.log("(no plan stage attempts recorded)");
      } else {
        for (const attempt of planStage.attempts) {
          console.log(`\n── attempt ${attempt.attemptNumber}  model: ${attempt.model} ──`);

          if (!attempt.rawOutput) {
            console.log("rawOutput: (empty — likely a network/auth error)");
            if (attempt.validation.errors?.length) {
              console.log("errors:");
              for (const e of attempt.validation.errors) {
                console.log("  •", e);
              }
            }
          } else {
            console.log("rawOutput:");
            console.log(attempt.rawOutput);

            if (!attempt.validation.valid) {
              console.log("\n⚠  PARSE FAILED — validation errors:");
              for (const e of attempt.validation.errors ?? []) {
                console.log("  •", e);
              }
              console.log("\nrawOutput (JSON.stringify — inspect whitespace / escapes):");
              console.log(JSON.stringify(attempt.rawOutput));
            } else {
              console.log("\n✓  PARSE SUCCESS — parsed data:");
              console.log(JSON.stringify(attempt.validation.data, null, 2));
            }
          }
        }
      }

      console.log("\n── summary ────────────────────────────────────────────────");
      console.log(`plan stage success : ${planStage?.success ?? "n/a"}`);
      console.log(`plan attempts      : ${planStage?.attempts.length ?? 0}`);
      console.log(`pipeline cost      : $${result.record.totalCost.toFixed(6)}`);
      console.log(`pipeline duration  : ${result.record.totalDurationMs}ms`);
      console.log("───────────────────────────────────────────────────────────\n");
    },
    120_000, // 2-minute timeout for real API round-trip
  );

  it("reminds you to set DASHSCOPE_API_KEY when the key is absent", () => {
    if (DASHSCOPE_API_KEY) return;
    console.log(
      "\nDASHSCOPE_API_KEY is not set — the DashScope integration test was skipped.\n" +
        "Set the variable and re-run to exercise the real plan stage:\n" +
        "  DASHSCOPE_API_KEY=sk-xxx pnpm --filter @clawde/miranda-core test -- \\\n" +
        "    --reporter=verbose src/pipeline/dashscope.integration.test.ts\n",
    );
  });
});
