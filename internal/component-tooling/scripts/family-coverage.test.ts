/**
 * Every check that reads Cinder's components sees a family package's component (P-COR-101): a
 * check that passes because it sees nothing would turn itself off once the split moves the
 * components out of core. Each test builds a miniature repository whose core depends on one family
 * package, puts a file of the check's kind in the family, and asserts the check's file list holds
 * it. The generators, inventory, duplication, constraints and manifest read
 * `discoverComponentDirectories`, which the first test covers.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { componentCssFiles } from './check-aggregator-completeness.ts';
import { styleScanRoots } from './check-component-css-raw-colors.ts';
import { defaultScanRoots } from './check-component-css-token-usage.ts';
import { exampleComponentLocations } from './check-component-examples.ts';
import { tokenLiteralScanFiles } from './check-design-token-literals.ts';
import { consoleWarnScanFiles } from './check-no-bare-console-warn.ts';
import { matchMediaScanFiles } from './check-no-inline-match-media.ts';
import { staticStyleScanFiles } from './check-no-static-style-attributes.ts';
import { placeholderDocumentFiles } from './check-placeholder-docs.ts';
import { platformScanFiles } from './check-platform-features.ts';
import { componentNames, proseSourcePaths } from './check-prose-component-references.ts';
import { readmeComponents } from './check-readme-usage.ts';
import {
  cinderComponentRoots,
  cinderPackages,
  cinderSourceRoots,
  corePath,
  discoverComponentDirectories,
} from './discover-component-directories.ts';
import { createFamilyFixture } from './family-fixture.test-support.ts';

const fixture = createFamilyFixture();
afterAll(() => rmSync(fixture.root, { recursive: true, force: true }));

const familyDirectory = join(fixture.familyComponentsRoot, fixture.familyComponent);
const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
write(join(familyDirectory, 'README.md'), '# FixtureFamily\n\n## Usage\n');
write(join(familyDirectory, `${fixture.familyComponent}.a11y.md`), '# Accessibility\n');
write(join(familyDirectory, `${fixture.familyComponent}.meta.json`), '{}\n');
write(join(familyDirectory, `${fixture.familyComponent}.svelte`), '<div class="fixture"></div>\n');
write(join(fixture.familyRoot, 'src', 'utilities', 'probe.ts'), 'export const probe = 1;\n');

const familyCss = join(familyDirectory, `${fixture.familyComponent}.css`);
const familySvelte = join(familyDirectory, `${fixture.familyComponent}.svelte`);

describe('the shared discovery', () => {
  test('lists core and the family package core depends on', async () => {
    expect(cinderPackages(fixture.coreRoot)).toEqual([[fixture.familyPackage, fixture.familyRoot]]);
    expect(cinderComponentRoots(fixture.coreRoot)).toEqual([
      fixture.coreComponentsRoot,
      fixture.familyComponentsRoot,
    ]);
    expect(cinderSourceRoots(fixture.coreRoot)).toContain(join(fixture.familyRoot, 'src'));
    const discovered = await discoverComponentDirectories(fixture.coreRoot);
    expect(discovered.map(({ name }) => name)).toContain(fixture.familyComponent);
  });

  test('names a family file relative to core, as the baselines do', () => {
    expect(corePath(familyCss, fixture.coreRoot)).toBe(
      `../fixture-family/src/components/fixture-family/fixture-family.css`,
    );
  });
});

describe('each check sees the family package', () => {
  const componentRoots = () => cinderComponentRoots(fixture.coreRoot);
  const sourceRoots = () => cinderSourceRoots(fixture.coreRoot);

  test('component examples', async () => {
    const locations = await exampleComponentLocations(fixture.coreRoot);
    expect(locations.map(({ id }) => id)).toContain(fixture.familyComponent);
  });

  test('prose component references', async () => {
    expect(await componentNames(fixture.coreRoot)).toContain(fixture.familyComponent);
    expect(await proseSourcePaths(fixture.coreRoot)).toContain(
      corePath(join(familyDirectory, 'README.md'), fixture.coreRoot),
    );
  });

  test('README usage', () => {
    const ids = readmeComponents(componentRoots()).map(({ componentId }) => componentId);
    expect(ids).toContain(fixture.familyComponent);
  });

  test('placeholder docs', async () => {
    const files = await placeholderDocumentFiles(componentRoots());
    expect(files.map(([root, path]) => join(root, path))).toContain(
      join(familyDirectory, 'README.md'),
    );
  });

  test('bare console.warn', async () => {
    expect(await consoleWarnScanFiles(componentRoots())).toContain(familySvelte);
  });

  test('inline matchMedia', async () => {
    const files = await matchMediaScanFiles(sourceRoots());
    expect(files.map(({ absolutePath }) => absolutePath)).toContain(
      join(fixture.familyRoot, 'src', 'utilities', 'probe.ts'),
    );
  });

  test('static style attributes', async () => {
    expect(await staticStyleScanFiles(sourceRoots())).toContain(familySvelte);
  });

  test('raw colors, with the baseline name relative to core', () => {
    const roots = styleScanRoots(sourceRoots(), (path) => corePath(path, fixture.coreRoot));
    expect(roots).toContainEqual({
      dir: fixture.familyComponentsRoot,
      prefix: '../fixture-family/src/components',
    });
  });

  test('platform features', async () => {
    const files = await platformScanFiles(sourceRoots());
    expect(files.map(({ filePath }) => filePath)).toContain(familyCss);
  });

  test('design token literals', async () => {
    const files = await tokenLiteralScanFiles(componentRoots());
    expect(files.map(([root, path]) => join(root, path))).toContain(familyCss);
  });

  test('token usage, with the baseline name relative to core', () => {
    expect(defaultScanRoots(undefined, fixture.coreRoot)).toContainEqual({
      dir: fixture.familyComponentsRoot,
      reportPrefix: '../fixture-family/src/components',
      componentsPrefix: '../fixture-family/src/components',
    });
  });

  test('aggregator completeness', () => {
    const files = componentCssFiles(componentRoots()).map(([, path]) => path);
    expect(
      files.some((path) => path.endsWith(`/fixture-family/${fixture.familyComponent}.css`)),
    ).toBe(true);
  });
});
