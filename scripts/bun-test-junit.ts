/**
 * Runs `bun test` with the arguments given and records per-test durations as
 * JUnit XML under `test-output/junit/` in the calling workspace, so the root
 * duration ratchet (`scripts/check-test-durations.ts`) can read them.
 *
 * `bun test` neither creates the report's directory nor accepts a report
 * without a path, so this wrapper does both. The console output is unchanged
 * apart from Bun dropping its per-test `(pass)` lines while a JUnit reporter is
 * active; failures and the summary still print.
 *
 * Usage: `bun <path>/scripts/bun-test-junit.ts [--report-name=<name>] <bun test arguments>`
 * The report name defaults to `fast`. The previous report of that name is
 * removed first, so a run that dies early cannot leave a stale file behind.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

import { budgetFailures, readAllowlist } from './check-test-durations.ts';

export const JUNIT_DIRECTORY = join('test-output', 'junit');

/** Split the wrapper's own flag from the arguments destined for `bun test`. */
export function parseWrapperArguments(argumentsList: readonly string[]): {
  reportName: string;
  bunTestArguments: string[];
} {
  const flag = '--report-name=';
  const first = argumentsList[0];
  if (first?.startsWith(flag)) {
    return { reportName: first.slice(flag.length), bunTestArguments: argumentsList.slice(1) };
  }
  return { reportName: 'fast', bunTestArguments: [...argumentsList] };
}

/**
 * Turn a finished run into an exit code. A run that passed but left a fast-lane test over budget
 * and off the allowlist fails here, in the test task itself, so turbo never caches the report and
 * rerunning `bun run test` measures again instead of replaying an inflated duration.
 */
export function finishRun(
  workspace: string,
  exitCode: number,
  reportXmls: readonly string[],
  allowlist: readonly string[],
  write: (message: string) => void,
): number {
  if (exitCode !== 0) return exitCode;
  const failures = budgetFailures(workspace, reportXmls, allowlist);
  if (failures.length === 0) return 0;
  write(
    'bun-test-junit — a fast-lane test is over the per-test budget and not on the allowlist.\n' +
      'Make it fast or move it to a .slow.test.ts file; rerun if the host was busy. See AGENTS.md.\n' +
      failures.map((failure) => `  ${failure}\n`).join(''),
  );
  return 1;
}

async function main(): Promise<number> {
  const { reportName, bunTestArguments } = parseWrapperArguments(Bun.argv.slice(2));
  mkdirSync(JUNIT_DIRECTORY, { recursive: true });
  const reportPath = join(JUNIT_DIRECTORY, `${reportName}.xml`);
  rmSync(reportPath, { force: true });
  const child = Bun.spawn(
    ['bun', 'test', ...bunTestArguments, '--reporter=junit', `--reporter-outfile=${reportPath}`],
    { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' },
  );
  const exitCode = await child.exited;
  const workspace = relative(join(import.meta.dir, '..'), process.cwd()) || '.';
  const reports = existsSync(reportPath) ? [readFileSync(reportPath, 'utf8')] : [];
  return finishRun(workspace, exitCode, reports, readAllowlist(), (message) =>
    process.stderr.write(message),
  );
}

if (import.meta.main) process.exitCode = await main();
