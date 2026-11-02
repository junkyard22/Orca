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
