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

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

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

async function main(): Promise<number> {
  const { reportName, bunTestArguments } = parseWrapperArguments(Bun.argv.slice(2));
  mkdirSync(JUNIT_DIRECTORY, { recursive: true });
  const reportPath = join(JUNIT_DIRECTORY, `${reportName}.xml`);
  rmSync(reportPath, { force: true });
  const child = Bun.spawn(
    ['bun', 'test', ...bunTestArguments, '--reporter=junit', `--reporter-outfile=${reportPath}`],
    { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' },
  );
  return child.exited;
}

if (import.meta.main) process.exitCode = await main();
