import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  judgeExportRuntimeReach,
  scanExportRuntimeReach,
  type ExportRuntimeReachAllowlistEntry,
} from './check-export-runtime-reach.ts';

function withRepository(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'export-runtime-reach-'));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

test('reports a public export that reaches Bun.file', async () =>
  withRepository(
    {
      'packages/demo/package.json': JSON.stringify({
        name: '@scope/demo',
        exports: { '.': './src/index.ts' },
      }),
      'packages/demo/src/index.ts': "export const asset = Bun.file('asset.txt');\n",
    },
    async (root) => {
      const verdict = judgeExportRuntimeReach(await scanExportRuntimeReach(root), []);
      expect(verdict.unlisted).toEqual([
        { package: '@scope/demo', subpath: '.', finding: 'Bun.file' },
      ]);
    },
  ));

test('reports a public export that reaches another workspace test kit', async () =>
  withRepository(
    {
      'packages/demo/package.json': JSON.stringify({ name: '@scope/demo', exports: { '.': './src/index.ts' } }),
      'packages/demo/src/index.ts': "export { fixture } from '@scope/helper';\n",
      'packages/helper/package.json': JSON.stringify({ name: '@scope/helper', exports: { '.': './src/index.ts' } }),
      'packages/helper/src/index.ts': "export { fixture } from './testing/fixture.ts';\n",
      'packages/helper/src/testing/fixture.ts': 'export const fixture = 1;\n',
    },
    async (root) => {
      const verdict = judgeExportRuntimeReach(await scanExportRuntimeReach(root), []);
      expect(verdict.unlisted).toContainEqual({
        package: '@scope/demo', subpath: '.', finding: 'test-kit: packages/helper/src/testing/fixture.ts',
      });
    },
  ));

test('reports a stale allowlist entry', () => {
  const stale: ExportRuntimeReachAllowlistEntry = {
    package: '@scope/demo',
    subpath: '.',
    finding: 'Bun.file',
    reason: 'fixture only',
  };
  expect(judgeExportRuntimeReach([], [stale])).toEqual({
    unlisted: [],
    stale: [stale],
    shrunk: [],
  });
});

test('the repository matches the export runtime reach allowlist', async () => {
  const allowlist: ExportRuntimeReachAllowlistEntry[] = await Bun.file(
    join(import.meta.dir, 'export-runtime-reach-allowlist.json'),
  ).json();
  expect(judgeExportRuntimeReach(await scanExportRuntimeReach(), allowlist)).toEqual({
    unlisted: [],
    stale: [],
    shrunk: allowlist,
  });
});
