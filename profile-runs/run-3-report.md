# Orca Profile Analysis — 5f80e8cc-789b-4184-9012-674725fe4568

**Source:** `profile-runs\run-3.jsonl`  
**Total wall-clock:** 102443.0 ms (102.44 s)  
**LLM calls:** 4  

## Notes

- pappy_eval not instrumented — Pappy time included in 'other'
- sqlite_save not instrumented — SQLite time included in 'other'

## Phase Breakdown

| Phase | Time (ms) | % of Total |
|-------|-----------|------------|
| **LLM inference (total)** | **102433.0** | **100.0%** |
| Pappy evaluation | 0.0 | 0.0% |
| SQLite persistence | 0.0 | 0.0% |
| AHP packet ops | 0.0 | 0.0% |
| Trace writes | 0.0 | 0.0% |
| Other / routing / overhead | 10.0 | 0.0% |

## Per-LLM Call Breakdown (descending by duration)

| # | Agent / Stage | Model | Duration (ms) | Tokens |
|---|--------------|-------|---------------|--------|
| 1 | rewrite | qwen/qwen3.5-flash-20260224 | 30209.0 | 88 |
| 2 | plan | qwen/qwen3.5-flash-20260224 | 27449.0 | 2871 |
| 3 | critique | qwen/qwen3.5-flash-20260224 | 25831.0 | 4010 |
| 4 | answer | qwen/qwen3.5-flash-20260224 | 18944.0 | 93 |

## Trace Write Stats

| Metric | Value |
|--------|-------|
| Count | 0 |
| Total (ms) | 0.0 |
| Mean (ms) | 0.0 |
| P95 (ms) | 0.0 |

## AHP Validation Stats

| Metric | Value |
|--------|-------|
| Count | 0 |
| Total (ms) | 0.0 |
| Mean (ms) | 0.0 |
| P95 (ms) | 0.0 |
