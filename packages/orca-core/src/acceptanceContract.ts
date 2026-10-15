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
 *
 * A Brain criterion that shares nothing with the user's request — no file it
 * names, no distinctive term ("Update the README with usage examples" for a
 * parse.js fix, "Output is non-empty") — is not made mandatory: it is kept,
 * explicitly, as advisory (traced with the contract) so an invented or generic
 * check can neither block a genuine completion nor stand in for the user's
 * requirement. The user's goals are always mandatory.
 */
import { distinctiveTerms, textHasTerm } from "@clawde/pappy-core";
import type { OrcaTaskSpec } from "./types.js";

export interface AcceptanceContract {
  /** The user's request as received. */
  objective: string;
  /** The task's own goals (from the user's request); never dropped. */
  userGoals: string[];
  /** Criteria Brain derived that add to the user's goals and relate to the request. */
  derivedCriteria: string[];
  /** Brain criteria that share nothing with the request: recorded, not judged as mandatory. */
  advisoryCriteria: string[];
  /** What Pappy judges, in order: user goals, then relevant derived criteria. */
  goals: string[];
}

const key = (text: string) => text.toLowerCase().replace(/[\s.]+$/g, "").replace(/\s+/g, " ").trim();
const FILE_PATH = /(?<![\w/])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8})(?![\w/])/g;
const VERIFICATION_ACTIVITIES = [/\btests?\b|\btest suite\b|\bspecs?\b/i, /\bbuild(?:s|ing)?\b|\bcompil\w+/i, /\blint\w*/i, /\btype[- ]?check\w*/i];

/** Whether a derived criterion relates to the user's request: a file it names, or a distinctive term, appears there. */
export function relatesToRequest(criterion: string, requestText: string): boolean {
  const lower = requestText.toLowerCase().replace(/\\/g, "/");
  const files = [...criterion.matchAll(FILE_PATH)].map((m) => m[1]!.toLowerCase().replace(/\\/g, "/"));
  if (files.some((f) => lower.includes(f))) return true;
  // Verification words are generic to Pappy's term matcher, but a criterion
  // about running the tests (or the build, lint, type check) relates to a
  // request that asks for the same activity.
  for (const activity of VERIFICATION_ACTIVITIES) if (activity.test(criterion) && activity.test(requestText)) return true;
  return distinctiveTerms(criterion).some((term) => textHasTerm(requestText, term));
}

export function buildAcceptanceContract(task: OrcaTaskSpec, derived?: readonly string[] | null): AcceptanceContract {
  const objective = (task.originalUserMessage ?? task.intent ?? "").trim();
  const fromTask = (task.goals ?? []).map((g) => String(g).trim()).filter((g) => g.length > 0);
  const userGoals = fromTask.length > 0 ? fromTask : objective ? [objective] : [];
  const requestText = [objective, ...userGoals].join("\n");
  const seen = new Set(userGoals.map(key));
  const derivedCriteria: string[] = [];
  const advisoryCriteria: string[] = [];
  for (const raw of derived ?? []) {
    const c = String(raw).trim();
    if (!c || seen.has(key(c))) continue;
    seen.add(key(c));
    (relatesToRequest(c, requestText) ? derivedCriteria : advisoryCriteria).push(c);
  }
  return { objective, userGoals, derivedCriteria, advisoryCriteria, goals: [...userGoals, ...derivedCriteria] };
}
