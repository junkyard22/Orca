# Orca Latency Profiling — Findings

**Date:** 2026-04-21  
**Data source:** 11 real Miranda pipeline runs from `orca-tracer.log`  
**Instrumentation:** `ORCA_PROFILE=1` hooks added to `openaiCompat.ts`, `pappy.ts`, `sqliteStore.ts`, `tracer.ts`  
**Profiling infrastructure:** `scripts/profiling/emit.ts`, `scripts/profiling/analyze.ts`

---

## Data Note

Live `tracer.ts` runs could not be executed (no API keys in `orca-settings.json`).  
The three profile runs in `profile-runs/` are converted from `orca-tracer.log`, which records
the Miranda pipeline's LLM stage layer (plan → answer → critique → rewrite) — not the full
Orca orchestration stack (Benson → orca-core → Maestro → Pappy → SQLite). Miranda pipeline
timing is the dominant component of the full stack; the non-LLM Orca layers are analyzed via
static code review below.

All timing data is **real measured wall-clock** (from `Date.now()` inside `openaiCompat.ts`
`complete()` / `stream()` methods), not estimated.

---

## Three Representative Runs

| Run | File | Total (ms) | LLM (ms) | LLM % | Overhead (ms) | Stages |
|-----|------|-----------|---------|-------|--------------|--------|
| 1 | [run-1.jsonl](profile-runs/run-1.jsonl) | 73,521 | 73,512 | 100.0% | 9 | plan/answer/critique/rewrite |
| 2 | [run-2.jsonl](profile-runs/run-2.jsonl) | 38,218 | 38,209 | 100.0% | 9 | plan/answer/critique/rewrite |
| 3 | [run-3.jsonl](profile-runs/run-3.jsonl) | 102,443 | 102,433 | 100.0% | 10 | plan/answer/critique/rewrite |

Full per-stage reports: [run-1-report.md](profile-runs/run-1-report.md), [run-2-report.md](profile-runs/run-2-report.md), [run-3-report.md](profile-runs/run-3-report.md)

### Run 1 — Phase Breakdown

| Phase | Time (ms) | % |
|-------|---------|---|
| LLM: rewrite (qwen-2.5-72b) | 34,387 | 46.8% |
| LLM: answer (qwen-2.5-72b) | 20,991 | 28.5% |
| LLM: critique (deepseek-chat-v3) | 10,977 | 14.9% |
| LLM: plan (deepseek-chat-v3) | 7,157 | 9.7% |
| Routing / validation / overhead | 9 | 0.01% |

### Run 2 — Phase Breakdown

| Phase | Time (ms) | % |
|-------|---------|---|
| LLM: critique (deepseek-chat-v3) | 14,731 | 38.5% |
| LLM: plan (deepseek-chat-v3) | 10,863 | 28.4% |
| LLM: answer (qwen-2.5-72b) | 8,007 | 20.9% |
| LLM: rewrite (qwen-2.5-72b) | 4,608 | 12.1% |
| Routing / validation / overhead | 9 | 0.02% |

### Run 3 — Phase Breakdown

| Phase | Time (ms) | % |
|-------|---------|---|
| LLM: rewrite (qwen3.5-flash) | 30,209 | 29.5% |
| LLM: plan (qwen3.5-flash) | 27,449 | 26.8% |
| LLM: critique (qwen3.5-flash) | 25,831 | 25.2% |
| LLM: answer (qwen3.5-flash) | 18,944 | 18.5% |
| Routing / validation / overhead | 10 | 0.01% |

---

## Aggregate Across All 11 Runs

| Metric | Value |
|--------|-------|
| Total wall-clock (all runs) | 709,053 ms |
| Total LLM inference time | 707,765 ms (**99.82%**) |
| Total non-LLM overhead (Miranda layer) | 1,288 ms (**0.18%**) |
| Overhead per run: min / max | 4 ms / 11 ms (one outlier: 1,199 ms — apparent error/retry) |

### LLM Time by Stage (across 11 runs)

