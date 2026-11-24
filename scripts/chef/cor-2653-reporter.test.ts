import type { TestCase, TestResult, TestStep } from '@playwright/test/reporter';
import { expect, spyOn, test } from 'bun:test';
import QualificationReporter from './cor-2653-reporter.ts';

test('records one assertion and its independently completed case', () => {
  const writes: string[] = [];
  const output = spyOn(process.stdout, 'write').mockImplementation((value) => {
    writes.push(String(value));
    return true;
  });
  try {
    const reporter = new QualificationReporter();
    const testCase = {} as TestCase;
    const result = { status: 'passed' } as TestResult;
    const step = { category: 'expect' } as TestStep;
    reporter.onStepBegin(testCase, result, step);
    reporter.onStepBegin(testCase, result, step);
    reporter.onTestEnd(testCase, result);
  } finally {
    output.mockRestore();
  }
  expect(writes).toHaveLength(2);
  expect(writes[0]).toMatch(/^COR2653_ASSERTION \S+\n$/);
  expect(writes[1]).toMatch(/^COR2653_TEST_END \S+ passed\n$/);
});
