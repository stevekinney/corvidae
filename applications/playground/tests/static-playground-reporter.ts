/**
 * Records one JSON line when each case begins and one when it finishes, for
 * `scripts/check-static-playground.ts`. The begin lines let the runner name the cases in flight
 * when the static server dies under them.
 *
 * A reporter runs in Playwright's main process, so it records a case that timed out or whose
 * worker crashed, which a hook inside the test cannot promise. The runner reads these lines to
 * prove every case in its shard ran and to name each failure in `report.json`.
 */
import { appendFileSync } from 'node:fs';

import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

import { readEnvironmentConfiguration } from '../src/environment-configuration.ts';

export type StaticCaseResultLine = {
  caseId: string;
  status: string;
  errors: string[];
  diagnostics: string[];
  screenshot: string | null;
};

export type StaticCaseBeginLine = { caseId: string; event: 'begin' };

function attachmentText(result: TestResult, name: string): string | undefined {
  const attachment = result.attachments.find((candidate) => candidate.name === name);
  return attachment?.body === undefined ? undefined : attachment.body.toString('utf8');
}

export default class StaticPlaygroundReporter implements Reporter {
  readonly #resultsPath = readEnvironmentConfiguration().playgroundStaticResults;

  onTestBegin(test: TestCase): void {
    if (this.#resultsPath === undefined) return;
    const line: StaticCaseBeginLine = { caseId: test.title, event: 'begin' };
    appendFileSync(this.#resultsPath, `${JSON.stringify(line)}\n`);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (this.#resultsPath === undefined) return;
    const diagnostics = attachmentText(result, 'browser-diagnostics');
    const line: StaticCaseResultLine = {
      caseId: test.title,
      status: result.status,
      errors: result.errors.map((error) => error.message ?? error.value ?? 'unknown error'),
      diagnostics: diagnostics === undefined ? [] : (JSON.parse(diagnostics) as string[]),
      screenshot: attachmentText(result, 'failure-screenshot-path') ?? null,
    };
    appendFileSync(this.#resultsPath, `${JSON.stringify(line)}\n`);
  }

  printsToStdio(): boolean {
    return false;
  }
}
