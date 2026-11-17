# Proposal: 30-day development-only risk acceptance for GHSA-fc5q-39xc-vjpf (picomatch)

**Status: PROPOSED — NOT ACTIVE.** Nothing in this document changes audit behavior. The exception below must not be implemented or enabled without explicit owner approval. If approved, activation is a separate PR with its own code, tests and CI.

| | |
|---|---|
| Advisory | [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) / CVE-2026-112366, high: ReDoS through single-branch repeated extglobs (`+(*)`, `+(*a)`) |
| Package | `picomatch` (transitive only) |
| Proposed window | Activation date through **2026-12-17**, at most 30 days. Expiry is automatic and fails closed. |
| Prepared | 2026-11-17, from `origin/main` at `3cc27eb` |

## Facts (verified 2026-11-17)

- **No fixed release exists.** The advisory range is `<= 4.0.7` with `first_patched_version: null`. npm `latest` is 4.0.7, and every published 4.x release is in range. Moving between 4.0.4 and 4.0.7 does not fix it.
- **Upstream:** micromatch/picomatch has several competing open fix PRs (#237, #238, #246, #254, #257, #258, #259). None is merged, and there is no release after 4.0.7 (2026-08-24).
- **Installed copies:**
  - pnpm graph: `picomatch@4.0.4`, a single copy, fixed by the root override `"picomatch@4": "4.0.4"`.
    - electron-builder → app-builder-lib → @electron/rebuild → node-gyp → tinyglobby → picomatch (desktop packaging)
    - vite / vitest → tinyglobby, fdir → picomatch (test runner, all packages)
  - workbench-core's independent npm lockfile: `picomatch@4.0.7`, marked `dev`, through vite/vitest. `npm audit` reports it as 5 high findings (fdir, picomatch, tinyglobby, vite, vitest), all through this one advisory.
- **Not in production:**
  - `pnpm why picomatch --prod` returns nothing.
  - `apps/desktop` has no runtime dependencies, and its packaged `files` exclude `node_modules/**`.
  - No built bundle (`apps/desktop/dist-main`, `apps/runner/dist`, `packages/*/dist`) contains picomatch.
  - No Orca source imports picomatch, tinyglobby, fdir, micromatch, fast-glob, glob or minimatch.
- **Who supplies the globs:**
  - node-gyp passes the fixed literals `build/*.sln` and `build/*.mk`.
  - vite/vitest receive patterns from repository-owned config and from developer CLI arguments.
  - No model output, user message, tool argument or network input reaches these tools.

## Risk assessment

Exploiting the advisory requires supplying an attacker-chosen glob to one of these build or test tools. The only ways to do that are a repository change or the developer's own command line. Repository write access already allows arbitrary code execution through build and test scripts, which is a far stronger capability than ReDoS. The worst realistic outcome is a hung local build or CI job, not a compromise of a user's runtime. **Proposed classification: development-only, not exploitable in shipped artifacts; residual risk low.**

## Alternatives considered

| Option | Outcome |
|---|---|
| Upgrade to a patched picomatch | None exists. |
| Bump the override to 4.0.7 | Still vulnerable. Rejected: it hides nothing and fixes nothing. |
| npm's suggested fix (vitest 3.1.4 / vite 6.2.7) | Semver-major downgrade that reintroduces advisories `SECURITY_DEPENDENCIES.md` requires Vitest ≥4.1.12 / Vite ≥8.1.6 to avoid. Rejected. |
| `pnpm patch` backport of one open upstream PR | Possible, but it is our patch, not a verified upstream fix, and the upstream approach is unsettled (7 competing PRs). Not proposed now; revisit if upstream stalls past expiry. |
| Re-scope CI to `--prod` or raise the audit level | Prohibited: it changes thresholds for every advisory. Rejected. |
| **Narrow, expiring, development-only acceptance** | **Proposed below.** |

## Proposed exception (inactive; for review)

If approved, the activation PR would change only the audit policy and its tests. Global thresholds would stay as they are.

1. **Match exactly:** advisory `GHSA-fc5q-39xc-vjpf`, package `picomatch`, versions `4.0.4` (pnpm) and `4.0.7` (workbench npm lockfile). Any other advisory, package or version still fails, as does a picomatch reached through a production path.
2. **Development-only proof:** each finding's dependency path must begin at a devDependency (pnpm: confirmed against `pnpm why --prod`; npm: `dev: true` in the lockfile). Finding a production path fails the gate even while the exception is active.
3. **Hard expiry:** the policy embeds `expires: 2026-12-17`. From that date the finding is actionable again and CI fails, with no code change needed. There is no renewal without a new owner-approved PR.
4. **Visible, not silent:** an accepted finding prints `ACCEPTED (expires 2026-12-17): GHSA-fc5q-39xc-vjpf picomatch@… dev-only; see docs/proposals/RISK_ACCEPTANCE_GHSA-fc5q-39xc-vjpf.md` on every run. It is never dropped from output.
5. **Workbench lockfile:** CI currently runs plain `npm audit --audit-level low` there, which has no exception mechanism. Activation would route that report through the same policy function (the same match, dev-only and expiry rules) instead of adding npm-side ignores.
6. **Tests** (in `scripts/audit-dependencies.test.mjs`), each required to fail before the activation change:
   - accepted before expiry
   - actionable on and after expiry
   - a production path stays actionable
   - another advisory, package or version stays actionable
   - a vulnerable copy alongside an accepted one stays actionable
   - malformed or incomplete reports fail
7. **Docs:** add a "Time-boxed accepted risk" section to `docs/SECURITY_DEPENDENCIES.md` linking this proposal.

## Upstream recheck requirements

- **At least weekly** until resolved, and before any release: recheck the advisory's `first_patched_version`, picomatch releases/tags, and the status of the open fix PRs. Record each check (date, result) in `PROJECT_STATE.md`.
- **When a fixed release appears:** update the `picomatch@4` override and refresh the workbench npm lockfile in a separate PR, run the audit, build and test suites, then delete the exception and this proposal's active status. The exception must not outlive the fix.
- **If the advisory's range or severity changes**, or a production path appears: the exception stops applying automatically (rule 1 or 2) and the owner is notified.
- **On 2026-12-17 with no fix:** CI fails again. The owner then decides between a reviewed `pnpm patch` backport, a newly justified acceptance, or remaining red. There is no automatic extension.

## Approval

Requires explicit owner approval of: (a) the classification above, (b) the 30-day window ending 2026-12-17, and (c) the activation PR, reviewed separately. Until then, Dependency Audit keeps reporting this finding as actionable, and PR #113 neither patches nor suppresses it.
