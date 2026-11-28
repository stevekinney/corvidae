import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  judgeExportRuntimeReach,
  scanExportRuntimeReach,
  scanExportRuntimeReachReport,
  type ExportRuntimeReachAllowlistEntry,
} from './check-export-runtime-reach.ts';

async function withRepository(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'export-runtime-reach-'));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('reports a public export that reaches Bun.file', async () => {
  await withRepository(
    {
      'packages/demo/package.json': JSON.stringify({
        name: '@scope/demo',
        exports: { '.': './src/index.ts' },
      }),
      'packages/demo/src/index.ts': "export const asset = Bun.file('asset.txt');\n",
    },
    async (root) => {
      expect(judgeExportRuntimeReach(await scanExportRuntimeReach(root), []).unlisted).toEqual([
        { package: '@scope/demo', subpath: '.', finding: 'Bun.file' },
      ]);
    },
  );
});

test('does not probe ./scripts/ and ./test/ tooling entry points but still probes other subpaths', async () => {
  await withRepository(
    {
      'packages/demo/package.json': JSON.stringify({
        name: '@scope/demo',
        exports: {
          './scripts/x.ts': './scripts/x.ts',
          './test/y.ts': './src/test/y.ts',
          './lib': './src/lib.ts',
        },
      }),
      'packages/demo/scripts/x.ts': "export const x = Bun.file('x.txt');\n",
      'packages/demo/src/test/y.ts': "export const y = Bun.file('y.txt');\n",
      'packages/demo/src/lib.ts': "export const lib = Bun.file('lib.txt');\n",
    },
    async (root) => {
      expect(judgeExportRuntimeReach(await scanExportRuntimeReach(root), []).unlisted).toEqual([
        { package: '@scope/demo', subpath: './lib', finding: 'Bun.file' },
      ]);
    },
  );
});

test('reports normalized Node builtins without making them guard findings', async () => {
  await withRepository(
    {
      'packages/demo/package.json': JSON.stringify({
        name: '@scope/demo',
        exports: { '.': './src/index.ts' },
      }),
      'packages/demo/src/index.ts':
        "import 'node:fs'; import 'fs'; import 'ws'; import 'undici'; import 'bun:sqlite'; export const value = 1;\n",
    },
    async (root) => {
      const report = await scanExportRuntimeReachReport(root);
      expect(report.findings).toEqual([
        { package: '@scope/demo', subpath: '.', finding: 'bun:sqlite' },
      ]);
      expect(report.nodeFindings).toEqual([
        { package: '@scope/demo', subpath: '.', finding: 'node:fs' },
      ]);
    },
  );
});

test('reports a public export reaching a foreign workspace test helper', async () => {
  await withRepository(
    {
      'packages/demo/package.json': JSON.stringify({
        name: '@scope/demo',
        exports: { '.': './src/index.ts' },
      }),
      'packages/demo/src/index.ts': "export { helper } from '@scope/helper';\n",
      'packages/helper/package.json': JSON.stringify({
        name: '@scope/helper',
        exports: { '.': './src/index.ts' },
      }),
      'packages/helper/src/index.ts': "export { helper } from './test/helper.ts';\n",
      'packages/helper/src/test/helper.ts': 'export const helper = 1;\n',
    },
    async (root) => {
      expect(
        judgeExportRuntimeReach(await scanExportRuntimeReach(root), []).unlisted,
      ).toContainEqual({
        package: '@scope/demo',
        subpath: '.',
        finding: 'test-kit: packages/helper/src/test/helper.ts',
      });
    },
  );
});

test('reports a stale allowlist entry', () => {
  const stale: ExportRuntimeReachAllowlistEntry = {
    package: '@scope/demo',
    subpath: '.',
    finding: 'Bun.file',
    reason: 'fixture',
  };
  expect(judgeExportRuntimeReach([], [stale]).stale).toEqual([stale]);
});

test('the repository matches the export runtime reach allowlist', async () => {
  const allowlist = (await Bun.file(
    join(import.meta.dir, 'export-runtime-reach-allowlist.json'),
  ).json()) as ExportRuntimeReachAllowlistEntry[];
  expect(judgeExportRuntimeReach(await scanExportRuntimeReach(), allowlist)).toEqual({
    unlisted: [],
    stale: [],
    shrunk: allowlist,
  });
});
