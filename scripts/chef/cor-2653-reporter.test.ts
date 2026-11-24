import type { TestCase, TestResult } from '@playwright/test/reporter';
import { expect, spyOn, test } from 'bun:test';
import QualificationReporter from './cor-2653-reporter.ts';

test('records the first completed case and its actual status', () => {
  const writes: string[] = [];
  const output = spyOn(process.stdout, 'write').mockImplementation((value) => {
    writes.push(String(value));
    return true;
  });
  try {
    const reporter = new QualificationReporter();
    const testCase = {} as TestCase;
    const result = { status: 'passed' } as TestResult;
    reporter.onTestEnd(testCase, result);
  } finally {
    output.mockRestore();
  }
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatch(/^COR2653_TEST_END \S+ passed\n$/);
});
