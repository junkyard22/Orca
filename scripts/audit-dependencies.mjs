import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// The upstream report names 10.2.6 and firstPhasePreProcess(). The registry's
// broader <11.0.1 range also matches these legacy releases, which do not have
// that preprocessing implementation. Keep their callable API for asar/filelist.
// https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249
const legacyMinimatch = new Set(['3.1.5', '5.1.9']);

export function assessAudit(report) {
  if (report?.error || !report?.metadata?.vulnerabilities ||
      !report.advisories || typeof report.advisories !== 'object' || Array.isArray(report.advisories)) {
    throw new Error('Audit returned an invalid or unsuccessful report');
  }
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical']) {
    const count = report.metadata.vulnerabilities[severity];
    if (!Number.isInteger(count) || count < 0) throw new Error('Audit severity counts are incomplete');
  }
  const advisories = Object.values(report.advisories);
  if (Object.values(report.metadata.vulnerabilities).some(count => count > 0) && !advisories.length) {
    throw new Error('Audit reports vulnerabilities without advisory details');
  }
  const actionable = [];
  const unaffected = [];
  for (const advisory of advisories) {
    if (!Array.isArray(advisory.findings) || !advisory.findings.length) {
      throw new Error('Audit advisory has no findings');
    }
    for (const finding of advisory.findings) {
      const entry = { id: advisory.github_advisory_id, package: advisory.module_name,
        severity: advisory.severity, version: finding.version, paths: finding.paths };
      if (advisory.github_advisory_id === 'GHSA-g3hv-75wg-m249' &&
          advisory.module_name === 'minimatch' && legacyMinimatch.has(finding.version)) {
        unaffected.push(entry);
      } else {
        actionable.push(entry);
      }
    }
  }
  return { actionable, unaffected };
}

export function runAudit() {
  // pnpm supplies its JS entrypoint to package scripts. Run it without a shell
  // so Windows and Unix use the same command and preserve the audit exit code.
  if (!process.env.npm_execpath) throw new Error('Run this check with pnpm audit:dependencies');
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'audit', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || ![0, 1].includes(result.status)) {
    throw result.error ?? new Error(`Audit failed (${result.status}): ${result.stderr}`);
  }
  const assessment = assessAudit(JSON.parse(result.stdout));
  for (const finding of assessment.unaffected) {
    console.log(`NOT AFFECTED: ${finding.id} ${finding.package}@${finding.version} (legacy implementation; see docs/SECURITY_DEPENDENCIES.md)`);
  }
  for (const finding of assessment.actionable) console.error(JSON.stringify(finding));
  console.log(`${assessment.actionable.length} actionable findings; ${assessment.unaffected.length} documented legacy range mismatches`);
  return assessment.actionable.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = runAudit(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
