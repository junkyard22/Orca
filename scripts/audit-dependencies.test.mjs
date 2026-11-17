import assert from 'node:assert/strict';
import test from 'node:test';
import { assessAudit, assessNpmAudit } from './audit-dependencies.mjs';

function report(versions, id = 'GHSA-g3hv-75wg-m249', name = 'minimatch') {
  return { metadata: { vulnerabilities: { info: 0, low: 0, moderate: versions.length, high: 0, critical: 0 } }, advisories: {
    advisory: { github_advisory_id: id, module_name: name, severity: 'moderate',
      findings: versions.map(version => ({ version, paths: ['parent>dependency'] })) },
  } };
}

test('only the two reviewed legacy minimatch releases are classified unaffected', () => {
  const result = assessAudit(report(['3.1.5', '5.1.9']));
  assert.equal(result.actionable.length, 0);
  assert.equal(result.unaffected.length, 2);
});

test('a vulnerable modern copy cannot be hidden alongside legacy copies', () => {
  const result = assessAudit(report(['3.1.5', '9.0.9', '10.2.6']));
  assert.deepEqual(result.actionable.map(finding => finding.version), ['9.0.9', '10.2.6']);
});

test('new versions, different advisories and other packages remain actionable', () => {
  assert.equal(assessAudit(report(['3.1.6'])).actionable.length, 1);
  assert.equal(assessAudit(report(['3.1.5'], 'GHSA-another-advisory')).actionable.length, 1);
  assert.equal(assessAudit(report(['3.1.5'], 'GHSA-g3hv-75wg-m249', 'another-package')).actionable.length, 1);
});

test('incomplete and failed reports fail closed', () => {
  for (const invalid of [null, {}, { error: 'registry unavailable' },
    { metadata: { vulnerabilities: {} }, advisories: {} },
    { ...report(['3.1.5']), advisories: {} },
    { ...report(['3.1.5']), advisories: { bad: { findings: [] } } }]) {
    assert.throws(() => assessAudit(invalid));
  }
});

test('a clean complete report passes', () => {
  assert.deepEqual(assessAudit({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } }, advisories: {} }),
    { actionable: [], unaffected: [], accepted: [] });
});

// ── Time-boxed development-only acceptance: GHSA-fc5q-39xc-vjpf / picomatch ──
// Specification: docs/proposals/RISK_ACCEPTANCE_GHSA-fc5q-39xc-vjpf.md

const GHSA = 'GHSA-fc5q-39xc-vjpf';
const BEFORE = new Date('2026-11-18T12:00:00Z');
const LAST_MOMENT = new Date('2026-12-16T23:59:59.999Z');
const DEV_PATH = 'apps__desktop>electron-builder>app-builder-lib>@electron/rebuild>node-gyp>tinyglobby>picomatch';
const TEST_PATH = 'packages__orca-core>vitest>@vitest/mocker>vite>tinyglobby>picomatch';
const PROD_PATH = 'packages__orca-core>maestro-core>tinyglobby>picomatch';
const CLEAN = { metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } }, advisories: {} };
const manifests = {
  apps__desktop: { dependencies: {}, devDependencies: { 'electron-builder': '26.15.7', vite: '^8' } },
  'packages__orca-core': { dependencies: { 'maestro-core': 'workspace:*' }, devDependencies: { vitest: '^4' } },
  packages__both: { dependencies: { vitest: '^4' }, devDependencies: { vitest: '^4' } },
};

function pnpmReport(findings, extra = {}) {
  const advisories = {
    pico: { github_advisory_id: GHSA, module_name: 'picomatch', severity: 'high', findings },
    ...extra,
  };
  const high = Object.values(advisories).reduce((n, a) => n + a.findings.length, 0);
  return { metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high, critical: 0 } }, advisories };
}
const ctx = (overrides = {}) => ({ now: BEFORE, manifests, prodReport: CLEAN, ...overrides });

test('pnpm: the exact dev-only picomatch copy is ACCEPTED before expiry, never silently', () => {
  const result = assessAudit(pnpmReport([{ version: '4.0.4', paths: [DEV_PATH, TEST_PATH] }]), ctx());
  assert.equal(result.actionable.length, 0);
  assert.equal(result.accepted.length, 1);
  const [accepted] = result.accepted;
  assert.deepEqual({ id: accepted.id, package: accepted.package, version: accepted.version, expires: accepted.expires },
    { id: GHSA, package: 'picomatch', version: '4.0.4', expires: '2026-12-17' });
  assert.match(accepted.justification, /RISK_ACCEPTANCE_GHSA-fc5q-39xc-vjpf\.md/);
  assert.equal(assessAudit(pnpmReport([{ version: '4.0.4', paths: [DEV_PATH] }]), ctx({ now: LAST_MOMENT })).accepted.length, 1);
});

