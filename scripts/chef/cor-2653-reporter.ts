import type { Reporter, TestCase, TestResult, TestStep } from '@playwright/test/reporter';

export default class QualificationReporter implements Reporter {
  private readonly seen = new WeakSet<TestResult>();

  onStepBegin(_test: TestCase, result: TestResult, step: TestStep): void {
    if (step.category !== 'expect' || this.seen.has(result)) return;
    this.seen.add(result);
    process.stdout.write(`COR2653_ASSERTION ${new Date().toISOString()}\n`);
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    process.stdout.write(`COR2653_TEST_END ${new Date().toISOString()} ${result.status}\n`);
  }
}
