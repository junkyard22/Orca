import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The upstream report names 10.2.6 and firstPhasePreProcess(). The registry's
// broader <11.0.1 range also matches these legacy releases, which do not have
// that preprocessing implementation. Keep their callable API for asar/filelist.
// https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249
const legacyMinimatch = new Set(['3.1.5', '5.1.9']);

// Time-boxed, development-only risk acceptance. Owner-approved specification:
// docs/proposals/RISK_ACCEPTANCE_GHSA-fc5q-39xc-vjpf.md
//
// Exactly one advisory, one package and two installed versions. A finding is
// accepted only while every one of these holds:
//  - the clock is valid and before EXPIRES_AT (on and after it, fail closed);
//  - every dependency path is development-only, proven twice: from the
//    manifest/lockfile, and by the package manager's own production-only audit
//    not reporting the package at all.
// Accepted findings are printed on every run; they are never hidden. There is
// no environment, flag or configuration override.
export const RISK_ACCEPTANCE = Object.freeze({
  id: 'GHSA-fc5q-39xc-vjpf',
  url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
  package: 'picomatch',
  versions: Object.freeze(['4.0.4', '4.0.7']),
  expires: '2026-12-17',
  justification: 'docs/proposals/RISK_ACCEPTANCE_GHSA-fc5q-39xc-vjpf.md',
});
const EXPIRES_AT = Date.UTC(2026, 11, 17); // 2026-12-17T00:00:00Z

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => isRecord(object) && Object.prototype.hasOwnProperty.call(object, key);

function withinAcceptanceWindow(now) {
  return now instanceof Date && Number.isFinite(now.getTime()) && now.getTime() < EXPIRES_AT;
}

function acceptedRecord(entry, extra = {}) {
  return { ...entry, id: RISK_ACCEPTANCE.id, expires: RISK_ACCEPTANCE.expires,
    justification: RISK_ACCEPTANCE.justification, developmentOnly: true, ...extra };
}

// ── pnpm ────────────────────────────────────────────────────────────────────

function validatePnpmReport(report) {
  if (report?.error || !isRecord(report?.metadata?.vulnerabilities) || !isRecord(report.advisories)) {
    throw new Error('Audit returned an invalid or unsuccessful report');
  }
  for (const severity of SEVERITIES) {
    const count = report.metadata.vulnerabilities[severity];
    if (!Number.isInteger(count) || count < 0) throw new Error('Audit severity counts are incomplete');
  }
  const advisories = Object.values(report.advisories);
  if (Object.values(report.metadata.vulnerabilities).some(count => count > 0) && !advisories.length) {
    throw new Error('Audit reports vulnerabilities without advisory details');
  }
  for (const advisory of advisories) {
    if (!Array.isArray(advisory?.findings) || !advisory.findings.length) throw new Error('Audit advisory has no findings');
  }
  return advisories;
}

/** A pnpm path is "<importer>>direct>…>package"; development-only when `direct` is only a devDependency of that importer. */
function pnpmPathIsDevelopmentOnly(dependencyPath, manifests) {
  if (typeof dependencyPath !== 'string') return false;
  const [importer, direct] = dependencyPath.split('>');
  if (!importer || !direct || !has(manifests, importer)) return false;
  const manifest = manifests[importer];
  return has(manifest.devDependencies, direct) &&
    !has(manifest.dependencies, direct) && !has(manifest.optionalDependencies, direct) && !has(manifest.peerDependencies, direct);
}

function pnpmProductionAuditSeesPackage(prodAdvisories) {
  return prodAdvisories.some(advisory => advisory.module_name === RISK_ACCEPTANCE.package || advisory.github_advisory_id === RISK_ACCEPTANCE.id);
}

/**
 * @param report pnpm audit --json (full tree)
 * @param context { now: Date, manifests: { [importerId]: package.json }, prodReport: pnpm audit --prod --json }
 */
