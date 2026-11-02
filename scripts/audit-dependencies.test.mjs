import assert from 'node:assert/strict';
import test from 'node:test';
import { assessAudit } from './audit-dependencies.mjs';

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
    { actionable: [], unaffected: [] });
});
