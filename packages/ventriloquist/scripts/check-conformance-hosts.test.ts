import { describe, expect, test } from 'bun:test';

import type { EvidenceCell, EvidenceReport } from '../../../scripts/terminal/evidence-schema.ts';
import {
  REQUIRED_CELL_NAMES,
  REQUIRED_HOST_CELLS,
  checkConformanceHosts,
  type Subject,
} from './check-conformance-hosts.ts';

const SHA = 'a'.repeat(40);
const SUBJECT: Subject = { sha: SHA, clean: true };

function cellFor(host: string, name: string, passed = true): EvidenceCell {
  return {
    id: `${host}:behavior:direct:pipe:${name}`,
    passed,
    observations: [passed ? 'pass: held' : 'FAIL: held'],
    versions: { bun: '1.4.4', platform: host.replace('-', '/') },
    metrics: { checksEvaluated: { value: 1, unit: 'checks' } },
  };
}

function reportOf(cells: EvidenceCell[], sha = SHA): EvidenceReport {
  return {
    schemaVersion: 1,
    reportKind: 'runtime',
    sourceSha: sha,
    runId: 'run',
    observedAt: '2026-10-15T00:00:00.000Z',
    expectedCellIds: cells.map((cell) => cell.id),
    cells,
    passed: cells.every((cell) => cell.passed),
  };
}

/** A report with every required case, as a real run of the suite would write. */
function fullReport(host: string, sha = SHA): EvidenceReport {
  return reportOf(
    REQUIRED_CELL_NAMES.map((name) => cellFor(host, name)),
    sha,
  );
}

const entry = (host: string, report: EvidenceReport = fullReport(host)) => ({
  path: `${host}.json`,
  report,
});
const both = REQUIRED_HOST_CELLS.map((host) => entry(host));
const text = (reports: ReturnType<typeof entry>[], subject = SUBJECT) =>
  checkConformanceHosts(reports, subject).lines.join('\n');

describe('the required host cells', () => {
  test('pass when every required host has a full, passing report at the commit under review', () => {
    expect(checkConformanceHosts(both, SUBJECT).exitCode).toBe(0);
  });

  test('fail, naming the cell, when a required host has no report', () => {
    const result = checkConformanceHosts(both.slice(0, 1), SUBJECT);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('MISSING linux-arm64');
  });

  test('fail when no report is given at all', () => {
    const result = checkConformanceHosts([], SUBJECT);
    expect(result.exitCode).toBe(1);
    expect(result.lines.filter((line) => line.startsWith('MISSING'))).toHaveLength(2);
  });

  test('reject a valid report that holds a single cell', () => {
    const tiny = reportOf([cellFor('linux-arm64', 'output-bytes')]);
    const result = checkConformanceHosts([both[0]!, entry('linux-arm64', tiny)], SUBJECT);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('REJECT linux-arm64');
    expect(result.lines.join('\n')).toContain('no spawn-failure cell');
  });

  test('reject a report from another commit as stale', () => {
    const stale = fullReport('linux-arm64', 'b'.repeat(40));
    const output = text([both[0]!, entry('linux-arm64', stale)]);
    expect(output).toContain('REJECT linux-arm64');
    expect(output).toContain('stale');
  });

  test('reject every report when the working tree is not the commit under review', () => {
    const result = checkConformanceHosts(both, { sha: SHA, clean: false });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('DIRTY');
  });

  test('reject a report holding a cell with another host prefix', () => {
    const cells = REQUIRED_CELL_NAMES.map((name) => cellFor('linux-arm64', name));
    cells[0] = cellFor('darwin-arm64', REQUIRED_CELL_NAMES[0]);
    const output = text([both[0]!, entry('linux-arm64', reportOf(cells))]);
    expect(output).toContain('is not a linux-arm64 cell');
  });

  test('reject a cell whose recorded platform is not its host', () => {
    const cells = REQUIRED_CELL_NAMES.map((name) => cellFor('linux-arm64', name));
    cells[1] = { ...cells[1]!, versions: { bun: '1.4.4', platform: 'darwin/arm64' } };
    const output = text([both[0]!, entry('linux-arm64', reportOf(cells))]);
    expect(output).toContain('ran on darwin/arm64, not linux/arm64');
  });

  test('reject hosts that ran different cells once the host prefix is removed', () => {
    const cells = [
      ...REQUIRED_CELL_NAMES.map((name) => cellFor('linux-arm64', name)),
      cellFor('linux-arm64', 'only-on-linux'),
    ];
    const output = text([both[0]!, entry('linux-arm64', reportOf(cells))]);
    expect(output).toContain('DIVERGENT');
  });

  test('fail when a host reports a failing cell, and count that host as missing', () => {
    const cells = REQUIRED_CELL_NAMES.map((name, index) => cellFor('linux-arm64', name, index > 0));
    const output = text([both[0]!, entry('linux-arm64', reportOf(cells))]);
    expect(output).toContain('FAIL linux-arm64');
    expect(output).toContain('MISSING linux-arm64');
  });

  test('fail on a report that does not satisfy the evidence schema', () => {
    const broken = { ...fullReport('linux-arm64'), cells: [] };
    const output = text([both[0]!, { path: 'broken.json', report: broken }]);
    expect(output).toContain('INVALID broken.json');
  });
});