export function assessAudit(report, context = {}) {
  const advisories = validatePnpmReport(report);
  const prodAdvisories = context.prodReport === undefined ? undefined : validatePnpmReport(context.prodReport);
  const acceptanceOpen = withinAcceptanceWindow(context.now) && prodAdvisories !== undefined &&
    !pnpmProductionAuditSeesPackage(prodAdvisories) && isRecord(context.manifests);
  const actionable = [];
  const unaffected = [];
  const accepted = [];
  for (const advisory of advisories) {
    for (const finding of advisory.findings) {
      const entry = { id: advisory.github_advisory_id, package: advisory.module_name,
        severity: advisory.severity, version: finding.version, paths: finding.paths };
      if (advisory.github_advisory_id === 'GHSA-g3hv-75wg-m249' &&
          advisory.module_name === 'minimatch' && legacyMinimatch.has(finding.version)) {
        unaffected.push(entry);
      } else if (acceptanceOpen && advisory.github_advisory_id === RISK_ACCEPTANCE.id &&
          advisory.module_name === RISK_ACCEPTANCE.package && RISK_ACCEPTANCE.versions.includes(finding.version) &&
          Array.isArray(finding.paths) && finding.paths.length > 0 &&
          finding.paths.every(dependencyPath => pnpmPathIsDevelopmentOnly(dependencyPath, context.manifests))) {
        accepted.push(acceptedRecord(entry));
      } else {
        actionable.push(entry);
      }
    }
  }
  return { actionable, unaffected, accepted };
}

// ── npm (auditReportVersion 2) ──────────────────────────────────────────────

function validateNpmReport(report) {
  if (!isRecord(report) || report.error || report.auditReportVersion !== 2 ||
      !isRecord(report.vulnerabilities) || !isRecord(report.metadata?.vulnerabilities)) {
    throw new Error('npm audit returned an invalid or unsuccessful report');
  }
  let total = 0;
  for (const severity of SEVERITIES) {
    const count = report.metadata.vulnerabilities[severity];
    if (!Number.isInteger(count) || count < 0) throw new Error('npm audit severity counts are incomplete');
    total += count;
  }
  const entries = Object.entries(report.vulnerabilities);
  if (total !== entries.length) throw new Error('npm audit severity counts do not match its vulnerability details');
  for (const [name, entry] of entries) {
    if (!isRecord(entry) || entry.name !== name || !SEVERITIES.includes(entry.severity) ||
        !Array.isArray(entry.via) || entry.via.length === 0 ||
        !entry.via.every(via => typeof via === 'string' || (isRecord(via) && typeof via.url === 'string' && typeof via.name === 'string')) ||
        !Array.isArray(entry.nodes) || entry.nodes.length === 0 || !entry.nodes.every(node => typeof node === 'string')) {
      throw new Error(`npm audit entry is malformed: ${name}`);
    }
  }
  return report.vulnerabilities;
}

const nodeIsDevelopmentOnly = (lockfile, node) => lockfile.packages[node]?.dev === true;

/**
 * @param report npm audit --json (full tree, auditReportVersion 2)
 * @param context { now: Date, lockfile: package-lock.json, prodReport: npm audit --omit=dev --json }
 */
export function assessNpmAudit(report, context = {}) {
  const vulnerabilities = validateNpmReport(report);
  const prodVulnerabilities = context.prodReport === undefined ? undefined : validateNpmReport(context.prodReport);
  const lockfile = isRecord(context.lockfile?.packages) ? context.lockfile : undefined;
  const acceptanceOpen = withinAcceptanceWindow(context.now) && lockfile !== undefined && prodVulnerabilities !== undefined &&
    !has(prodVulnerabilities, RISK_ACCEPTANCE.package) &&
    !Object.values(prodVulnerabilities).some(entry => entry.via.some(via => isRecord(via) && via.url === RISK_ACCEPTANCE.url));

  const verdicts = new Map();
  const isAccepted = (name, visiting = new Set()) => {
    if (verdicts.has(name)) return verdicts.get(name);
    if (!acceptanceOpen || !has(vulnerabilities, name) || visiting.has(name)) return false;
    visiting.add(name);
    const entry = vulnerabilities[name];
    const devOnly = entry.nodes.every(node => nodeIsDevelopmentOnly(lockfile, node));
    let ok = devOnly && entry.via.every(via => typeof via === 'string'
      ? isAccepted(via, visiting)
      : via.url === RISK_ACCEPTANCE.url && via.name === RISK_ACCEPTANCE.package && name === RISK_ACCEPTANCE.package);
    if (ok && name === RISK_ACCEPTANCE.package) {
      ok = entry.nodes.every(node => RISK_ACCEPTANCE.versions.includes(lockfile.packages[node]?.version));
    }
    visiting.delete(name);
    verdicts.set(name, ok);
    return ok;
  };

  const actionable = [];
  const accepted = [];
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    const record = { id: entry.via.filter(isRecord).map(via => via.url.replace('https://github.com/advisories/', '')).join(',') || `via ${entry.via.join(',')}`,
      package: name, severity: entry.severity, version: lockfile?.packages[entry.nodes[0]]?.version, nodes: entry.nodes };
    if (isAccepted(name)) {
      accepted.push(acceptedRecord(record, name === RISK_ACCEPTANCE.package ? {} : { through: entry.via }));
    } else {
      actionable.push(record);
    }
  }
  return { actionable, unaffected: [], accepted };
}

