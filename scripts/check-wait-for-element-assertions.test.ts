import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import {
  collectTestFiles,
  findWaitForElementAssertionViolations,
} from './check-wait-for-element-assertions';

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

describe('test file discovery', () => {
  test('reaches nested workspace tests and skips installed and generated directories', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wait-for-scan-'));
    try {
      for (const path of [
        'components/weft-ui/src/routes/list.test.ts',
        'components/chat/scripts/tool.test.ts',
        'components/chat/src/helper.ts',
        'components/chat/node_modules/dependency/index.test.ts',
        'components/chat/.svelte-kit/generated.test.ts',
        'applications/desktop/build/bundled.test.ts',
        'packages/weft/coverage/report.test.ts',
      ]) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        writeFileSync(join(directory, path), '');
      }
      const paths: string[] = [];
      collectTestFiles(directory, paths);
      expect(paths.map((path) => relative(directory, path)).toSorted()).toEqual([
        'components/chat/scripts/tool.test.ts',
        'components/weft-ui/src/routes/list.test.ts',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
