# Miranda Core

**Behavior enforcement runtime for LLMs** — an invisible compliance officer that wraps prompts with contracts, validates outputs, runs repair loops, and escalates to fallback models when needed.

Miranda never talks directly to the user. It sits between your application and the LLM, ensuring the Worker model produces well-structured, high-quality output.

## Architecture

```
User Prompt → Miranda Pipeline → Worker LLM → Validation → Output
                                      ↑               ↓
                                  Repair Loop ←── Invalid?
                                      ↑
                                  Escalation (fallback model)
```

### Pipeline Stages (Sequential)

| Stage        | Format   | Purpose                                                 |
| ------------ | -------- | ------------------------------------------------------- |
| **PLAN**     | JSON     | Structured approach plan with assumptions, steps, risks |
| **ANSWER**   | Markdown | Full answer with required headings                      |
| **CRITIQUE** | JSON     | Self-critique with issues, fixes, missing items         |
| **REWRITE**  | Markdown | Improved answer incorporating critique                  |

## Installation

```bash
pnpm add @clawde/miranda-core
```

## Quick Start

```typescript
import {
  runPipeline,
  createDefaultConfig,
  OpenRouterAdapter,
} from "@clawde/miranda-core";

const adapter = new OpenRouterAdapter({
  apiKey: process.env.OPENROUTER_API_KEY!,
});
const config = createDefaultConfig({ verbose: true });

const { record, summary } = await runPipeline(
  "Explain binary search",
  adapter,
  config,
);

console.log(summary);
```

## Configuration

Pass a `MirandaConfig` object to `runPipeline()` or use `createDefaultConfig()` with overrides:

```typescript
const config = createDefaultConfig({
  // Budget per request in USD
  budgetUsd: 0.1,

  // Verbose logging to stderr
  verbose: true,

  // JSONL log file path
  logPath: "miranda-runs.jsonl",

  // Custom stage configs
  stages: {
    plan: {
      models: [
        { id: "deepseek/deepseek-chat", label: "DeepSeek" },
        { id: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
      ],
      maxRetriesPerModel: 3,
      maxTotalAttempts: 6,
      baseTemperature: 0.4,
      maxTokens: 2048,
      timeoutMs: 60000,
    },
    // ... answer, critique, rewrite
  },

  // Custom pricing table
  pricing: {
    "deepseek/deepseek-chat": { inputPer1M: 0.14, outputPer1M: 0.28 },
  },

  // Circuit breaker settings
  circuitBreaker: {
    failureThreshold: 3,
    windowMs: 300000,
    cooldownMs: 120000,
  },
});
```

## How Repair & Escalation Works

### Repair Loop (per model)

1. **Attempt 1**: Normal prompt at base temperature
2. **Attempt 2**: Stricter prompt + schema + example at 50% temperature
3. **Attempt 3**: Maximum strictness ("ONLY JSON. NO OTHER TEXT.") at temperature 0

### Model Escalation

If a model fails all retry attempts, Miranda moves to the next model in the fallback ladder:

- **Primary** → cheap model (DeepSeek, Qwen)
- **Secondary** → mid-tier (GPT-4o Mini, Gemini Flash)
- **Last resort** → reliable (Claude Haiku, GPT-4o)

### Circuit Breaker

If a model exceeds the failure threshold within a time window, it's disabled for a cooldown period. This prevents wasting budget on broken providers.

### Budget Controls

- Cost is tracked per stage using token counts and a pricing table
- If the budget is exceeded before CRITIQUE/REWRITE, those stages are skipped (lite mode)
- The CLI displays a warning when this happens

## Embedding in Your Application

```typescript
import {
  runPipeline,
  createDefaultConfig,
  type LLMAdapter,
  type LLMRequest,
  type LLMResponse,
} from "@clawde/miranda-core";

// Option 1: Use the built-in OpenRouter adapter
import { OpenRouterAdapter } from "@clawde/miranda-core";
const adapter = new OpenRouterAdapter({ apiKey: "..." });

// Option 2: Implement your own adapter
class MyAdapter implements LLMAdapter {
  readonly name = "my-provider";
  async complete(request: LLMRequest): Promise<LLMResponse> {
    // Call your LLM provider here
  }
}

const config = createDefaultConfig();
const result = await runPipeline("user prompt", adapter, config);
```

## Exports

- `runPipeline()` — main pipeline orchestrator
- `createDefaultConfig()` — config factory with sensible defaults
- `OpenRouterAdapter` — OpenRouter LLM adapter
- `validateJson()` / `validateTextSections()` — standalone validators
- `Router` / `CircuitBreaker` / `HealthTracker` — routing utilities
- `calculateCost()` / `formatCost()` — cost utilities
- Schemas: `PlanSchema`, `CritiqueSchema`, contracts, and types