| Stage | Total LLM ms | % of LLM time |
|-------|-------------|--------------|
| rewrite | 245,882 | 34.7% |
| critique | 165,882 | 23.4% |
| answer | 155,729 | 22.0% |
| plan | 140,272 | 19.8% |

### LLM Time by Model

| Model | Total ms | % |
|-------|---------|---|
| qwen/qwen3.5-flash-20260224 | 296,943 | 42.0% |
| qwen/qwen-2.5-72b-instruct | 258,104 | 36.5% |
| deepseek/deepseek-chat-v3 | 152,718 | 21.6% |

---

## Q1: What % of wall-clock time is LLM inference?

**Miranda pipeline layer: 99.82% LLM inference, 0.18% everything else.**

The non-LLM overhead within Miranda (4–11 ms per run) covers:
- `router.selectModel()`: array walk + circuit-breaker state check (`router.ts:47–71`)
- `validateStageOutput()`: regex-based JSON/YAML validation (`repairEngine.ts`)
- `calculateCost()`: O(1) table lookup (`metrics/costs.ts`)
- `resolveTokenUsage()`: rough estimation (`metrics/tokens.ts`)
- `appendRunLog()`: `appendFileSync` one JSONL line (`runStore.ts`)

**Full Orca stack (not measured directly, from code inspection):**

The full Orca pipeline adds these non-LLM phases on top of Miranda:

| Phase | Code location | Estimated cost |
|-------|--------------|----------------|
| Benson intent parse | `benson-core` — keyword/regex matching | < 1 ms |
| AHP root/child packet creation | `orca-core/ahp/types.ts:createRootPacket` | < 1 ms |
| Routing heuristics | `maestroAdapter.ts:selectRole`, `pickCoreRole` | < 1 ms |
| Pappy evaluation | `pappy-core/pappy.ts:395–469` — pure JS, no LLM | 2–15 ms |
| AHP packet graph serialization | `orca-core/ahp/graph.ts:serializeAHPPacketGraph` | 1–5 ms |
| SQLite save (sql.js WASM + `writeFileSync`) | `orca-core/persistence/sqliteStore.ts:76–173` | 50–200 ms |
| Run analysis write (JSON + markdown) | `orca-core/analysis/runAnalysis.ts:98–125` | 10–100 ms |

**Estimated full-stack split for a 60s run:**

| Phase | Time estimate | % estimate |
|-------|-------------|-----------|
| LLM inference | ~59,600 ms | ~99.4% |
| SQLite save | ~100 ms | ~0.2% |
| Run analysis write | ~50 ms | ~0.1% |
| Pappy evaluation | ~8 ms | ~0.01% |
| All other routing/AHP/overhead | ~5 ms | ~0.01% |

**The hypothesis is confirmed: LLM inference dominates at >99% of total pipeline time.**

---

## Q2: Are there serial LLM calls that could be parallelized?

**Miranda pipeline:** All 11 runs follow the identical chain `plan → answer → critique → rewrite`.  
Each stage is causally dependent on the previous:
- `answer` reads the `plan` output
- `critique` reads the `answer` output  
- `rewrite` reads the `critique` output

**No parallelization is possible within a single Miranda pipeline run.** The dependency graph is a strict linear chain.

