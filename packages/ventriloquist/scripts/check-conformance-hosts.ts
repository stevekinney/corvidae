/**
 * Decide whether the conformance evidence covers every required host cell.
 *
 * `test:conformance` runs on the host it is on, so each run writes one report for that host's
 * cells (`darwin-arm64:...`, `linux-arm64:...`). The approved matrix is more than one host, so
 * a single run can never prove it; this reads the reports from each host's run at one commit and
 * fails, naming the cell, when a required host has no passing report. A required cell is never
 * skipped, retried into green or replaced: absence is a failure.
 *
 * Usage: `bun scripts/check-conformance-hosts.ts <report.json>...`
 * Without arguments it reads `test-results/conformance.json`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  validateEvidence,
  type EvidenceReport,
} from '../../../scripts/terminal/evidence-schema.ts';

/** The host cells the delivery is held to: macOS and Linux, both on the architecture the team develops on. */
export const REQUIRED_HOST_CELLS = ['darwin-arm64', 'linux-arm64'] as const;

export type HostReport = { readonly path: string; readonly report: unknown };

export type HostCoverage = { readonly lines: string[]; readonly exitCode: 0 | 1 };

const hostOf = (report: EvidenceReport): string | undefined => report.cells[0]?.id.split(':')[0];

export function checkConformanceHosts(
  reports: readonly HostReport[],
  required: readonly string[] = REQUIRED_HOST_CELLS,
): HostCoverage {
  const lines: string[] = [];
  const passing = new Map<string, EvidenceReport>();
  let failed = false;
  for (const { path, report } of reports) {
    const errors = validateEvidence(report, 'runtime');
    const evidence = report as EvidenceReport;
    const host = errors.length === 0 ? hostOf(evidence) : undefined;
    if (errors.length > 0 || host === undefined) {
      lines.push(`INVALID ${path}: ${[...new Set(errors)].join(', ') || 'no host cell'}`);
      failed = true;
      continue;
    }
    const failing = evidence.cells.filter((cell) => !cell.passed).length;
    lines.push(
      `${evidence.passed ? 'PASS' : 'FAIL'} ${host}: ${evidence.cells.length} cells, ${failing} failing, commit ${evidence.sourceSha.slice(0, 12)}, ${path}`,
    );
    if (!evidence.passed) failed = true;
    else passing.set(host, evidence);
  }
  const commits = new Set([...passing.values()].map((report) => report.sourceSha));
  if (commits.size > 1) {
    lines.push(`MISMATCH the reports are from different commits: ${[...commits].join(', ')}`);
    failed = true;
  }
  for (const host of required) {
    if (!passing.has(host)) {
      lines.push(`MISSING ${host}: no passing report, so every ${host} cell is missing`);
      failed = true;
    }
  }
  return { lines, exitCode: failed ? 1 : 0 };
}

if (import.meta.main) {
  const paths = Bun.argv.slice(2);
  const files =
    paths.length > 0 ? paths : [join(import.meta.dir, '../test-results/conformance.json')];
  const reports = files.map((path) => ({
    path,
    report: JSON.parse(readFileSync(path, 'utf8')) as unknown,
  }));
  const { lines, exitCode } = checkConformanceHosts(reports);
  console.log(lines.join('\n'));
  process.exitCode = exitCode;
}
