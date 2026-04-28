# Orca — Universal Truths

## Purpose

This file defines Orca's non-negotiable architectural invariants. These are not implementation details. They are the permanent constraints that govern what every component is, what it owns, and what it must never do — regardless of refactors, optimizations, provider changes, UI changes, or new role additions.

When a proposed change conflicts with an invariant here, the change must either be redesigned to comply or promoted to a deliberate architecture decision that amends this file. Neither silence nor convenience is a valid exception.

---

## Universal Truths

1. **Every component has bounded authority.** Each component owns exactly what is assigned to it. No more.

2. **No component may silently assume another component's authority.** Expanding scope without an explicit design note is a violation, not a feature.

3. **User-facing communication belongs to Benson.** Benson owns the conversation boundary — interpreting what the user said and presenting what the system did. No other component writes final user-facing output.

4. **Intent translation belongs to Secretary.** Translating raw user input into a structured task intent is Secretary's lane. Other components receive an already-parsed intent; they do not re-parse or reinterpret it.

5. **Coordination belongs to Maestro.** Routing tasks to roles, managing the agent loop, and assembling multi-step work is Maestro's lane. Other components do not orchestrate each other.

6. **Planning and routing belong to Brain.** Decomposing a task into sub-tasks and deciding which roles handle them is Brain's lane. Workers do not plan their own engagement.

7. **Context stewardship belongs to Dewey.** Maintaining, retrieving, and managing context across a session is Dewey's lane. Components that need context request it; they do not own it.

8. **Compliance, permission, budget, and safety gating belong to Miranda.** Miranda is the gate layer. It validates, allows, warns, or blocks — it does not plan, answer, critique, or rewrite.

9. **Work execution belongs to workers and tools.** `strong_model`, `cheap_model`, `narrator`, `reviewer`, `debugger`, `utility`, `vision`, `reader`, `planner_deep` execute assigned work. They do not route, gate, or verify quality.

10. **Quality verification belongs to Pappy.** Pappy produces the authoritative PASS / WARN / FAIL verdict. No other component may override, suppress, or short-circuit a Pappy FAIL.

11. **Training and improvement belong to Moonshiner using verified traces.** Moonshiner consumes verified, high-quality traces to improve the system. No component feeds training data that has not passed Pappy QC.

12. **Side effects must be gated.** Any action that modifies state outside the current task — writing files, running commands, calling external APIs — must pass through the appropriate Miranda gate before execution.

13. **Quality must be verified, not assumed.** A component may not declare its own output good. Pappy verifies; the component does not self-certify.

14. **Internal diagnostics must not leak as normal user-facing output.** Trace IDs, gate verdicts, checkpoint labels, repair-loop counters, and Miranda gate metadata are internal signals. Benson translates outcomes; it does not surface raw diagnostics.

15. **Deprecated architecture must not be extended for live behavior.** A deprecated pipeline (e.g., the old Miranda PLAN → ANSWER → CRITIQUE → REWRITE flow) is frozen. Adding new live behavior to a deprecated path is prohibited.

16. **A component may advise outside its lane, but it may not act outside its authority.** A worker may flag a concern. It may not gate, block, reroute, or modify another component's output.

17. **If a change moves authority between components, it is an architecture change, not a refactor.** Relabeling a transfer of authority as cleanup or optimization does not make it safe. It requires the full architecture change process.

18. **The system must prefer controlled stops over unsafe continuation.** When a gate blocks or a repair loop exhausts, the system stops cleanly and reports honestly. It does not proceed on a degraded path that violates a constraint.

19. **The system must prefer honest failure over false success.** A FAIL reported to the user is better than a PASS that papers over a real problem. Confidence is not a substitute for correctness.

20. **Trust comes from structure, verification, and traceability — not from model confidence.** A model's high-confidence output is not trusted output. Output is trusted when it has passed the appropriate gates, been verified by Pappy, and is traceable to a well-formed task.

---

## Authority Rule

> A component may only act within its assigned authority. Any authority expansion requires an explicit design note, tests, and a docs update to this file.

This rule applies unconditionally. There are no emergency exceptions, no "just this once" carve-outs, and no implicit grants from proximity or convenience.

---

## Relationship to Other Docs

This file sits above all other Orca documentation:

| Document | Relationship |
|----------|-------------|
| `docs/ORCA_UNIVERSAL_TRUTHS.md` | **This file.** The root invariants. |
| `ORCA_SYSTEM_CONTRACT.md` | Component contracts derived from these truths. |
| `ARCHITECTURE.md` | Pipeline structure, package map, wiring details — all must be consistent with the truths. |
| `CLAUDE.md` | Agent working instructions — must not contradict the truths. |
| Package-level `README.md` files | Describe a component's behavior within its authority boundary. |
| Role contracts (prompt files) | Define what a role does inside Maestro — bounded by Truth 9. |

When a lower-level document appears to conflict with this file, this file wins. The lower-level document is outdated and must be corrected.

---

## Change Control

This file should rarely change. A change to any invariant here is a **major architecture decision** and must:

1. Be proposed as a documented design note (not a code comment).
2. Receive explicit acknowledgment from the team before merging.
3. Be accompanied by updates to all downstream docs that reference the affected invariant.
4. Be reflected in a changelog entry that explains what changed and why.

Routine refactors, bug fixes, new roles, new tools, and provider swaps do not require changes here. If you think a change here is needed for one of those reasons, the change is probably in the wrong place.
