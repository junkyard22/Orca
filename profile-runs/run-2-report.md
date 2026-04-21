# Orca Profile Analysis — 4cf508e1-cd08-44eb-93d1-1efbf541bab6

**Source:** `profile-runs\run-2.jsonl`  
**Total wall-clock:** 38218.0 ms (38.22 s)  
**LLM calls:** 4  

## Notes

- pappy_eval not instrumented — Pappy time included in 'other'
- sqlite_save not instrumented — SQLite time included in 'other'

## Phase Breakdown

| Phase | Time (ms) | % of Total |
|-------|-----------|------------|
| **LLM inference (total)** | **38209.0** | **100.0%** |
| Pappy evaluation | 0.0 | 0.0% |
| SQLite persistence | 0.0 | 0.0% |
| AHP packet ops | 0.0 | 0.0% |
| Trace writes | 0.0 | 0.0% |
| Other / routing / overhead | 9.0 | 0.0% |

## Per-LLM Call Breakdown (descending by duration)

| # | Agent / Stage | Model | Duration (ms) | Tokens |
|---|--------------|-------|---------------|--------|
| 1 | critique | deepseek/deepseek-chat-v3 | 14731.0 | 1013 |
| 2 | plan | deepseek/deepseek-chat-v3 | 10863.0 | 781 |
| 3 | answer | qwen/qwen-2.5-72b-instruct | 8007.0 | 335 |
| 4 | rewrite | qwen/qwen-2.5-72b-instruct | 4608.0 | 201 |

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
