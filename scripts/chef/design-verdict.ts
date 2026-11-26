#!/usr/bin/env bun
// The design verdict a head carries into landing (`landing-evidence.ts`).
//
// Usage:
//   bun scripts/chef/design-verdict.ts record --head <sha> --file <rows file> --capture <capture directory>
//     --ledger <coverage ledger> --state-directory <dir>
//
// The coordinator runs `record` after the design-reviewer's verdict. `--file` is the verdicts file of
// the design-review skill (`row-id | verdict | evidence`, one row per line, no header). It is
// validated (three fields, a known verdict word, evidence for anything but `matches`) and written to
// `<state directory>/design-verdicts/<head>.verdicts`, the coordinator's execution-state directory
// (the `--state-directory` of its verification request), never the worktree. Landing passes only
// when every row is `matches` or `deferred`; `record` accepts every known word, because a failing
// verdict is a verdict too.
//
// The review's coverage ledger (`design-coverage.ts`) comes with it. An incomplete ledger is refused,
// because a review that never judged a capture has not happened. A complete ledger that blocks
// approval (a screen judged wrong or unsure, a sweep that found something, a state not captured) is
// recorded as one more failing row, `coverage-ledger`, so landing refuses the head. The ledger is
// kept beside the verdicts as `<head>.ledger`. Exit 0 recorded, 1 refused, 2 invalid usage.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { checkLedger } from './design-coverage.ts';
import { emitResult, parseOptions, UsageError } from './process-runner.ts';

export { UsageError };

/** Every verdict word a row can carry (`.agents/skills/design-review/references/findings.md`). */
export const verdictWords = [
  'matches',
  'drifted',
  'partial',
  'missing',
  'superseded',
  'deferred',
  'unverified',
] as const;

const PASSING_VERDICTS: ReadonlySet<string> = new Set(['matches', 'deferred']);
const MAXIMUM_EVIDENCE_LENGTH = 300;

/** Where a head's design verdicts are recorded, beside the execution state. */
export function designVerdictPath(stateDirectory: string, head: string): string {
  return join(stateDirectory, 'design-verdicts', `${head}.verdicts`);
}

/** The problems that make a verdicts file unrecordable; empty when it is well formed. */
export function verdictFileProblems(text: string): string[] {
  const rows = text.split('\n').filter((line) => line.trim() !== '');
  if (rows.length === 0) return ['the verdicts file has no rows'];
  const problems: string[] = [];
  for (const [index, line] of rows.entries()) {
    const label = `row ${index + 1}`;
    const fields = line.split('|').map((field) => field.trim());
    if (fields.length !== 3 || fields[0] === '') {
      problems.push(`${label}: expected "row-id | verdict | evidence", got "${line}"`);
      continue;
    }
    const [, verdict = '', evidence = ''] = fields;
    if (!(verdictWords as readonly string[]).includes(verdict))
      problems.push(`${label}: "${verdict}" is not one of ${verdictWords.join(', ')}`);
    else if (verdict !== 'matches' && evidence === '')
      problems.push(`${label}: ${verdict} needs evidence`);
    if (evidence.length > MAXIMUM_EVIDENCE_LENGTH)
      problems.push(`${label}: evidence is longer than ${MAXIMUM_EVIDENCE_LENGTH} characters`);
  }
  return problems;
}

/** The rows of a verdicts file that are not a pass; a file with no rows is one failing row. */
export function failingVerdictRows(text: string): string[] {
  const rows = text.split('\n').filter((line) => line.trim() !== '');
  if (rows.length === 0) return ['the verdicts file has no rows'];
  return rows.flatMap((line) => {
    const [id = '', verdict = ''] = line.split('|').map((field) => field.trim());
    return id !== '' && PASSING_VERDICTS.has(verdict) ? [] : [`${id || line}: ${verdict || '?'}`];
  });
}

/** The failing row a blocking coverage ledger adds, kept within the evidence limit. */
function coverageRow(blocking: readonly string[]): string {
  const evidence = `approval blocked by the coverage ledger: ${blocking.join('; ')}`.replaceAll(
    '|',
    '/',
  );
  const short =
    evidence.length <= MAXIMUM_EVIDENCE_LENGTH
      ? evidence
      : `${evidence.slice(0, MAXIMUM_EVIDENCE_LENGTH - 3)}...`;
  return `coverage-ledger | unverified | ${short}`;
}

export function run(argv: string[]): { code: number; output: string } {
  const parsed = parseOptions(argv, {
    values: ['head', 'file', 'capture', 'ledger', 'state-directory'],
  });
  if (parsed.positionals[0] !== 'record' || parsed.positionals.length !== 1)
    throw new UsageError(
      'Usage: design-verdict.ts record --head <sha> --file <rows file> --capture <capture directory> --ledger <coverage ledger> --state-directory <dir>',
    );
  const head = parsed.values['head'];
  if (head === undefined || !/^[0-9a-f]{40}$/.test(head))
    throw new UsageError('--head must be a full commit SHA.');
  const file = parsed.values['file'];
  if (file === undefined) throw new UsageError('--file is required.');
  const stateDirectory = parsed.values['state-directory'];
  if (stateDirectory === undefined || stateDirectory === '')
    throw new UsageError(
      '--state-directory is required: the coordinator execution-state directory.',
    );
  const capture = parsed.values['capture'];
  const ledgerFile = parsed.values['ledger'];
  if (capture === undefined || ledgerFile === undefined)
    throw new UsageError(
      "--capture and --ledger are required: the review's capture directory and its coverage ledger (design-coverage.ts).",
    );
  const rowsText = readFileSync(resolve(file), 'utf8');
  const problems = verdictFileProblems(rowsText);
  if (problems.length > 0) return { code: 1, output: `refused: ${problems.join('; ')}` };
  const ledgerText = readFileSync(resolve(ledgerFile), 'utf8');
  const ledger = checkLedger(capture, ledgerText);
  if (ledger.problems.length > 0)
    return {
      code: 1,
      output: `refused, the coverage ledger is incomplete: ${ledger.problems.join('; ')}`,
    };
  const text =
    ledger.blocking.length === 0
      ? rowsText
      : `${rowsText.trimEnd()}\n${coverageRow(ledger.blocking)}\n`;
  const target = designVerdictPath(resolve(stateDirectory), head);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(`${target}.tmp`, text);
  renameSync(`${target}.tmp`, target);
  writeFileSync(target.replace(/\.verdicts$/, '.ledger'), ledgerText);
  const failing = failingVerdictRows(text);
  return {
    code: 0,
    output: `recorded ${target}${failing.length === 0 ? '' : ` (landing refuses: ${failing.join('; ')})`}`,
  };
}

if (import.meta.main) {
  try {
    const result = run(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), result);
    process.exitCode = result.code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
