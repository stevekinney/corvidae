import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

export default class QualificationReporter implements Reporter {
  onTestEnd(_test: TestCase, result: TestResult): void {
    process.stdout.write(`COR2653_TEST_END ${new Date().toISOString()} ${result.status}\n`);
  }
}
