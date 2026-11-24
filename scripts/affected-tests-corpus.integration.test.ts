import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runWithHangGuard } from '../testing/testing/src/hang-guard.ts';
import { selectTests } from './affected-tests-selection.ts';
import { discoverWorkspaces, listTree, sourceAnalysisCache } from './affected-tests.ts';

const wrapper = join(import.meta.dir, 'bun-test.ts');
const detector = 'packages/sample/src/detector.test.ts';
const unrelated = 'packages/sample/src/unrelated.test.ts';
const shared = {
  'package.json': JSON.stringify({ name: 'corpus', workspaces: ['packages/*'] }),
  'packages/sample/package.json': JSON.stringify({ name: 'sample', scripts: { test: 'bun test' } }),
};
const readTest = (expression: string) =>
  `import { test, expect } from 'bun:test';\ntest('detector', async () => { expect(${expression}).toBe('good'); });\n`;

const controls = [
  {
    name: 'leaf',
    changed: ['packages/sample/src/value.ts'],
    fallback: null,
    input: 'packages/sample/src/value.ts',
    good: "export const value = 'good';",
    bad: "export const value = 'bad';",
    test: "import { value } from './value.ts';\n" + readTest('value'),
  },
  {
    name: 'transitive consumer',
    changed: ['packages/sample/src/value.ts'],
    fallback: null,
    input: 'packages/sample/src/value.ts',
    good: "export const value = 'good';",
    bad: "export const value = 'bad';",
    extra: { 'packages/sample/src/entry.ts': "export { value } from './value.ts';" },
    test: "import { value } from './entry.ts';\n" + readTest('value'),
  },
  {
    name: 'generated input',
    changed: ['packages/sample/src/generated.json'],
    fallback: null,
    input: 'packages/sample/src/generated.json',
    good: 'good',
    bad: 'bad',
    test: readTest("await Bun.file(import.meta.dir + '/generated.json').text()"),
  },
  {
    name: 'computed reference',
    changed: ['packages/sample/src/computed.txt'],
    fallback:
      'packages/sample/src/detector.test.ts reads files by a computed name like packages/sample/src/computed.txt',
    input: 'packages/sample/src/computed.txt',
    good: 'good',
    bad: 'bad',
    test:
      "const name = 'computed';\n" +
      readTest('await Bun.file(`${import.meta.dir}/${name}.txt`).text()'),
  },
  {
    name: 'rename',
    changed: ['packages/sample/src/value.ts', 'packages/sample/src/renamed.ts'],
    fallback: 'packages/sample/src/renamed.ts is imported by nothing',
    input: 'packages/sample/src/value.ts',
    renamed: 'packages/sample/src/renamed.ts',
    good: "export const value = 'good';",
    bad: null,
    test: "import { value } from './value.ts';\n" + readTest('value'),
  },
  {
    name: 'deletion',
    changed: ['packages/sample/src/value.ts'],
    fallback: null,
    input: 'packages/sample/src/value.ts',
    good: "export const value = 'good';",
    bad: null,
    test: "import { value } from './value.ts';\n" + readTest('value'),
  },
  {
    name: 'root configuration',
    changed: ['package.json'],
    fallback: 'root configuration package.json',
    input: 'package.json',
    good: JSON.stringify({ name: 'corpus', workspaces: ['packages/*'], value: 'good' }),
    bad: JSON.stringify({ name: 'corpus', workspaces: ['packages/*'], value: 'bad' }),
    test: readTest(
      "JSON.parse(await Bun.file(new URL('../../../package.json', import.meta.url)).text()).value",
    ),
  },
  {
    name: 'unmapped input',
    changed: ['packages/sample/opaque.bin'],
    fallback: 'packages/sample/opaque.bin is data the graph cannot attribute to an importer',
    input: 'packages/sample/opaque.bin',
    good: 'good',
    bad: 'bad',
    test:
      "const input = ['opaque', 'bin'].join('.');\n" +
      readTest("await Bun.file(new URL('../' + input, import.meta.url)).text()"),
  },
];