// ── Running the audits ──────────────────────────────────────────────────────

function parseAuditOutput(result, label) {
  if (result.error || ![0, 1].includes(result.status)) {
    throw result.error ?? new Error(`${label} failed (${result.status}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function report(assessment, label) {
  for (const finding of assessment.unaffected) {
    console.log(`NOT AFFECTED: ${finding.id} ${finding.package}@${finding.version} (legacy implementation; see docs/SECURITY_DEPENDENCIES.md)`);
  }
  for (const finding of assessment.accepted) {
    const through = finding.through ? ` (affected only through ${finding.through.join(', ')})` : '';
    console.log(`ACCEPTED (expires ${finding.expires}): ${finding.id} ${finding.package}@${finding.version ?? 'unknown'}${through}; ` +
      `development-only dependency path; justification: ${finding.justification}`);
  }
  for (const finding of assessment.actionable) console.error(JSON.stringify(finding));
  console.log(`${label}: ${assessment.actionable.length} actionable findings; ${assessment.unaffected.length} documented legacy range mismatches; ` +
    `${assessment.accepted.length} time-boxed accepted (expires ${RISK_ACCEPTANCE.expires})`);
  return assessment.actionable.length ? 1 : 0;
}

/** Workspace importers keyed the way pnpm audit paths name them ("apps/desktop" → "apps__desktop"). */
function workspaceManifests(root) {
  const manifests = {};
  const add = (dir) => {
    const file = path.join(root, dir, 'package.json');
    if (existsSync(file)) manifests[dir === '.' ? '.' : dir.split(/[\\/]/).join('__')] = JSON.parse(readFileSync(file, 'utf8'));
  };
  add('.');
  const workspace = readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  for (const match of workspace.matchAll(/^\s*-\s*['"]?([^'"\s#]+)['"]?\s*$/gm)) {
    const pattern = match[1];
    if (pattern.endsWith('/*')) {
      const base = pattern.slice(0, -2);
      for (const child of readdirSync(path.join(root, base), { withFileTypes: true })) if (child.isDirectory()) add(`${base}/${child.name}`);
    } else {
      add(pattern);
    }
  }
  return manifests;
}

export function runAudit() {
  // pnpm supplies its JS entrypoint to package scripts. Run it without a shell
  // so Windows and Unix use the same command and preserve the audit exit code.
  if (!process.env.npm_execpath) throw new Error('Run this check with pnpm audit:dependencies');
  const pnpm = (args) => parseAuditOutput(spawnSync(process.execPath, [process.env.npm_execpath, ...args],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }), `pnpm ${args.join(' ')}`);
  const assessment = assessAudit(pnpm(['audit', '--json']), {
    now: new Date(),
    prodReport: pnpm(['audit', '--prod', '--json']),
    manifests: workspaceManifests(process.cwd()),
  });
  return report(assessment, 'pnpm audit');
}

export function runNpmAudit(directory) {
  const cwd = path.resolve(directory);
  // Fixed arguments only. Windows needs a shell to resolve npm.cmd; it is given
  // one constant command string, never caller input.
  const options = { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 };
  const npm = (args) => parseAuditOutput(process.platform === 'win32'
    ? spawnSync(`npm ${args.join(' ')}`, { ...options, shell: true })
    : spawnSync('npm', args, options), `npm ${args.join(' ')}`);
  const assessment = assessNpmAudit(npm(['audit', '--no-workspaces', '--json']), {
    now: new Date(),
    prodReport: npm(['audit', '--no-workspaces', '--omit=dev', '--json']),
    lockfile: JSON.parse(readFileSync(path.join(cwd, 'package-lock.json'), 'utf8')),
  });
  return report(assessment, `npm audit (${directory})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const npmIndex = process.argv.indexOf('--npm');
    process.exitCode = npmIndex === -1 ? runAudit() : runNpmAudit(process.argv[npmIndex + 1] ?? '');
  } catch (error) { console.error(error); process.exitCode = 1; }
}
