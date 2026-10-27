/**
 * Names the test files whose `bun test --parallel` worker process died, from a JUnit report.
 *
 * When a worker dies, Bun reports the file it was running as a one-test suite whose only test case
 * is `(worker crashed)`, and its console summary says "1 tests failed" without naming a test.
 * That is a dead process, not a failed assertion: on 2026-10-27 a Bureau fast lane
 * failed on `src/session-input-crash-recovery.test.ts` while the file passes alone, and macOS
 * recorded a Bun trap ("Do not call JSObject::realm() on objects with realmless structures") in
 * `~/Library/Logs/DiagnosticReports`. The wrapper prints the file and where that crash report is,
 * so the failure is not mistaken for a flaky test. It never retries and never changes the exit
 * code.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WORKER_CRASH_TEST_NAME = '(worker crashed)';

/** The directory where macOS writes crash reports for the current user. */
export const DIAGNOSTIC_REPORTS_DIRECTORY = join(homedir(), 'Library', 'Logs', 'DiagnosticReports');

function decodeAttribute(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/** Every test file a JUnit report records as having crashed its worker, in report order. */
export function crashedWorkerFiles(xml: string): string[] {
  const files: string[] = [];
  for (const suite of xml.matchAll(/<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/g)) {
    const hasCrashCase = [...suite[2]!.matchAll(/<testcase\b[^>]*>/g)].some((testCase) =>
      testCase[0].includes(`name="${WORKER_CRASH_TEST_NAME}"`),
    );
    if (!hasCrashCase) continue;
    const name = /\bname="([^"]*)"/.exec(suite[1]!)?.[1];
    if (name !== undefined) files.push(decodeAttribute(name));
  }
  return files;
}

/** Bun crash reports macOS wrote at or after `sinceMilliseconds`, newest first. */
export function bunCrashReportsSince(
  sinceMilliseconds: number,
  directory: string = DIAGNOSTIC_REPORTS_DIRECTORY,
): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^bun-.*\.ips$/.test(name))
    .map((name) => ({
      path: join(directory, name),
      modified: statSync(join(directory, name)).mtimeMs,
    }))
    .filter((entry) => entry.modified >= sinceMilliseconds)
    .sort((a, b) => b.modified - a.modified)
    .map((entry) => entry.path);
}

/**
 * The console message for a run whose JUnit reports show crashed workers, or `null` when none did.
 * `crashReports` are the Bun crash reports written since the run began.
 */
export function workerCrashMessage(
  workspace: string,
  reportXmls: readonly string[],
  crashReports: readonly string[],
): string | null {
  const files = reportXmls.flatMap(crashedWorkerFiles);
  if (files.length === 0) return null;
  return (
    `bun-test-junit — ${workspace}: ${files.length} test worker${files.length === 1 ? '' : 's'} crashed. ` +
    'A worker process died before reporting results; this is a crashed or killed process, not a failed assertion. The file below was the one in flight.\n' +
    files.map((file) => `  worker crashed while running ${file}\n`).join('') +
    (crashReports.length > 0
      ? `Bun crash reports written during this run:\n${crashReports.map((path) => `  ${path}\n`).join('')}`
      : 'No Bun crash report was written during this run (macOS: ~/Library/Logs/DiagnosticReports).\n')
  );
}
