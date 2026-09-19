import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertSingleOwner,
  collectPrunablePaths,
  isSourceFile,
  planSource,
  SourceEmissionError,
} from './source.ts';
import { planSurface } from './surface.ts';
import { loadTargetOwnedPolicy, writeTransformOutput } from './target-owned.ts';

const licence = 'MIT License\n\nCopyright (c) 2026 Steve Kinney\n';

/** Stand up a throwaway tree, hand it to the body, and remove it however the body ends. */
async function withTree(
  files: Record<string, string>,
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'corvidae-source-'));
  try {
    for (const [path, contents] of Object.entries(files))
      await Bun.write(join(root, path), contents);
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const editorWorkspace = {
  workspace: '@corvidae/editor',
  corvidaeDirectory: 'components/editor',
  targetDirectory: 'packages/editor',
} as const;

describe('what counts as source', () => {
  test('the repository-operating files are not source, wherever they sit', () => {
    expect(isSourceFile('index.ts')).toBe(true);
    expect(isSourceFile('README.md')).toBe(true);
    expect(isSourceFile('AGENTS.md')).toBe(false);
    expect(isSourceFile('CLAUDE.md')).toBe(false);
    expect(isSourceFile('.gitignore')).toBe(false);
    expect(isSourceFile('coverage-ratchet.json')).toBe(false);
    expect(isSourceFile('CHANGELOG.md')).toBe(false);
  });

  test('a workspace’s source is planned at the target’s directory, not corvidae’s', async () => {
    await withTree(
      {
        'components/editor/src/lib/index.ts': 'export const editor = true;\n',
        'components/editor/src/lib/nested/helper.ts': 'export const helper = 1;\n',
        'components/editor/src/AGENTS.md': '# Not source\n',
        'components/editor/src/node_modules/installed/index.js': 'module.exports = {};\n',
        'components/editor/coverage-ratchet.json': '{"lines":90}\n',
        'components/editor/README.md': '# editor\n',
      },
      async (root) => {
        const plan = await planSource(root, [editorWorkspace]);
        expect(Object.keys(plan.files).toSorted()).toEqual([
          'packages/editor/src/lib/index.ts',
          'packages/editor/src/lib/nested/helper.ts',
        ]);
        expect(plan.ownedPrefixes).toEqual(['packages/editor/src']);
        expect(plan.typeScriptWorkspaces).toEqual(['@corvidae/editor']);
      },
    );
  });

  test('a declared build input corvidae carries is emitted with the source', async () => {
    await withTree(
      {
        'components/editor/src/index.ts': 'export const editor = true;\n',
        'components/editor/scripts/build.ts': 'export const build = true;\n',
      },
      async (root) => {
        const plan = await planSource(root, [
          {
            ...editorWorkspace,
            entry: {
              build: { requiredInputs: ['scripts/build.ts', 'scripts/pack-for-publish.ts'] },
            } as unknown as Parameters<typeof planSource>[1][number]['entry'],
          },
        ]);
        // The input corvidae has is carried; the one it does not have stays target-owned, which is
        // what `assertBuildInputsPresent` checks for in the clone rather than inventing here.
        expect(Object.keys(plan.files).toSorted()).toEqual([
          'packages/editor/scripts/build.ts',
          'packages/editor/src/index.ts',
        ]);
      },
    );
  });

  test('the executable bit is carried, because two of corvidae’s entry points have one', async () => {
    await withTree(
      {
        'packages/weft/src/cli-main.ts': '#!/usr/bin/env bun\nexport const main = true;\n',
        'packages/weft/src/library.ts': 'export const library = true;\n',
      },
      async (root) => {
        await chmod(join(root, 'packages/weft/src/cli-main.ts'), 0o755);
        const plan = await planSource(root, [
          {
            workspace: '@corvidae/weft',
            corvidaeDirectory: 'packages/weft',
            targetDirectory: 'packages/weft',
          },
        ]);
        expect(plan.executable).toEqual(['packages/weft/src/cli-main.ts']);
      },
    );
  });

  test('a file that is not text survives, because one source tree holds a PNG fixture', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const root = await mkdtemp(join(tmpdir(), 'corvidae-source-'));
    try {
      await Bun.write(join(root, 'packages/testing/src/__fixtures__/baseline.png'), bytes);
      const plan = await planSource(root, [
        {
          workspace: '@corvidae/testing',
          corvidaeDirectory: 'packages/testing',
          targetDirectory: 'packages/testing',
        },
      ]);
      expect(plan.files['packages/testing/src/__fixtures__/baseline.png']).toEqual(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('what a sync prunes', () => {
  test('only paths beneath an owned prefix that the plan no longer emits', async () => {
    await withTree(
      {
        'packages/editor/src/index.ts': 'export const editor = true;\n',
        'packages/editor/src/retired.ts': 'export const retired = true;\n',
        'packages/editor/src/AGENTS.md': '# Target-owned, inside a tree the transform owns\n',
        'packages/editor/scripts/build.ts': 'export const build = true;\n',
        'packages/editor/AB-429-final-contract-review.md': '# Unknown working document\n',
        'packages/mcp/src/index.ts': 'export const mcp = true;\n',
      },
      async (target) => {
        const prunable = await collectPrunablePaths(
          target,
          { ownedPrefixes: ['packages/editor/src'] },
          ['packages/editor/src/index.ts'],
        );
        // `retired.ts` alone: the target-owned file inside the prefix is not source, the build
        // input and the working document are outside the prefix, and `packages/mcp` is a
        // workspace this transform does not emit at all.
        expect(prunable).toEqual(['packages/editor/src/retired.ts']);
      },
    );
  });

  test('a target that has never received source has nothing to prune', async () => {
    await withTree({ 'packages/editor/README.md': '# editor\n' }, async (target) => {
      expect(
        await collectPrunablePaths(target, { ownedPrefixes: ['packages/editor/src'] }, []),
      ).toEqual([]);
    });
  });
});

describe('one owner per plan key', () => {
  test('two producers claiming one key is a failure naming both', () => {
    expect(() =>
      assertSingleOwner([
        { owner: 'manifests', paths: ['packages/editor/package.json'] },
        { owner: 'source', paths: ['packages/editor/package.json'] },
      ]),
    ).toThrow(SourceEmissionError);
    try {
      assertSingleOwner([
        { owner: 'typescript-configuration', paths: ['packages/editor/tsconfig.json'] },
        { owner: 'source', paths: ['packages/editor/tsconfig.json'] },
      ]);
    } catch (error) {
      expect((error as Error).message).toContain('packages/editor/tsconfig.json');
      expect((error as Error).message).toContain('typescript-configuration');
      expect((error as Error).message).toContain('source');
    }
  });

  test('disjoint claims pass, which is what the real plan relies on', () => {
    expect(() =>
      assertSingleOwner([
        { owner: 'manifests', paths: ['packages/editor/package.json'] },
        { owner: 'typescript-configuration', paths: ['packages/editor/tsconfig.json'] },
        { owner: 'source', paths: ['packages/editor/src/index.ts'] },
      ]),
    ).not.toThrow();
  });
});

describe('a remapped workspace on disk', () => {
  /**
   * The remap is what the other assertions in this file take on trust, so it is checked the way a
   * sync would see it: plan the whole surface for a workspace corvidae keeps under `components/`,
   * write the plan through the guard, and read the result off the filesystem.
   */
  test('lands at the target’s own directory, read back from the written tree', async () => {
    const source = 'export const editor = "corvidae";\n';
    await withTree(
      {
        LICENSE: licence,
        'package.json': `${JSON.stringify({
          name: 'corvidae',
          private: true,
          type: 'module',
          license: 'MIT',
          workspaces: ['components/*', 'internal/*'],
          catalog: {},
        })}\n`,
        'internal/typescript/package.json': `${JSON.stringify({
          name: '@corvidae/typescript',
          private: true,
          type: 'module',
        })}\n`,
        'internal/typescript/base.json': '{"compilerOptions":{"strict":true}}\n',
        'internal/typescript/library.json': '{"extends":"./base.json"}\n',
        'internal/typescript/browser.json': '{"extends":"./base.json"}\n',
        'components/editor/package.json': `${JSON.stringify({
          name: '@corvidae/editor',
          private: true,
          type: 'module',
          exports: { '.': './src/index.ts' },
          scripts: { typecheck: 'tsc --noEmit' },
        })}\n`,
        'components/editor/tsconfig.json': `${JSON.stringify({
          extends: '@corvidae/typescript/browser.json',
        })}\n`,
        'components/editor/src/lib/index.ts': source,
      },
      async (root) => {
        const plan = await planSurface({ corvidaeRoot: root, target: 'cinder' });
        await withTree({}, async (directory) => {
          const policy = await loadTargetOwnedPolicy();
          const { written } = await writeTransformOutput({
            policy,
            target: 'cinder',
            directory,
            files: plan.files,
            executable: plan.source.executable,
          });
          expect(written).toContain('packages/editor/src/lib/index.ts');
          expect(await readFile(join(directory, 'packages/editor/src/lib/index.ts'), 'utf8')).toBe(
            source,
          );
          expect(await Bun.file(join(directory, 'packages/editor/package.json')).exists()).toBe(
            true,
          );
          expect(await Bun.file(join(directory, 'components/editor/package.json')).exists()).toBe(
            false,
          );
          const metadata = await stat(join(directory, 'packages/editor/src/lib/index.ts'));
          expect(metadata.isFile()).toBe(true);
        });
      },
    );
  });
});
