import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { findGlobalOverrideViolation } from './check-test-cleanup.ts';

function inspect(source: string): string | null {
  const parsed = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  return findGlobalOverrideViolation(parsed);
}

describe('global override analysis', () => {
  test.each(['Object.defineProperty()', 'Object.defineProperty(globalThis)'])(
    'tolerates an incomplete call while editing: %s',
    (source) => expect(inspect(source)).toBeNull(),
  );

  test('still rejects a complete hazardous override without teardown', () => {
    expect(inspect("Object.defineProperty(window, 'matchMedia', { value: () => {} })")).toContain(
      'matchMedia',
    );
  });
});
