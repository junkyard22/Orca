# Orca Profile Analysis — b0ec9611-a830-4865-8dc2-9d2cdd171300

**Source:** `profile-runs\run-1.jsonl`  
**Total wall-clock:** 73521.0 ms (73.52 s)  
**LLM calls:** 4  

## Notes

- pappy_eval not instrumented — Pappy time included in 'other'
- sqlite_save not instrumented — SQLite time included in 'other'

## Phase Breakdown

| Phase | Time (ms) | % of Total |
|-------|-----------|------------|
| **LLM inference (total)** | **73512.0** | **100.0%** |
| Pappy evaluation | 0.0 | 0.0% |
| SQLite persistence | 0.0 | 0.0% |
| AHP packet ops | 0.0 | 0.0% |
| Trace writes | 0.0 | 0.0% |
| Other / routing / overhead | 9.0 | 0.0% |

## Per-LLM Call Breakdown (descending by duration)

| # | Agent / Stage | Model | Duration (ms) | Tokens |
|---|--------------|-------|---------------|--------|
| 1 | rewrite | qwen/qwen-2.5-72b-instruct | 34387.0 | 1431 |
| 2 | answer | qwen/qwen-2.5-72b-instruct | 20991.0 | 904 |
| 3 | critique | deepseek/deepseek-chat-v3 | 10977.0 | 1480 |
| 4 | plan | deepseek/deepseek-chat-v3 | 7157.0 | 415 |

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
