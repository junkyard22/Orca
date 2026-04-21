# @clawde/agent-loop-core

Shared agent execution loop used by both the runner and desktop adapters.

## Current state

The runner (`apps/runner/src/adapters/maestroAdapter.ts`) uses this package
as its primary loop implementation.

The desktop (`apps/desktop/src/agents/ReactAgentAdapter.ts`) imports this
package but retains its own broader loop as the primary path. The shared loop
is wired as a fallback. This is intentional and temporary — see Roadmap below.

## Contract difference

The desktop loop implements a richer contract than the current shared loop:

- `stoppedBecause` state: `done` | `max_iterations` | `loop_detected` |
  `parse_failure_loop` | `no_final_output` | `error`
- `loopEvidence`: structured metadata about detected loops
- Loop detection: identical-call, thrash, empty/error-result, parse-failure
- `FINAL ANSWER:` extraction and thought block stripping
- Tool alias recovery (`read_directory` → `list_directory`, etc.)
- Parse-failure correction turns
- Post-max-iterations finalization pass

The runner loop is simpler and optimized for the CLI path. It is missing the
above behaviors. The desktop loop contract is the correct target for the
unified shared loop.

## Roadmap — Full unification (v2)

To complete the unification started in this extraction:

1. Migrate the desktop loop contract into `packages/agent-loop-core/src/loop.ts`:
   - Add `stoppedBecause`, `loopEvidence` to `AgentLoopResult`
   - Add loop detection (identical-call, thrash, empty/error-result)
   - Add parse-failure detection and correction turns
   - Add `FINAL ANSWER:` extraction and thought block stripping
   - Add tool alias recovery
   - Add post-max-iterations finalization pass

2. Port the desktop tests from `ReactAgentAdapter.test.ts` into
   `packages/agent-loop-core/` as the canonical test suite for the shared loop.

3. Update the runner adapter to use the unified loop (no behavioral change
   expected — the runner gains defensive behaviors it was missing).

4. Delete the inline loop from `ReactAgentAdapter.ts`. The class becomes a
   thin wrapper that builds context and delegates to `runAgentLoop`.

5. Verify `ReactAgentAdapter.test.ts` passes against the shared loop directly.

## Boundary rule

The agent execution loop lives exclusively in this package.

- DO NOT copy loop logic into app-level adapters
- DO NOT fix loop behavior in `apps/runner` or `apps/desktop` directly
- Any change to loop behavior goes in `packages/agent-loop-core/src/loop.ts`
- Both adapters stay thin wrappers only
