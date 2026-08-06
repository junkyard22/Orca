/**
 * Pappy — criterion symbol extraction and matching.
 *
 * Acceptance criteria for coding tasks overwhelmingly take one shape:
 * "<symbol> must <do something>" — "formatRelativeDate must return a
 * non-negative string", "uploadBackupToS3 must upload the given buffer".
 *
 * These match none of pappy.ts's specific verifiers, so after the fail-closed
 * default landed they became unprovable, and every correct coding task started
 * failing on a missing receipt. This module supplies the missing verifier.
 *
 * It lives apart from pappy.ts so it can be tested directly. An earlier attempt
 * inlined the same logic and it silently returned nothing in situ while working
 * in isolation — a gap a unit test would have caught immediately.
 */

/**
 * Code identifiers a criterion is about.
 *
 * Deliberately narrow: only tokens shaped like code count. Prose yields
 * nothing, so "must return a string" extracts no symbols and the criterion
 * stays fail-closed rather than being waved through on ordinary words. That
 * narrowness is the whole reason finding one in a diff means anything.
 */
export function extractCriterionSymbols(text: string): string[] {
  const found = new Set<string>();

  // Backticked, e.g. `computeBackoffMs` or `run_command()`.
  for (const m of text.matchAll(/`([A-Za-z_][A-Za-z0-9_.]{2,})`/g)) {
    const raw = m[1];
    if (raw) found.add(raw.replace(/\(\)$/, ""));
  }

  // camelCase / PascalCase — needs an internal capital, so plain words are out.
  for (const m of text.matchAll(/[a-zA-Z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]*)+/g)) {
    const raw = m[0];
    if (raw.length >= 4) found.add(raw);
  }

  // snake_case — needs an underscore, so plain words are out.
  for (const m of text.matchAll(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g)) {
    const raw = m[0];
    if (raw.length >= 4) found.add(raw);
  }

  return [...found];
}

/** Where a criterion's symbol was found, if anywhere. */
export interface SymbolEvidence {
  /** Symbols present in the changed code (path or diff text). */
  inCode: string[];
  /** Symbols present in the agent's own account of the run. */
  inAccount: string[];
}

export function findCriterionSymbols(
  symbols: readonly string[],
  changedCode: string,
  account: string,
): SymbolEvidence {
  const code = changedCode.toLowerCase();
  const acct = account.toLowerCase();
  return {
    inCode: symbols.filter((s) => code.includes(s.toLowerCase())),
    inAccount: symbols.filter((s) => acct.includes(s.toLowerCase())),
  };
}