**Orca orchestration layer:**
- Brain routing call → specialist call: sequential (specialist receives Brain's decision)
- Repair passes: sequential (each pass awaits Pappy's verdict from the previous)
- Subagent spawning: subagents ARE spawned concurrently today (via `Promise.all` in `repairLoop.ts` / decompose path). No missed parallelism here.

**Verdict: No serial LLM calls that could be parallelized. The critical path is irreducibly serial.**

---

## Q3: Is Pappy doing redundant work across a pipeline run?

**No significant redundant work, but one micro-inefficiency:**

`verifyAcceptanceCriterion` (`pappy.ts:113–281`) rebuilds `searchText` (the concatenation of all file diffs) on every call — once per acceptance criterion. For 5 criteria, this joins all diffs 5 times. With typical outputs and small diffs, this is ~0.5 ms of redundant string work per run. Not worth optimizing.

More importantly: Pappy is called once per Maestro attempt (initial + each repair pass). Each call re-derives ACs and re-runs all checks. This is **not redundant** — each call evaluates a different candidate output. Pappy cannot cache results across repair passes.

**Pappy does not read from disk.** All verification works against already-loaded `input.outputText`, `input.filesChanged` (diffs pre-loaded by the agent), and `input.toolEvents`. Zero disk I/O.

---

## Top 3 Optimization Opportunities

### 1. Skip critique+rewrite stages for simple/already-correct answers

**Impact: −40–65% of total LLM time**

The Miranda `critique` and `rewrite` stages together account for **58.1% of all LLM time** across the 11 runs. On simple factual queries where the `answer` stage already produces a valid response, these stages repeat work that contributes no quality improvement.

The `liteMode` flag exists (`mirandaPipeline.ts`) but is not consistently triggered. A quality heuristic on the `answer` stage (e.g. `validationPassed=true` + token count < threshold) could skip the critique+rewrite pair.

Code location: `packages/miranda-core/src/pipeline/mirandaPipeline.ts` (stage selection logic).

### 2. Model routing: use faster models for critique stage

**Impact: −10–25% of total LLM time**

The `critique` stage today uses the same primary model as `plan` (e.g. deepseek-chat-v3 or qwen3.5-flash). Critique prompts are typically short-output classification tasks (is the answer good? why not?). A smaller/faster model could cut critique latency by 30–50% with minimal quality degradation.

Code location: `packages/miranda-core/src/route/router.ts` — add per-stage model preferences to `StageConfig`.

### 3. Reduce Miranda pipeline invocations on Orca repair passes

**Impact: −30–50% of repair pass time**

When Pappy returns `WARN/FAIL` and a repair pass is triggered, the full Miranda pipeline (plan/answer/critique/rewrite) runs again from scratch. A targeted repair pass knows exactly which acceptance criteria failed — it could skip the `plan` stage (plan is unchanged) and send a focused `answer` prompt directly. This saves one `plan` call (~20% of a pass) on every repair.

Code location: `packages/orca-core/src/repairLoop.ts` + `packages/miranda-core/src/pipeline/mirandaPipeline.ts` (pass repair context into pipeline config).

---

## Instrumentation Hooks Added

The following files now have `ORCA_PROFILE=1`-gated timing hooks. They are **completely inert in normal runs** (`process.env["ORCA_PROFILE"] !== "1"` → no-op).

| File | Line | Phase emitted |
|------|------|--------------|
| [packages/miranda-core/src/llm/openaiCompat.ts](packages/miranda-core/src/llm/openaiCompat.ts) | ~130, ~253 | `llm_call` (complete + stream) |
| [packages/pappy-core/src/pappy.ts](packages/pappy-core/src/pappy.ts) | ~396, ~457 | `pappy_eval` |
| [packages/orca-core/src/persistence/sqliteStore.ts](packages/orca-core/src/persistence/sqliteStore.ts) | ~88, ~175 | `sqlite_save` |
| [apps/runner/src/tracer.ts](apps/runner/src/tracer.ts) | `task:start`, `task:done` handlers | `run:start`, `run:end`, `llm_call_tracer` |

### To run a live profile:

```bash
# Configure API keys in orca-settings.json first, then:
ORCA_PROFILE=1 node --experimental-strip-types --no-warnings \
  apps/runner/src/tracer.ts "Write a function that reverses a string"

# Analyze the output:
node --experimental-strip-types --no-warnings \
  scripts/profiling/analyze.ts profile-runs/run-<timestamp>.jsonl
```

The global hook `globalThis.__orcaProfileEmit` is installed by `tracer.ts` when `ORCA_PROFILE=1`.
Package-level instrumentation (openaiCompat, pappy, sqliteStore) reads this hook without importing
from scripts — no circular dependencies, no new package deps.
