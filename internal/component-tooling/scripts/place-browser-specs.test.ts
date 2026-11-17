import { describe, expect, test } from 'bun:test';

import {
  coveringPackage,
  differences,
  nameSlug,
  readExportSources,
  referencedSlugs,
  type PlacementMap,
  type Workspace,
} from './place-browser-specs.ts';

const slugs = new Set(['button', 'card', 'modal', 'tooltip', 'chat', 'review-editor']);

function workspaces(entries: [string, string[]][]): Map<string, Workspace> {
  return new Map(
    entries.map(([name, dependencies]) => [
      name,
      { name, directory: name.split('/')[1]!, dependencies },
    ]),
  );
}

describe('referencedSlugs', () => {
  test('reads the slugs a spec opens, and not the roles it queries', () => {
    const source = [
      "await page.goto(fixtureRoute('modal'), { waitUntil: 'load' });",
      "const entry = loadManifest().find((candidate) => candidate.slug === 'card');",
      "await page.getByRole('button', { name: 'Close' }).click();",
      "await page.goto('/page/tooltip?fixture=assertion');",
    ].join('\n');
    expect([...referencedSlugs(source, slugs)].toSorted()).toEqual(['card', 'modal', 'tooltip']);
  });

  test('reads a list whose every member is a slug, and not a list with anything else', () => {
    expect([...referencedSlugs("const covered = ['button', 'card'];", slugs)].toSorted()).toEqual([
      'button',
      'card',
    ]);
    expect([...referencedSlugs("const roles = ['button', 'dialog'];", slugs)]).toEqual([]);
  });
});

describe('coveringPackage', () => {
  const graph = workspaces([
    ['@lostgradient/button', []],
    ['@lostgradient/tooltip', []],
    ['@lostgradient/modal', ['@lostgradient/button', '@lostgradient/tooltip']],
    ['@lostgradient/card', ['@lostgradient/button']],
    [
      '@lostgradient/cinder',
      [
        '@lostgradient/button',
        '@lostgradient/tooltip',
        '@lostgradient/modal',
        '@lostgradient/card',
      ],
    ],
    ['@lostgradient/chat', ['@lostgradient/cinder']],
  ]);

  test('places one owner in itself, and an owner that depends on the rest in it', () => {
    expect(coveringPackage(graph, new Set(['@lostgradient/button']))).toBe('@lostgradient/button');
    expect(coveringPackage(graph, new Set(['@lostgradient/modal', '@lostgradient/button']))).toBe(
      '@lostgradient/modal',
    );
  });

  test('places owners no one of which covers the rest in core, never in a package of neither', () => {
    // Modal depends on both, but is neither: the spec belongs to core.
    expect(coveringPackage(graph, new Set(['@lostgradient/button', '@lostgradient/tooltip']))).toBe(
      '@lostgradient/cinder',
    );
  });

  test('places a Cinder and a chat owner in chat, which is above core', () => {
    expect(coveringPackage(graph, new Set(['@lostgradient/card', '@lostgradient/chat']))).toBe(
      '@lostgradient/chat',
    );
  });

  test('places nothing without an owner', () => {
    expect(coveringPackage(graph, new Set())).toBeUndefined();
  });
});

describe('readExportSources', () => {
  test("follows core's barrel to the package and the name each export has there", () => {
    const files: Record<string, string> = {
      'src/exports/utilities.ts':
        "export { useToast } from '@lostgradient/foundation/utilities/use-toast.ts';\n",
    };
    const sources = readExportSources(
      [
        "export { default as Button } from '@lostgradient/button/components/button/index.ts';",
        "export type { ButtonProps } from '@lostgradient/button/components/button/index.ts';",
        "export { localThing } from './local.ts';",
        "export * from './exports/utilities.ts';",
      ].join('\n'),
      (path) => files[path] ?? '',
    );
    expect(sources.get('Button')).toEqual({
      package: '@lostgradient/button',
      specifier: '@lostgradient/button/components/button/index.ts',
      imported: 'default',
      type: false,
    });
    expect(sources.get('ButtonProps')?.type).toBe(true);
    expect(sources.get('localThing')?.package).toBe('@lostgradient/cinder');
    expect(sources.get('useToast')?.package).toBe('@lostgradient/foundation');
  });
});

describe('nameSlug and differences', () => {
  test("a spec's name names the longest slug it starts with", () => {
    expect(nameSlug('review-editor-scroll.playwright.ts', slugs)).toBe('review-editor');
    expect(nameSlug('buttons.playwright.ts', slugs)).toBeUndefined();
  });

  test('a recomputed map that differs names each difference', () => {
    const recorded: PlacementMap = {
      specs: { 'a.playwright.ts': 'button' },
      appFixtures: {},
      baselines: { button: 'button' },
      baselineFiles: {},
    };
    const computed: PlacementMap = {
      specs: { 'a.playwright.ts': 'core' },
      appFixtures: {},
      baselines: { button: 'button' },
      baselineFiles: {},
    };
    expect(differences(recorded, computed)).toEqual([
      'specs.a.playwright.ts: recorded button, computed core',
    ]);
    expect(differences(recorded, recorded)).toEqual([]);
  });
});
