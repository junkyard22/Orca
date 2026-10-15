/**
 * One acceptance contract per task (1.7.0 release stabilization, after live
 * rehearsal A7).
 *
 * Before: Pappy's goals were the pass's Brain-derived done criteria when the
 * pass carried them, else the task's goals. Brain's criteria therefore
 * replaced the user's requirements on the first pass, and a repair pass that
 * did not route through Brain again was judged against the user's goals
 * instead — in A7 the first verdict failed "The failing test is fixed" and the
 * repair verdict passed a different criterion.
 *
 * Now: the contract is fixed once, after the first worker pass, as the user's
 * goals (never dropped) followed by the Brain-derived criteria that add to
 * them (duplicates removed). Every verdict of the task — first pass, repair
 * passes, audit — is judged against the same list. Brain can add checks; it
 * cannot remove or replace a user requirement, and a repair cannot change the
 * standard.
 */
import type { OrcaTaskSpec } from "./types.js";

export interface AcceptanceContract {
  /** The user's request as received. */
  objective: string;
  /** The task's own goals (from the user's request); never dropped. */
  userGoals: string[];
  /** Criteria Brain derived that add to the user's goals. */
  derivedCriteria: string[];
  /** What Pappy judges, in order: user goals, then derived criteria. */
  goals: string[];
}

const key = (text: string) => text.toLowerCase().replace(/[\s.]+$/g, "").replace(/\s+/g, " ").trim();

export function buildAcceptanceContract(task: OrcaTaskSpec, derived?: readonly string[] | null): AcceptanceContract {
  const objective = (task.originalUserMessage ?? task.intent ?? "").trim();
  const fromTask = (task.goals ?? []).map((g) => String(g).trim()).filter((g) => g.length > 0);
  const userGoals = fromTask.length > 0 ? fromTask : objective ? [objective] : [];
  const seen = new Set(userGoals.map(key));
  const derivedCriteria: string[] = [];
  for (const raw of derived ?? []) {
    const c = String(raw).trim();
    if (!c || seen.has(key(c))) continue;
    seen.add(key(c));
    derivedCriteria.push(c);
  }
  return { objective, userGoals, derivedCriteria, goals: [...userGoals, ...derivedCriteria] };
}
