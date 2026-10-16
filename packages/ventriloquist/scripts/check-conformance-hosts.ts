/**
 * Decide whether the conformance evidence covers every required host cell.
 *
 * `test:conformance` runs on the host it is on, so each run writes one report for that host's
 * cells (`darwin-arm64:...`, `linux-arm64:...`). The approved matrix is more than one host, so
 * a single run can never prove it; this reads the reports from each host's run at one commit and
 * fails, naming the cell, when a required host has no passing report. A required cell is never
 * skipped, retried into green or replaced: absence is a failure.
 *
 * It is bound to the commit under review: reports must be from `--expected-sha <sha>` (default
 * `git rev-parse HEAD`), the working tree must be clean, every cell must carry its report's host
 * prefix and platform, each report must hold the required cases, and the hosts must have run the
 * same cells once the prefix is removed.
 *
 * Usage: `bun scripts/check-conformance-hosts.ts [--expected-sha <sha>] <report.json>...`
 * Without report paths it reads `test-results/conformance.json`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  validateEvidence,
  type EvidenceReport,
} from '../../../scripts/terminal/evidence-schema.ts';

/** The host cells the delivery is held to: macOS and Linux, both on the architecture the team develops on. */
export const REQUIRED_HOST_CELLS = ['darwin-arm64', 'linux-arm64'] as const;

/**
 * Cases a report must contain, by name. A report that is valid but small (one cell, one family)
 * proves nothing about the contract, so the checker holds every host to this list as well as to
 * its own `expectedCellIds`. The conformance suite asserts its matrix covers the same list.
 */
export const REQUIRED_CELL_NAMES = [
  'spawn-failure',
  'exit-before-attach',
  'output-after-exit-before-eof',
  'eof-without-exit',
  'authority-expiry',
  'lost-acknowledgement',
  'server-shutdown',
  'stubborn-descendants',
  'stale-generation',
  'output-overflow',
  'flood-yes',
  'flood-cat',
  'flood-both-channels',
  'stalled-consumer-pauses',
  'stalled-consumer-completes',
  'stop-while-paused',
  'revoke-while-paused',
  'input-while-paused',
  'cleanup-kills-paused-producer',
  'owned-source-release',
  'borrowed-source-unsubscribe',
  'failing-cancellation',
  'hanging-cancellation',
  'control-corrupted-frame',
  'control-over-budget-frame',
  'control-unknown-cleanup',
  'control-missing-parse-completion',
  'control-late-callback-after-close',
  'control-revoked-input-during-paste',
  'descriptor-stability',
] as const;

export type HostReport = { readonly path: string; readonly report: unknown };

/** The commit under review and whether its working tree is exactly that commit. */
export type Subject = { readonly sha: string; readonly clean: boolean };

export type HostCoverage = { readonly lines: string[]; readonly exitCode: 0 | 1 };

/** The host most of a report's cells name; a stray cell from another host is then a finding, not the host. */
function hostOf(report: EvidenceReport): string | undefined {
  const counts = new Map<string, number>();
  for (const cell of report.cells) {
    const host = cell.id.split(':')[0] as string;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return [...counts.entries()].toSorted((left, right) => right[1] - left[1])[0]?.[0];
}
const stripHost = (id: string): string => id.slice(id.indexOf(':') + 1);

/** Why a structurally valid report still cannot stand for its host, or an empty list. */
function hostProblems(report: EvidenceReport, host: string): string[] {
  const problems: string[] = [];
  const platform = host.replace('-', '/');
  for (const cell of report.cells) {
    if (cell.id.split(':')[0] !== host) problems.push(`${cell.id} is not a ${host} cell`);
    if (cell.versions['platform'] !== platform) {
      problems.push(`${cell.id} ran on ${cell.versions['platform']}, not ${platform}`);
    }
  }
  const names = report.cells.map((cell) => cell.id).join(' ');
  for (const name of REQUIRED_CELL_NAMES) {
    if (!names.includes(name)) problems.push(`no ${name} cell`);
  }
  return problems.slice(0, 5);
}

export function checkConformanceHosts(
  reports: readonly HostReport[],
  subject: Subject,
  required: readonly string[] = REQUIRED_HOST_CELLS,
): HostCoverage {
  const lines: string[] = [];
  const passing = new Map<string, EvidenceReport>();
  let failed = false;
  if (!subject.clean) {
    lines.push(
      'DIRTY the working tree is not the commit under review, so no report can stand for it',
    );
    failed = true;
  }
  for (const { path, report } of reports) {
    const errors = validateEvidence(report, 'runtime');
    const evidence = report as EvidenceReport;
    const host = errors.length === 0 ? hostOf(evidence) : undefined;
    if (errors.length > 0 || host === undefined) {
      lines.push(`INVALID ${path}: ${[...new Set(errors)].join(', ') || 'no host cell'}`);
      failed = true;
      continue;
    }
    const problems = hostProblems(evidence, host);
    if (evidence.sourceSha !== subject.sha) {
      problems.push(
        `stale: it is from ${evidence.sourceSha.slice(0, 12)}, not ${subject.sha.slice(0, 12)}`,
      );
    }
    const failing = evidence.cells.filter((cell) => !cell.passed).length;
    const verdict = problems.length > 0 ? 'REJECT' : evidence.passed ? 'PASS' : 'FAIL';
    lines.push(
      `${verdict} ${host}: ${evidence.cells.length} cells, ${failing} failing, commit ${evidence.sourceSha.slice(0, 12)}, ${path}`,
    );
    for (const problem of problems) lines.push(`  ${problem}`);
    if (verdict !== 'PASS') failed = true;
    else passing.set(host, evidence);
  }
  const idSets = [...passing.entries()].map(
    ([host, report]) => [host, new Set(report.cells.map((cell) => stripHost(cell.id)))] as const,
  );
  const [first, ...others] = idSets;
  for (const [host, ids] of others) {
    const missing = [...(first?.[1] ?? [])].filter((id) => !ids.has(id));
    const extra = [...ids].filter((id) => !first?.[1].has(id));
    if (missing.length + extra.length > 0) {
      lines.push(
        `DIVERGENT ${host} and ${first?.[0]} ran different cells: ${missing.length} missing, ${extra.length} extra (${[...missing, ...extra].slice(0, 3).join(', ')})`,
      );
      failed = true;
    }
  }
  for (const host of required) {
    if (!passing.has(host)) {
      lines.push(`MISSING ${host}: no passing report, so every ${host} cell is missing`);
      failed = true;
    }
  }
  return { lines, exitCode: failed ? 1 : 0 };
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: import.meta.dir, timeout: 30_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return result.stdout.toString().trim();
}

if (import.meta.main) {
  const argumentsList = Bun.argv.slice(2);
  const shaFlag = argumentsList.findIndex((argument) => argument === '--expected-sha');
  const expected = shaFlag === -1 ? undefined : argumentsList[shaFlag + 1];
  const paths = argumentsList.filter(
    (argument, index) => !argument.startsWith('--') && index !== shaFlag + 1,
  );
  const subject: Subject = {
    sha: expected ?? git('rev-parse', 'HEAD'),
    clean: git('status', '--porcelain') === '',
  };
  const files =
    paths.length > 0 ? paths : [join(import.meta.dir, '../test-results/conformance.json')];
  const reports = files.map((path) => ({
    path,
    report: JSON.parse(readFileSync(path, 'utf8')) as unknown,
  }));
  const { lines, exitCode } = checkConformanceHosts(reports, subject);
  console.log(lines.join('\n'));
  process.exitCode = exitCode;
}
