# Dependency security policy

Run `pnpm audit:dependencies` for the complete pnpm dependency graph, and
`npm audit --no-workspaces --audit-level low` in `packages/workbench-core` for
the independent npm lockfile. CI runs both checks, including development and
packaging dependencies. All actionable severities fail the checks; registry
errors and incomplete reports also fail.

## Reviewed legacy minimatch range mismatch

Reviewed 2026-11-02: the registry advisory GHSA-g3hv-75wg-m249 matches every
version below 11.0.1. The [upstream advisory](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249)
identifies 10.2.6 and its `firstPhasePreProcess()` amplification when
`optimizationLevel >= 2`. The installed legacy 3.1.5 and 5.1.9 implementations
have neither that method nor that optimization phase. These are classified
as not affected by this specific defect, based on source inspection.

Electron's asar tooling and EJS's filelist still require the callable legacy
minimatch API; replacing it with the object exported by minimatch 11 would
break those consumers. Modern minimatch consumers are overridden to 11.0.1,
and modern glob consumers to 14.0.2. Legacy glob 7 retains its callback API.

`scripts/audit-dependencies.mjs` reports the two exact legacy versions
explicitly. It does not exempt any other version, package or advisory. In
particular, a vulnerable modern copy alongside a legacy copy fails the gate.
There is no global GHSA suppression. Tests cover mixed versions, changed
advisories, unknown versions and failed reports. Remove this classification
when upstream corrects the range or packaging dependencies drop the legacy API.

## November 2026 upgrade boundaries

Electron 43.8.6 moves the desktop off the unsupported 41.x line and includes
the fixes covered by the current Electron advisories. Verify the packaged app
before publishing an installer; building a package does not constitute a
human acceptance test.

Zod 4.6.6 or later replaces Zod 3 for Miranda and the MCP SDK; the SDK supports
both majors. Undici 8.12.2 requires Node 22.19.0 or later, so the root engine
requirement now matches that minimum. Vitest 4.1.12 and Vite 8.1.6 or later
are required in all workspace manifests and in the independent workbench
lockfile. The latter must be regenerated separately with npm.

## Time-boxed accepted risk: GHSA-fc5q-39xc-vjpf (picomatch), expires 2026-12-17

Owner-approved for implementation on 2026-11-17. Activation and merge
require separate final approval. Specification and justification:
[docs/proposals/RISK_ACCEPTANCE_GHSA-fc5q-39xc-vjpf.md](proposals/RISK_ACCEPTANCE_GHSA-fc5q-39xc-vjpf.md).

No patched picomatch release exists (affected range `<= 4.0.7`). The only
installed copies are 4.0.4 in the pnpm tree (electron-builder → node-gyp, and
vite/vitest) and 4.0.7 in the workbench-core npm lockfile (vite/vitest). Both
are development and build tooling only.

`scripts/audit-dependencies.mjs` accepts a finding only when all of these hold:

- advisory `GHSA-fc5q-39xc-vjpf`, package `picomatch`, installed version
  exactly 4.0.4 or 4.0.7. In npm's report, packages affected only through that
  copy are covered as well;
- the date is before 2026-12-17 (UTC). On and after that date the finding is
  actionable again and CI fails, with no code change. There is no environment
  variable, flag or configuration that extends it;
- every dependency path is development-only, proven twice:
  - pnpm: each path's direct dependency is declared only under
    `devDependencies` of its importer;
  - npm: every node is `dev: true` in `package-lock.json`;
  - and the package manager's own production-only audit (`pnpm audit --prod`,
    `npm audit --omit=dev`) does not report the package at all.

A pnpm report is accepted as complete only when its `metadata.vulnerabilities`
count for each of low, moderate, high and critical equals the number of
findings of that severity in its details. pnpm forwards the registry's
quick-audit response, which counts one vulnerability per finding (advisory ×
installed version); this was verified against real pnpm 10.30.2 reports,
now kept as test fixtures. `info` is not reconciled, because pnpm `--json`
always drops info advisories from the details. A count the details do not
explain makes the report invalid, which fails the audit.

Every accepted finding prints an `ACCEPTED (expires 2026-12-17)` line with the
advisory, package, version and this justification. Any other advisory,
package or version, any production path, a second unexpected copy, and any
failed or malformed report still fails. The workbench-core lockfile now goes
through the same policy instead of `npm audit --audit-level low`, which also
makes `info` findings actionable there. Global thresholds are otherwise
unchanged.

Upstream recheck: at least weekly and before any release (advisory
`first_patched_version`, picomatch releases, the open fix PRs). When a fixed
release ships, update the overrides and the workbench lockfile, then delete
this exception in a separate PR.
