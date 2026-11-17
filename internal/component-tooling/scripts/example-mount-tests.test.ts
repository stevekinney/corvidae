import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  addToolingDependency,
  ensureExampleMountTests,
  EXAMPLE_MOUNT_TEST_FILE,
  EXAMPLE_MOUNT_TEST_SOURCE,
  writtenPaths,
} from './example-mount-tests.ts';
import { isGenerated } from './split-layout.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'example-mount-tests-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const manifest = (name: string, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ name, ...extra }, null, 2)}\n`;

describe('ensureExampleMountTests', () => {
  test('writes the test, and the tooling dependency, into each workspace with examples', () => {
    const root = tree({
      'components/chat/package.json': manifest('@lostgradient/chat', {
        devDependencies: { '@lostgradient/testing': 'workspace:*', zod: 'catalog:' },
      }),
      'components/chat/src/lib/components/chat/examples/basic.example.svelte': '<p>chat</p>\n',
      'components/button/package.json': manifest('@lostgradient/button', {
        devDependencies: { '@lostgradient/component-tooling': 'workspace:*' },
      }),
      'components/button/src/components/button/examples/primary.example.svelte': '<p>b</p>\n',
      'components/plain/package.json': manifest('@lostgradient/plain'),
      'components/plain/src/components/plain/plain.svelte': '<p>plain</p>\n',
    });

    const log = ensureExampleMountTests(root);

    expect(log).toEqual([
      `write components/button/${EXAMPLE_MOUNT_TEST_FILE}`,
      `write components/chat/${EXAMPLE_MOUNT_TEST_FILE}`,
      'depend components/chat -> @lostgradient/component-tooling',
    ]);
    expect(writtenPaths(log)).toEqual([
      `components/button/${EXAMPLE_MOUNT_TEST_FILE}`,
      `components/chat/${EXAMPLE_MOUNT_TEST_FILE}`,
      'components/chat/package.json',
    ]);
    expect(readFileSync(join(root, 'components/chat', EXAMPLE_MOUNT_TEST_FILE), 'utf8')).toBe(
      EXAMPLE_MOUNT_TEST_SOURCE,
    );
    expect(
      JSON.parse(readFileSync(join(root, 'components/chat/package.json'), 'utf8')).devDependencies,
    ).toEqual({
      '@lostgradient/component-tooling': 'workspace:*',
      '@lostgradient/testing': 'workspace:*',
      zod: 'catalog:',
    });
    // A workspace without examples gets nothing.
    expect(existsSync(join(root, 'components/plain', EXAMPLE_MOUNT_TEST_FILE))).toBe(false);
    // A second run changes nothing.
    expect(ensureExampleMountTests(root)).toEqual([]);
  });

  test('plans without writing on a dry run', () => {
    const root = tree({
      'components/chat/package.json': manifest('@lostgradient/chat'),
      'components/chat/src/lib/components/chat/examples/basic.example.svelte': '<p>chat</p>\n',
    });
    expect(ensureExampleMountTests(root, true)).toHaveLength(2);
    expect(existsSync(join(root, 'components/chat', EXAMPLE_MOUNT_TEST_FILE))).toBe(false);
  });
});

describe('the example-mount test', () => {
  // Core and every family hold the same file, so the family map must not read it as one file in
  // two packages.
  test('carries the extraction marker that keeps it out of the family map', () => {
    expect(isGenerated(EXAMPLE_MOUNT_TEST_SOURCE)).toBe(true);
    expect(EXAMPLE_MOUNT_TEST_SOURCE).toContain('mountEveryExample(import.meta.dir);');
  });
});

describe('addToolingDependency', () => {
  test('leaves a workspace that already depends on the tooling alone', () => {
    expect(
      addToolingDependency({ dependencies: { '@lostgradient/component-tooling': 'workspace:*' } }),
    ).toBe(false);
  });
});
