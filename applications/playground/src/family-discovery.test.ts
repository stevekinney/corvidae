/**
 * A Cinder family package core depends on is discovered with no edit to the playground
 * (COR-2085, AC2). The fixture is a miniature repository whose core lists one family package;
 * its manifest records each component's source the way core's manifest generator does, and the
 * playground's Cinder component source reads it.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { discoverComponentDirectories } from '@lostgradient/component-tooling/scripts/discover-component-directories.ts';
import { createFamilyFixture } from '@lostgradient/component-tooling/scripts/family-fixture.test-support.ts';
import { componentSource } from '@lostgradient/component-tooling/scripts/generate-manifest.ts';

import { rewriteComponentReadmeLinks } from './component-documentation.ts';
import {
  componentRoots,
  createCinderComponentSource,
  examplesDirectoryIn,
} from './component-sources.ts';

const fixture = createFamilyFixture();
afterAll(() => {
  rmSync(fixture.root, { recursive: true, force: true });
});

// Core's manifest, as the generator writes it: every component core lists, with its source.
const components = await discoverComponentDirectories(fixture.coreRoot);
writeFileSync(
  join(fixture.coreRoot, 'components.json'),
  `${JSON.stringify({
    components: components.map((component) => ({
      id: component.name,
      exportName: component.name,
      source: componentSource(component, fixture.coreRoot),
    })),
  })}\n`,
);
const source = createCinderComponentSource(fixture.coreRoot, 'family-discovery-fixture');

describe('a family package core depends on', () => {
  test('lists its component beside the ones still in core, each exactly once', () => {
    expect([...source.components().keys()]).toEqual(['button', fixture.familyComponent]);
  });

  test('finds the component, and its examples, in the family package', () => {
    const location = source.components().get(fixture.familyComponent);
    expect(location).toEqual({
      directory: join(fixture.familyComponentsRoot, fixture.familyComponent),
      packageRoot: fixture.familyRoot,
      packageName: fixture.familyPackage,
      repositoryDirectory: `packages/fixture-family/src/components/${fixture.familyComponent}`,
    });
    expect(examplesDirectoryIn(source, fixture.familyComponent)).toBe(
      join(fixture.familyComponentsRoot, fixture.familyComponent, 'examples'),
    );
    expect(componentRoots(source)).toEqual(
      [fixture.coreComponentsRoot, fixture.familyComponentsRoot].toSorted(),
    );
  });

  test('links its source to the family package, and the core component to core', () => {
    const ids = new Set(['button', fixture.familyComponent]);
    const link = (componentName: string): string =>
      rewriteComponentReadmeLinks('<a href="./notes.md">notes</a>', componentName, ids, source);

    expect(link(fixture.familyComponent)).toContain(
      `href="https://github.com/stevekinney/cinder/blob/main/packages/fixture-family/src/components/${fixture.familyComponent}/notes.md"`,
    );
    expect(link('button')).toContain(
      'href="https://github.com/stevekinney/cinder/blob/main/packages/components/src/components/button/notes.md"',
    );
  });
});
