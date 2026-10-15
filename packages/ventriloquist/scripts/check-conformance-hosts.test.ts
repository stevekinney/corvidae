import { describe, expect, test } from 'bun:test';

import type { EvidenceCell, EvidenceReport } from '../../../scripts/terminal/evidence-schema.ts';
import { REQUIRED_HOST_CELLS, checkConformanceHosts } from './check-conformance-hosts.ts';

function reportFor(host: string, options: { passed?: boolean; sha?: string } = {}): EvidenceReport {
  const passed = options.passed ?? true;
  const cell: EvidenceCell = {
    id: `${host}:behavior:direct:pipe:output-bytes`,
    passed,
    observations: [passed ? 'pass: the bytes arrived' : 'FAIL: the bytes arrived'],
    versions: { bun: '1.4.2', platform: host.replace('-', '/') },
    metrics: { checksEvaluated: { value: 1, unit: 'checks' } },
  };
  return {
    schemaVersion: 1,
    reportKind: 'runtime',
    sourceSha: options.sha ?? 'a'.repeat(40),
    runId: 'run',
    observedAt: '2026-10-15T00:00:00.000Z',
    expectedCellIds: [cell.id],
    cells: [cell],
    passed,
  };
}

const both = REQUIRED_HOST_CELLS.map((host) => ({ path: `${host}.json`, report: reportFor(host) }));

describe('the required host cells', () => {
  test('pass when every required host has a passing report at one commit', () => {
    expect(checkConformanceHosts(both).exitCode).toBe(0);
  });

  test('fail, naming the cell, when a required host has no report', () => {
    const result = checkConformanceHosts(both.slice(0, 1));
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('MISSING linux-arm64');
  });

  test('fail when no report is given at all', () => {
    const result = checkConformanceHosts([]);
    expect(result.exitCode).toBe(1);
    expect(result.lines.filter((line) => line.startsWith('MISSING'))).toHaveLength(2);
  });

  test('fail when a host reports a failing cell, and count that host as missing', () => {
    const result = checkConformanceHosts([
      both[0]!,
      { path: 'linux.json', report: reportFor('linux-arm64', { passed: false }) },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('FAIL linux-arm64');
    expect(result.lines.join('\n')).toContain('MISSING linux-arm64');
  });

  test('fail when the reports are from different commits', () => {
    const result = checkConformanceHosts([
      both[0]!,
      { path: 'linux.json', report: reportFor('linux-arm64', { sha: 'b'.repeat(40) }) },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('MISMATCH');
  });

  test('fail on a report that does not satisfy the evidence schema', () => {
    const broken = { ...reportFor('linux-arm64'), cells: [] };
    const result = checkConformanceHosts([both[0]!, { path: 'broken.json', report: broken }]);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('INVALID broken.json');
  });
});
