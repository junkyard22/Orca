/**
 * Terms that tie a piece of evidence to a specific requirement.
 *
 * A behavioural receipt (a test run, a validation command, a changed test
 * file) is relevant to a criterion only when it names what the criterion is
 * about: the code identifiers it mentions, or its distinctive words. Generic
 * words — verbs of the request, "file", "function", "test" — never count, so
 * an unrelated successful command cannot be matched to a requirement by
 * accident.
 */
import { extractCriterionSymbols } from "./criterionSymbols.js";

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "for", "by", "with", "from", "into", "onto",
  "as", "is", "are", "was", "were", "be", "been", "being", "it", "its", "this", "that", "these", "those", "there",
  "which", "whether", "when", "where", "while", "than", "then", "so", "if", "not", "no", "yes", "do", "does", "did",
  "has", "have", "had", "can", "could", "should", "would", "will", "may", "might", "must", "shall", "also", "only",
  "any", "all", "each", "every", "some", "such", "same", "other", "another", "one", "two", "both", "either", "neither",
  "without", "within", "after", "before", "again", "still", "just", "very", "more", "most", "less", "least", "new",
  "existing", "current", "correct", "correctly", "properly", "actual", "actually", "really", "exactly", "whose",
  "what", "how", "why", "who", "whom", "about", "over", "under", "between", "through", "during", "against", "like",
  "see", "per", "via", "etc", "e.g", "i.e",
  // request verbs and generic task nouns: they describe the work, not its subject
  "fix", "fixes", "fixed", "fixing", "repair", "resolve", "resolved", "correct", "patch", "debug", "investigate",
  "add", "adds", "added", "adding", "implement", "implements", "implemented", "create", "creates", "created", "build",
  "introduce", "support", "supports", "write", "writes", "wrote", "update", "updates", "updated", "change", "changes",
  "changed", "modify", "modified", "remove", "removed", "delete", "deleted", "refactor", "refactored", "extract",
  "extracted", "rename", "renamed", "move", "moved", "make", "makes", "made", "use", "uses", "used", "using", "run",
  "runs", "ran", "running", "ensure", "verify", "verified", "confirm", "check", "checks", "document", "documents",
  "documented", "documentation", "describe", "explain", "explains", "return", "returns", "returned", "treat", "treats",
  "handle", "handles", "keep", "keeps", "allow", "allows", "reject", "rejects", "accept", "accepts",
  "file", "files", "code", "source", "src", "function", "functions", "method", "class", "module", "helper", "logic",
  "test", "tests", "suite", "bug", "bugs", "issue", "issues", "problem", "problems", "error", "errors", "behaviour",
  "behavior", "behaviours", "behaviors", "task", "request", "user", "users", "report", "reported", "reports", "project",
  "repository", "repo", "docs", "doc", "readme", "section", "page", "output", "response", "answer", "result", "results",
  "smallest", "root", "cause", "unrelated", "into", "instead", "rule", "rules",
]);

/** Root of a word for stem matching: strips plural/tense suffixes, undoing a doubled consonant ("overlapping" → "overlap"). */
export function termRoot(term: string): string {
  let t = term.toLowerCase();
  if (t.length > 5 && /ing$/.test(t)) t = t.slice(0, -3);
  else if (t.length > 4 && /ied$/.test(t)) t = t.slice(0, -3) + "i";
  else if (t.length > 4 && /ed$/.test(t)) t = t.slice(0, -2);
  else if (t.length > 4 && /es$/.test(t)) t = t.slice(0, -2);
  else if (t.length > 3 && /s$/.test(t) && !/ss$/.test(t)) t = t.slice(0, -1);
  if (t.length > 3 && /([b-df-hj-np-tv-z])\1$/.test(t)) t = t.slice(0, -1);
  return t;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `text` contains `term` (word-boundary, stem-tolerant, case-insensitive). */
export function textHasTerm(text: string, term: string): boolean {
  const lower = text.toLowerCase();
  const t = term.toLowerCase();
  if (t.includes("-")) {
    // A hyphenated compound matches literally, or with the hyphens as spaces ("back-to-back" ~ "back to back").
    const re = new RegExp(`(?<![\\w-])${escapeRegExp(t).replace(/-/g, "[-\\s]")}(?![\\w-])`, "i");
    return re.test(lower);
  }
  const root = termRoot(t);
  return new RegExp(`\\b${escapeRegExp(root)}\\w*`, "i").test(lower);
}

const FILE_EXTENSION = "(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|cpp|cc|c|h|hpp|swift|sh|ps1|sql|md|mdx|rst|txt|json|ya?ml|toml|xml|html|css|scss|vue|svelte|lock)";
const FILE_PATH = new RegExp(`(?<![\\w/])(?:[\\w.-]+\\/)*[\\w.-]+\\.${FILE_EXTENSION}(?![\\w/])|\\S*\\/\\S*`, "g");

/**
 * The text with file paths removed (a directory separator, or a file name with
 * a source/doc extension). A listing that prints "parse.js" is not about
 * `parse`; a requirement that names "docs/booking.md" is not about "booking".
 */
export function withoutFilePaths(text: string): string {
  return text.replace(FILE_PATH, " ");
}

/**
 * The words that make a requirement specific: identifiers it names, plus the
 * remaining words of four or more letters that are neither stop words nor
 * generic request vocabulary. Paths are removed first so "docs/booking.md"
 * does not contribute "docs" and "booking" as topic terms of their own.
 */
export function distinctiveTerms(text: string): string[] {
  const symbols = extractCriterionSymbols(text);
  const words = withoutFilePaths(text.replace(/`[^`]*`/g, " "))
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .map((w) => w.replace(/^-+|-+$/g, ""))
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  return [...new Set([...symbols, ...words])];
}

/** Which of `terms` appear in `text`. */
export function matchedTerms(text: string, terms: readonly string[]): string[] {
  return terms.filter((t) => textHasTerm(text, t));
}

/**
 * Whether `text` names enough of the requirement's terms to be about it: every
 * identifier the requirement names, or — when it names none — at least 60 % of
 * its distinctive words (and never fewer than one).
 */
export function textCoversRequirement(text: string, requirement: string): { covered: boolean; matched: string[]; terms: string[] } {
  const terms = distinctiveTerms(requirement);
  const symbols = extractCriterionSymbols(requirement);
  const matched = matchedTerms(text, terms);
  if (terms.length === 0) return { covered: false, matched, terms };
  if (symbols.length > 0) {
    const symbolsMatched = symbols.every((s) => text.toLowerCase().includes(s.toLowerCase()));
    return { covered: symbolsMatched, matched, terms };
  }
  const required = Math.max(1, Math.ceil(terms.length * 0.6));
  return { covered: matched.length >= required, matched, terms };
}
