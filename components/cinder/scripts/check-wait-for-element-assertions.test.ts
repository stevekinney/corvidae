import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { findWaitForElementAssertionViolations } from './check-wait-for-element-assertions.ts';

function inspect(source: string): string[] {
  const parsed = ts.createSourceFile('fixture.test.ts', source, ts.ScriptTarget.Latest, true);
  return findWaitForElementAssertionViolations(parsed).map((violation) => violation.text);
}

describe('waitFor element absence assertions', () => {
  test.each([
    'await waitFor(() => expect(queryMenu()).toBeNull());',
    'await waitFor(() => expect(container.querySelector(\'[role="menu"]\')).toBeNull());',
    "await waitFor(() => expect(document.querySelector('section')).toBeUndefined());",
    "await waitFor(() => expect(screen.queryByRole('menu')).toBeFalsy());",
    "await waitFor(() => expect(queryByRole('menu')).not.toBeTruthy());",
    'await waitFor(() => expect(getListbox()).not.toBeDefined());',
    'await waitFor(() => expect(queryMenu()).toBe(null));',
    'await waitFor(() => expect(queryMenu()).toEqual(undefined));',
    'await waitFor(() => expect(closingMenu).toBeNull());',
    'await waitFor(() => expect(document.activeElement).toBeNull());',
    'await waitFor(() => expect(trigger.closest(".menu")!).toBeNull());',
    'await screen.waitFor(() => expect(queryMenu()).toBeNull());',
    'await waitFor(() => {\n  expect(queryMenu()).not.toBeNull();\n  expect(queryPanel()).toBeNull();\n});',
    'await waitFor(function () {\n  expect(queryMenu()).toBeNull();\n});',
  ])('rejects %s', (source) => {
    expect(inspect(source)).toHaveLength(1);
  });

  test.each([
    'await waitFor(() => expect(queryMenu()?.outerHTML ?? null).toBeNull());',
    "await waitFor(() => expect(slide?.getAttribute('aria-hidden')).toBeNull());",
    'await waitFor(() => expect(queryMenu()?.textContent).toBeUndefined());',
    'await waitFor(() => expect(queryMenu() === null).toBe(true));',
    'await waitFor(() => expect(queryMenu()).not.toBeNull());',
    'await waitFor(() => expect(queryMenu()).toBeTruthy());',
    'await waitFor(() => expect(queryMenu()).toBeDefined());',
    'await waitFor(() => expect(undefined).toBeUndefined());',
    'await waitFor(() => expect(document.activeElement).toBe(button));',
    'await waitFor(() => expect(onClose).toHaveBeenCalled());',
    'flushSync();\nexpect(queryMenu()).toBeNull();',
    'await waitFor(check);',
  ])('accepts %s', (source) => {
    expect(inspect(source)).toEqual([]);
  });

  test('reports the offending matcher call and its line', () => {
    const parsed = ts.createSourceFile(
      'fixture.test.ts',
      'render();\n\nawait waitFor(() => expect(queryMenu()).toBeNull());\n',
      ts.ScriptTarget.Latest,
      true,
    );
    expect(findWaitForElementAssertionViolations(parsed)).toEqual([
      { line: 3, text: 'expect(queryMenu()).toBeNull()' },
    ]);
  });
});