test('pnpm: on and after 2026-12-17 the finding fails closed', () => {
  for (const now of ['2026-12-17T00:00:00Z', '2026-12-17T23:59:59Z', '2027-01-01T00:00:00Z']) {
    const result = assessAudit(pnpmReport([{ version: '4.0.4', paths: [DEV_PATH] }]), ctx({ now: new Date(now) }));
    assert.equal(result.actionable.length, 1, now);
    assert.equal(result.accepted.length, 0, now);
  }
});

test('pnpm: an invalid or missing clock fails closed', () => {
  for (const now of [undefined, new Date('invalid'), '2026-11-18', 0]) {
    assert.equal(assessAudit(pnpmReport([{ version: '4.0.4', paths: [DEV_PATH] }]), ctx({ now })).actionable.length, 1, String(now));
  }
});

test('pnpm: unrelated advisories and other packages stay actionable alongside an accepted copy', () => {
  const other = { other: { github_advisory_id: 'GHSA-zzzz-zzzz-zzzz', module_name: 'picomatch', severity: 'low', findings: [{ version: '4.0.4', paths: [DEV_PATH] }] } };
  const result = assessAudit(pnpmReport([{ version: '4.0.4', paths: [DEV_PATH] }], other), ctx());
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.actionable.map(f => f.id), ['GHSA-zzzz-zzzz-zzzz']);
  const otherPackage = { metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } }, advisories: {
    x: { github_advisory_id: GHSA, module_name: 'micromatch', severity: 'high', findings: [{ version: '4.0.4', paths: [DEV_PATH] }] } } };
  assert.equal(assessAudit(otherPackage, ctx()).actionable.length, 1);
});

test('pnpm: unexpected versions stay actionable, including mixed copies', () => {
  for (const version of ['4.0.5', '4.0.6', '2.3.1', '4.0.4-beta', '']) {
    assert.equal(assessAudit(pnpmReport([{ version, paths: [DEV_PATH] }]), ctx()).actionable.length, 1, version);
  }
  const mixed = assessAudit(pnpmReport([{ version: '4.0.4', paths: [DEV_PATH] }, { version: '4.0.6', paths: [TEST_PATH] }]), ctx());
  assert.deepEqual(mixed.accepted.map(f => f.version), ['4.0.4']);
  assert.deepEqual(mixed.actionable.map(f => f.version), ['4.0.6']);
});

test('pnpm: any production path keeps the whole finding actionable', () => {
  const cases = [
    [DEV_PATH, PROD_PATH],                                 // one production path among dev paths
    ['packages__both>vitest>vite>tinyglobby>picomatch'],   // declared as both dependency and devDependency
    ['packages__unknown>vitest>tinyglobby>picomatch'],     // importer with no manifest
    ['picomatch'], ['apps__desktop'], [],                  // no direct dependency can be identified
  ];
  for (const paths of cases) {
    assert.equal(assessAudit(pnpmReport([{ version: '4.0.4', paths }]), ctx()).actionable.length, 1, JSON.stringify(paths));
  }
});

test('pnpm: the production-only audit must not see the accepted package', () => {
  const prod = pnpmReport([{ version: '4.0.4', paths: [PROD_PATH] }]);
  assert.equal(assessAudit(pnpmReport([{ version: '4.0.4', paths: [DEV_PATH] }]), ctx({ prodReport: prod })).actionable.length, 1);
  assert.equal(assessAudit(pnpmReport([{ version: '4.0.4', paths: [DEV_PATH] }]), ctx({ prodReport: undefined })).actionable.length, 1);
  assert.throws(() => assessAudit(pnpmReport([{ version: '4.0.4', paths: [DEV_PATH] }]), ctx({ prodReport: { error: 'x' } })));
});

test('pnpm: without manifests nothing can be proven development-only', () => {
  assert.equal(assessAudit(pnpmReport([{ version: '4.0.4', paths: [DEV_PATH] }]), ctx({ manifests: undefined })).actionable.length, 1);
});

