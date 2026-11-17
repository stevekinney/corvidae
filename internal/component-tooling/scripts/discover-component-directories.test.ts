import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CORE_ROOT,
  discoverComponentDirectories,
  familyPackages,
} from './discover-component-directories.ts';
import { createFamilyFixture, type FamilyFixture } from './family-fixture.test-support.ts';
import { componentSource } from './generate-manifest.ts';

let fixture: FamilyFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) rmSync(fixture.root, { recursive: true, force: true });
  fixture = undefined;
});

describe('discoverComponentDirectories', () => {
  test('lists the components in core and in each family package core depends on', async () => {
    fixture = createFamilyFixture();
    const components = await discoverComponentDirectories(fixture.coreRoot);

    expect(components).toEqual([
      {
        name: 'button',
        directory: join(fixture.coreRoot, 'src', 'components', 'button'),
        packageName: '@lostgradient/cinder',
        packageRoot: fixture.coreRoot,
      },
      {
        name: 'fixture-family',
        directory: join(fixture.familyRoot, 'src', 'components', 'fixture-family'),
        packageName: fixture.familyPackage,
        packageRoot: fixture.familyRoot,
      },
    ]);
    expect(familyPackages(fixture.coreRoot)).toEqual([[fixture.familyPackage, fixture.familyRoot]]);
  });

  test('records where each component lives, relative to core and to its own package', async () => {
    fixture = createFamilyFixture();
    const components = await discoverComponentDirectories(fixture.coreRoot);
    const sources = components.map((component) => componentSource(component, fixture?.coreRoot));

    expect(sources).toEqual([
      { package: '@lostgradient/cinder', packageRoot: '.', directory: 'src/components/button' },
      {
        package: '@lostgradient/fixture-family',
        packageRoot: '../fixture-family',
        directory: 'src/components/fixture-family',
      },
    ]);
  });

  test('stops when a component is in both core and a family', async () => {
    fixture = createFamilyFixture();
    const copy = join(fixture.familyRoot, 'src', 'components', 'button');
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, 'button.svelte'), '<button></button>\n');
    writeFileSync(join(copy, 'button.types.ts'), 'export {};\n');

    let message = '';
    try {
      await discoverComponentDirectories(fixture.coreRoot);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(
      'Component "button" is in both @lostgradient/cinder (' +
        join(fixture.coreRoot, 'src', 'components', 'button'),
    );
  });

  test('reads only core today, which depends on no family yet', async () => {
    const components = await discoverComponentDirectories();
    expect(familyPackages()).toEqual([]);
    expect(components.length).toBeGreaterThan(200);
    expect(new Set(components.map((component) => component.packageRoot))).toEqual(
      new Set([CORE_ROOT]),
    );
  });
});
