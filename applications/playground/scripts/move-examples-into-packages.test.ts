import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { planMoves } from './move-examples-into-packages.ts';

const OLD = ['applications', 'playground', 'src', 'examples'].join('/');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'move-examples-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const manifest = (name: string, dependencies: Record<string, string> = {}): string =>
  JSON.stringify({ name, dependencies });

// The synthetic Cinder sits in `components/kit`, not `components/core`: the split's extraction
// rewrites every `components/core/src/...` path in the repository to the package that takes it, and
// these paths name no real file.
const BASE = {
  'applications/playground/package.json': JSON.stringify({
    name: '@lostgradient/playground',
    dependencies: { '@lostgradient/chat': 'workspace:*', '@lucide/svelte': 'catalog:' },
  }),
  'components/kit/package.json': manifest('@lostgradient/cinder', {
    '@lucide/svelte': 'catalog:',
  }),
  'components/kit/src/components/button/button.svelte': '',
  'components/chat/package.json': manifest('@lostgradient/chat', {
    '@lostgradient/cinder': 'workspace:*',
  }),
  'components/chat/src/lib/components/chat/chat.svelte': '',
};

describe('planMoves', () => {
  test('moves each example into its component directory and helpers into the playground', () => {
    const files = {
      ...BASE,
      [`${OLD}/button/basic.example.svelte`]:
        "<script>import { Button } from '@lostgradient/cinder';</script>",
      [`${OLD}/chat/basic.example.svelte`]:
        "<script>import { Chat } from '@lostgradient/chat';</script>",
      [`${OLD}/featured-examples.ts`]: 'export {};',
    };
    const root = tree(files);
    const plan = planMoves(root, Object.keys(files));
    expect(plan.problems).toEqual([]);
    expect(plan.moves.map(({ from, to }) => [from, to])).toEqual([
      [
        `${OLD}/button/basic.example.svelte`,
        'components/kit/src/components/button/examples/basic.example.svelte',
      ],
      [
        `${OLD}/chat/basic.example.svelte`,
        'components/chat/src/lib/components/chat/examples/basic.example.svelte',
      ],
      [`${OLD}/featured-examples.ts`, 'applications/playground/src/featured-examples.ts'],
    ]);
  });

  test('adds a registry package the playground declares as a development dependency', () => {
    const files = {
      ...BASE,
      [`${OLD}/chat/icon.example.svelte`]:
        "<script>import X from '@lucide/svelte/icons/x';</script>",
    };
    const plan = planMoves(tree(files), Object.keys(files));
    expect(plan.problems).toEqual([]);
    expect(plan.additions.get('components/chat')).toEqual(
      new Map([['@lucide/svelte', 'catalog:']]),
    );
  });

  test('stops on an import that would make a workspace cycle', () => {
    const files = {
      ...BASE,
      [`${OLD}/button/in-chat.example.svelte`]:
        "<script>import { Chat } from '@lostgradient/chat';</script>",
    };
    const plan = planMoves(tree(files), Object.keys(files));
    expect(plan.problems).toEqual([
      `${OLD}/button/in-chat.example.svelte: @lostgradient/cinder does not declare @lostgradient/chat`,
    ]);
  });

  test('stops on an example directory no component owns', () => {
    const files = { ...BASE, [`${OLD}/missing/basic.example.svelte`]: '' };
    expect(planMoves(tree(files), Object.keys(files)).problems).toEqual([
      `${OLD}/missing/basic.example.svelte: no component directories hold missing/missing.svelte`,
    ]);
  });

  test('drops a file already at its destination and stops on a different one', () => {
    const destination = 'components/kit/src/components/button/examples';
    const files = {
      ...BASE,
      [`${OLD}/button/same.example.svelte`]: 'same',
      [`${destination}/same.example.svelte`]: 'same',
      [`${OLD}/button/other.example.svelte`]: 'old',
      [`${destination}/other.example.svelte`]: 'new',
    };
    const plan = planMoves(tree(files), Object.keys(files));
    expect(plan.duplicates).toEqual([`${OLD}/button/same.example.svelte`]);
    expect(plan.problems).toEqual([
      `${OLD}/button/other.example.svelte: ${destination}/other.example.svelte already exists with different content`,
    ]);
  });

  test('plans nothing once the old directory is empty', () => {
    expect(planMoves(tree(BASE), Object.keys(BASE)).moves).toEqual([]);
  });
});