describe('selected and exhaustive detector corpus', () => {
  for (const control of controls) {
    test(control.name, async () => {
      const root = await mkdtemp(join(tmpdir(), 'affected-corpus-'));
      const put = async (path: string, content: string) => {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content);
      };
      try {
        for (const [path, content] of Object.entries({
          ...shared,
          ...control.extra,
          [detector]: control.test,
          [unrelated]:
            "import { test, expect } from 'bun:test'; test('unrelated', () => expect(true).toBe(true));",
          [control.input]: control.good,
        }))
          await put(path, content);
        const select = (analyze?: ReturnType<typeof sourceAnalysisCache>['analyze']) =>
          selectTests({
            changed: control.changed,
            tree: listTree(root),
            workspaces: discoverWorkspaces(root),
            ...(analyze === undefined ? {} : { analyze }),
          });
        const git = async (...args: string[]) => {
          const result = await runWithHangGuard(['git', '-C', root, ...args]);
          expect(result.exitCode).toBe(0);
          return result.stdout.toString().trim();
        };
        await git('init', '--quiet');
        await git('add', '.');
        const base = await git('write-tree');
        const indexDirectory = join(root, '.git', 'analysis-cache');
        const initialCache = sourceAnalysisCache(join(import.meta.dir, '..'), indexDirectory);
        select(initialCache.analyze);
        initialCache.save();
        if (control.bad === null) {
          if (control.renamed !== undefined) await put(control.renamed, control.good);
          await rm(join(root, control.input));
        } else await put(control.input, control.bad);
        await git('add', '-A');
        const candidate = await git('write-tree');
        expect(candidate).not.toBe(base);
        const warmCache = sourceAnalysisCache(join(import.meta.dir, '..'), indexDirectory);
        const selection = select(warmCache.analyze);
        const freshSelection = select();
        expect(selection.workspaces.map((workspace) => [...workspace.tests])).toEqual(
          freshSelection.workspaces.map((workspace) => [...workspace.tests]),
        );
        const selected = selection.workspaces.flatMap((workspace) => [...workspace.tests.keys()]);
        expect(selected).toContain(detector);
        const reason = selection.workspaces
          .flatMap((workspace) => [...workspace.tests])
          .find(([path]) => path === detector)?.[1];
        if (control.fallback === null) expect(reason).toMatchObject({ kind: 'imports' });
        else expect(reason).toEqual({ kind: 'fallback', rule: control.fallback });
        const execute = async (paths: string[]) => {
          const start = performance.now();
          const result = await runWithHangGuard(['bun', wrapper, ...paths], { cwd: root });
          return { ...result, elapsedMilliseconds: performance.now() - start };
        };
        const selectedFailure = await execute(selected);
        const exhaustiveFailure = await execute([detector, unrelated]);
        expect(selectedFailure.exitCode).not.toBe(0);
        expect(exhaustiveFailure.exitCode).not.toBe(0);
        const failureClass =
          control.bad === null ? 'Cannot find module' : 'expect(received).toBe(expected)';
        for (const failure of [selectedFailure, exhaustiveFailure]) {
          const output = `${failure.stdout.toString()}\n${failure.stderr.toString()}`;
          expect(output).toContain('detector.test.ts');
          expect(output).toContain(failureClass);
        }
        await put(control.input, control.good);
        if (control.renamed !== undefined) await rm(join(root, control.renamed));
        const selectedRestored = await execute(selected);
        const exhaustiveRestored = await execute([detector, unrelated]);
        expect(selectedRestored.exitCode).toBe(0);
        expect(exhaustiveRestored.exitCode).toBe(0);
        console.log(
          JSON.stringify({
            control: control.name,
            base,
            candidate,
            detector,
            declaredFallback: control.fallback,
            reason,
            selected,
            execution: 'separate Bun test processes; no Turbo test-result cache',
            selectedExit: selectedFailure.exitCode,
            exhaustiveExit: exhaustiveFailure.exitCode,
            failureClass,
            restoredSelectedExit: selectedRestored.exitCode,
            restoredExhaustiveExit: exhaustiveRestored.exitCode,
            executionMilliseconds: {
              selected: selectedFailure.elapsedMilliseconds,
              exhaustive: exhaustiveFailure.elapsedMilliseconds,
              restoredSelected: selectedRestored.elapsedMilliseconds,
              restoredExhaustive: exhaustiveRestored.elapsedMilliseconds,
            },
          }),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