// npm audit (auditReportVersion 2) for the independent workbench-core lockfile.
const URL = `https://github.com/advisories/${GHSA}`;
const advisoryVia = (url = URL) => ({ source: 1247710, name: 'picomatch', dependency: 'picomatch', title: 'picomatch ReDoS', url, severity: 'high', range: '<=4.0.7' });
function npmReport(overrides = {}) {
  const vulnerabilities = {
    picomatch: { name: 'picomatch', severity: 'high', isDirect: false, via: [advisoryVia()], effects: ['fdir', 'tinyglobby', 'vite', 'vitest'], range: '*', nodes: ['node_modules/picomatch'] },
    fdir: { name: 'fdir', severity: 'high', isDirect: false, via: ['picomatch'], effects: ['tinyglobby'], range: '>=5.2.1', nodes: ['node_modules/fdir'] },
    tinyglobby: { name: 'tinyglobby', severity: 'high', isDirect: false, via: ['fdir', 'picomatch'], effects: ['vite', 'vitest'], range: '*', nodes: ['node_modules/tinyglobby'] },
    vite: { name: 'vite', severity: 'high', isDirect: true, via: ['picomatch', 'tinyglobby'], effects: ['vitest'], range: '>=6.3.0-beta.0', nodes: ['node_modules/vite'] },
    vitest: { name: 'vitest', severity: 'high', isDirect: true, via: ['picomatch', 'tinyglobby', 'vite'], effects: [], range: '>=3.1.2', nodes: ['node_modules/vitest'] },
    ...overrides,
  };
  for (const [key, value] of Object.entries(vulnerabilities)) if (value === undefined) delete vulnerabilities[key];
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const v of Object.values(vulnerabilities)) counts[v.severity]++;
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { ...counts, total: Object.keys(vulnerabilities).length } } };
}
const NPM_CLEAN = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } };
function lockfile(overrides = {}) {
  return { lockfileVersion: 3, packages: {
    '': { name: '@yakstacks/workbench-core' },
    'node_modules/picomatch': { version: '4.0.7', dev: true },
    'node_modules/fdir': { version: '6.5.0', dev: true },
    'node_modules/tinyglobby': { version: '0.2.17', dev: true },
    'node_modules/vite': { version: '8.3.5', dev: true },
    'node_modules/vitest': { version: '4.1.12', dev: true },
    ...overrides,
  } };
}
const npmCtx = (overrides = {}) => ({ now: BEFORE, lockfile: lockfile(), prodReport: NPM_CLEAN, ...overrides });

test('npm: the dev-only picomatch copy and the findings it alone causes are ACCEPTED before expiry', () => {
  const result = assessNpmAudit(npmReport(), npmCtx());
  assert.equal(result.actionable.length, 0);
  assert.deepEqual(result.accepted.map(f => f.package).sort(), ['fdir', 'picomatch', 'tinyglobby', 'vite', 'vitest']);
  const pico = result.accepted.find(f => f.package === 'picomatch');
  assert.deepEqual({ id: pico.id, version: pico.version, expires: pico.expires }, { id: GHSA, version: '4.0.7', expires: '2026-12-17' });
  assert.match(pico.justification, /RISK_ACCEPTANCE_GHSA-fc5q-39xc-vjpf\.md/);
  assert.equal(assessNpmAudit(npmReport(), npmCtx({ now: LAST_MOMENT })).actionable.length, 0);
});

test('npm: on and after 2026-12-17 every finding fails closed', () => {
  for (const now of ['2026-12-17T00:00:00Z', '2027-06-01T00:00:00Z']) {
    const result = assessNpmAudit(npmReport(), npmCtx({ now: new Date(now) }));
    assert.equal(result.accepted.length, 0, now);
    assert.equal(result.actionable.length, 5, now);
  }
  assert.equal(assessNpmAudit(npmReport(), npmCtx({ now: undefined })).accepted.length, 0);
});

