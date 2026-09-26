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
    'await waitFor(() => expect(onClose).toHaveBeenCalled());',
    'flushSync();\nexpect(queryMenu()).toBeNull();',
    'await waitFor(check);',
  ])('accepts %s', (source) => {
    expect(inspect(source)).toEqual([]);
  });
});

describe('waitFor element identity assertions', () => {
  test.each([
    'await waitFor(() => expect(document.activeElement).toBe(button));',
    'await waitFor(() => expect(button).toBe(document.activeElement));',
    "await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox')));",
    "await waitFor(() => expect(document.activeElement).toEqual(container.querySelector('input')));",
    'await waitFor(() => expect(document.activeElement).toStrictEqual(button));',
    'await waitFor(() => expect(menu?.parentElement).toBe(document.body));',
    "await waitFor(() => expect(container.querySelector('.toast')).not.toBe(firstToast));",
    "const first = container.querySelector('.toast');\nawait waitFor(() => expect(current).not.toBe(first));",
    "const root = input.closest('.root');\nawait waitFor(() => {\n  const ancestor = input.closest('.compact');\n  expect(ancestor).not.toBe(root);\n});",
    'let target: HTMLElement | null = null;\nawait waitFor(() => expect(target).toBe(other));',
    "const button = requiredInstance(container.querySelector('button'), HTMLButtonElement);\nawait waitFor(() => expect(current).toBe(button));",
    "const items = container.querySelectorAll('li');\nawait waitFor(() => expect(items[0]).toBe(current));",
    "function treeItem(label: string): HTMLElement {\n  return lookup(label);\n}\nawait waitFor(() => expect(current).toBe(treeItem('Beta')));",
    'const renameInput = (): HTMLInputElement => lookup();\nawait waitFor(() => expect(current).toBe(renameInput()));',
    'await waitFor(() => expect(current).toBe(lookup() as HTMLElement));',
  ])('rejects %s', (source) => {
    expect(inspect(source)).toHaveLength(1);
  });

  test.each([
    'await waitFor(() => expect(document.activeElement === button).toBe(true));',
    'await waitFor(() => expect(document.activeElement?.outerHTML).toBe(button.outerHTML));',
    'let calls = 0;\nawait waitFor(() => expect(calls).toBe(1));',
    "const writes: string[] = [];\nawait waitFor(() => expect(writes).toEqual(['payload']));",
    "let clipboardValue = '';\nconst multiline = 'a\\nb';\nawait waitFor(() => expect(clipboardValue).toBe(multiline));",
    "const idle = button.querySelector('svg path')?.getAttribute('d');\nawait waitFor(() => expect(current).not.toBe(idle));",
    "await waitFor(() => expect(trigger.getAttribute('aria-label')).toBe(tooltipText));",
    'await waitFor(() => expect(region()?.textContent).toBe(message));',
    'await waitFor(() => expect(unresolved).toBe(alsoUnresolved));',
    "await waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('true'));",
    'await waitFor(() => expect(errors[0]?.error).toBe(loadError));',
    'function label(): string {\n  return "x";\n}\nawait waitFor(() => expect(current).toBe(label()));',
    'flushSync();\nexpect(document.activeElement).toBe(button);',
  ])('accepts %s', (source) => {
    expect(inspect(source)).toEqual([]);
  });
});

describe('violation reporting', () => {
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
