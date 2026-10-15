/**
 * Records one JSON line per finished case for `scripts/check-static-playground.ts`.
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

function attachmentText(result: TestResult, name: string): string | undefined {
  const attachment = result.attachments.find((candidate) => candidate.name === name);
  return attachment?.body === undefined ? undefined : attachment.body.toString('utf8');
}

export default class StaticPlaygroundReporter implements Reporter {
  readonly #resultsPath = readEnvironmentConfiguration().playgroundStaticResults;

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