test('npm: a production copy, an unexpected version or a second copy stays actionable', () => {
  const prodCopy = assessNpmAudit(npmReport(), npmCtx({ lockfile: lockfile({ 'node_modules/picomatch': { version: '4.0.7' } }) }));
  assert.equal(prodCopy.accepted.length, 0);
  assert.equal(prodCopy.actionable.length, 5);
  for (const version of ['4.0.6', '4.0.8', undefined]) {
    const result = assessNpmAudit(npmReport(), npmCtx({ lockfile: lockfile({ 'node_modules/picomatch': { version, dev: true } }) }));
    assert.ok(result.actionable.some(f => f.package === 'picomatch'), String(version));
  }
  const secondCopy = npmReport({ picomatch: { ...npmReport().vulnerabilities.picomatch, nodes: ['node_modules/picomatch', 'node_modules/x/node_modules/picomatch'] } });
  const mixed = assessNpmAudit(secondCopy, npmCtx({ lockfile: lockfile({ 'node_modules/x/node_modules/picomatch': { version: '4.0.5', dev: true } }) }));
  assert.ok(mixed.actionable.some(f => f.package === 'picomatch'));
  const missingNode = assessNpmAudit(secondCopy, npmCtx());
  assert.ok(missingNode.actionable.some(f => f.package === 'picomatch'));
  const prodPropagated = assessNpmAudit(npmReport(), npmCtx({ lockfile: lockfile({ 'node_modules/vite': { version: '8.3.5' } }) }));
  assert.deepEqual(prodPropagated.actionable.map(f => f.package), ['vite', 'vitest']);
});

test('npm: unrelated advisories, including on a propagated package, stay actionable', () => {
  const other = { ...advisoryVia('https://github.com/advisories/GHSA-zzzz-zzzz-zzzz'), name: 'vite', dependency: 'vite' };
  const result = assessNpmAudit(npmReport({ vite: { ...npmReport().vulnerabilities.vite, via: ['picomatch', other] } }), npmCtx());
  assert.deepEqual(result.actionable.map(f => f.package), ['vite', 'vitest']);
  const postcss = { name: 'postcss', severity: 'moderate', isDirect: false, via: [{ ...advisoryVia('https://github.com/advisories/GHSA-pppp-pppp-pppp'), name: 'postcss' }], effects: [], range: '<8.5.18', nodes: ['node_modules/postcss'] };
  const withPostcss = assessNpmAudit(npmReport({ postcss }), npmCtx({ lockfile: lockfile({ 'node_modules/postcss': { version: '8.5.0', dev: true } }) }));
  assert.deepEqual(withPostcss.actionable.map(f => f.package), ['postcss']);
  const wrongPackage = assessNpmAudit(npmReport({ picomatch: { ...npmReport().vulnerabilities.picomatch, via: [{ ...advisoryVia(), name: 'micromatch' }] } }), npmCtx());
  assert.ok(wrongPackage.actionable.some(f => f.package === 'picomatch'));
  const dangling = assessNpmAudit(npmReport({ fdir: { ...npmReport().vulnerabilities.fdir, via: ['not-in-report'] } }), npmCtx());
  assert.ok(dangling.actionable.some(f => f.package === 'fdir'));
});

test('npm: the omit=dev audit must not see picomatch', () => {
  const prod = npmReport({ fdir: undefined, tinyglobby: undefined, vite: undefined, vitest: undefined });
  assert.equal(assessNpmAudit(npmReport(), npmCtx({ prodReport: prod })).accepted.length, 0);
  assert.equal(assessNpmAudit(npmReport(), npmCtx({ prodReport: undefined })).accepted.length, 0);
  assert.equal(assessNpmAudit(npmReport(), npmCtx({ lockfile: undefined })).accepted.length, 0);
});

test('npm: malformed and failed reports fail closed', () => {
  const good = npmReport();
  const invalids = [null, {}, { error: { code: 'ENOAUDIT' } }, { ...good, auditReportVersion: 1 },
    { ...good, vulnerabilities: [] }, { ...good, metadata: { vulnerabilities: { high: 5 } } },
    { ...good, vulnerabilities: {} },
    npmReport({ fdir: { ...good.vulnerabilities.fdir, via: 'picomatch' } }),
    npmReport({ fdir: { ...good.vulnerabilities.fdir, nodes: [] } }),
    npmReport({ fdir: { ...good.vulnerabilities.fdir, via: [42] } })];
  for (const invalid of invalids) assert.throws(() => assessNpmAudit(invalid, npmCtx()), JSON.stringify(invalid)?.slice(0, 80));
  assert.throws(() => assessNpmAudit(good, npmCtx({ prodReport: { error: 'x' } })));
  assert.deepEqual(assessNpmAudit(NPM_CLEAN, npmCtx()), { actionable: [], unaffected: [], accepted: [] });
});
