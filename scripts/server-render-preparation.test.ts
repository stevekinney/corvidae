import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
// Tooling tests under `scripts/` quote render calls inside string literals.
const ignoredPathSegment =
  /^(?:node_modules|dist|build|coverage|scripts|\.turbo|\.svelte-kit|\.bun)$/;
const optOutMarker = 'server-render-preparation: intentionally unprepared';

/**
 * A server render compiles its source in a `Bun.build` subprocess before it
 * renders. The compile takes seconds on a loaded host, while the render takes
 * milliseconds, so a test that compiles inside its body fails bun's 5000ms
 * per-test limit under load and passes otherwise. `beforeAll` does not help:
 * bun applies the same timeout to hooks.
 *
 * Every test file therefore awaits `prepareSvelteServerSource` (or, for the
 * build-flag check, `prepareBuildFlagHydrationCheck`) at module scope, where
 * no timeout applies. The shared renderer caches that compilation, so the
 * calls inside tests only render.
 *
 * This check is textual. Each rendered source must be a named constant with a
 * matching prepare call in the same file, unless the render itself sits at
 * module scope (an unindented line). It does not compare export conditions:
 * a render under non-default conditions needs a prepare under those same
 * conditions, which review has to confirm. A call that must stay unprepared,
 * such as a test of the unprepared-source guard, carries the opt-out marker in
 * a comment on the line above it.
 */
const renderCalls = [
  { pattern: /\b(renderSvelteOnServer|importSvelteOnServer)\(\s*([^,)]+)/g, argument: 2 },
  { pattern: /\b(renderThenHydrate)\(\s*[^,]+,\s*([^,)]+)/g, argument: 2 },
  { pattern: /\b(checkBuildFlagHydrationSafety)\(\s*([^,)]+)/g, argument: 2 },
] as const;

const identifier = /^[A-Za-z_$][\w$]*$/;

function escapeForPattern(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPrepared(source: string, helper: string, argument: string): boolean {
  const preparers =
    helper === 'checkBuildFlagHydrationSafety'
      ? 'prepareBuildFlagHydrationCheck'
      : '(?:prepareSvelteServerSource|prepareBuildFlagHydrationCheck)';
  return new RegExp(`\\b${preparers}\\(\\s*${escapeForPattern(argument)}\\b`).test(source);
}

function isExempt(lines: readonly string[], line: number): boolean {
  const text = lines[line - 1] ?? '';
  const isModuleScope = !/^\s/.test(text);
  return isModuleScope || (lines[line - 2] ?? '').includes(optOutMarker);
}

function unpreparedServerRenders(source: string): string[] {
  const lines = source.split('\n');
  const problems: { line: number; message: string }[] = [];
  for (const { pattern, argument: group } of renderCalls) {
    for (const match of source.matchAll(pattern)) {
      const helper = match[1] ?? '';
      const argument = (match[group] ?? '').trim();
      const line = source.slice(0, match.index).split('\n').length;
      if (isExempt(lines, line)) continue;
      if (!identifier.test(argument)) {
        problems.push({ line, message: `${helper} source must be a module-scope constant` });
      } else if (!isPrepared(source, helper, argument)) {
        problems.push({ line, message: `${helper}(${argument}) has no module-scope prepare` });
      }
    }
  }
  return problems
    .toSorted((left, right) => left.line - right.line)
    .map(({ line, message }) => `line ${line}: ${message}`);
}

async function testFiles(): Promise<string[]> {
  const entries = await Array.fromAsync(
    new Bun.Glob('{applications,components,packages}/**/*.test.ts').scan({
      cwd: root,
      absolute: true,
      onlyFiles: true,
    }),
  );
  return entries.filter((file) => !file.split('/').some((part) => ignoredPathSegment.test(part)));
}

describe('server render preparation', () => {
  test('flags a render inside a test body that has no module-scope prepare', () => {
    const source = [
      "const sourcePath = new URL('./a.svelte', import.meta.url).pathname;",
      "test('ssr', async () => {",
      '  await renderSvelteOnServer(sourcePath);',
      '  await renderThenHydrate(Component, sourcePath, {});',
      "  await renderSvelteOnServer(new URL('./b.svelte', import.meta.url).pathname);",
      '});',
    ].join('\n');
    expect(unpreparedServerRenders(source)).toEqual([
      'line 3: renderSvelteOnServer(sourcePath) has no module-scope prepare',
      'line 4: renderThenHydrate(sourcePath) has no module-scope prepare',
      'line 5: renderSvelteOnServer source must be a module-scope constant',
    ]);
  });

  test('accepts prepared sources, module-scope renders, and marked opt-outs', () => {
    const source = [
      "const sourcePath = new URL('./a.svelte', import.meta.url).pathname;",
      'await prepareSvelteServerSource(sourcePath);',
      'const html = await renderSvelteOnServer(otherPath);',
      "test('ssr', async () => {",
      '  await renderThenHydrate(\n    Component,\n    sourcePath,\n    {},\n  );',
      `  // ${optOutMarker}`,
      '  await checkBuildFlagHydrationSafety(unpreparedPath);',
      '});',
    ].join('\n');
    expect(unpreparedServerRenders(source)).toEqual([]);
  });

  test('requires the build-flag prepare for the build-flag check', () => {
    const source = [
      'await prepareSvelteServerSource(sourcePath);',
      "test('ssr', async () => {",
      '  await checkBuildFlagHydrationSafety(sourcePath);',
      '});',
    ].join('\n');
    expect(unpreparedServerRenders(source)).toEqual([
      'line 3: checkBuildFlagHydrationSafety(sourcePath) has no module-scope prepare',
    ]);
  });

  test('every workspace test compiles server sources at module scope', async () => {
    const files = await testFiles();
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const problems = unpreparedServerRenders(await Bun.file(file).text());
      for (const problem of problems) offenders.push(`${file.slice(root.length + 1)} ${problem}`);
    }
    expect(offenders).toEqual([]);
  });
});
