/**
 * The playground serves a family package's stylesheets through core's dependencies, with no edit
 * to the playground (COR-2083's playground half), and nothing outside the style packages' roots.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createFamilyFixture } from '@lostgradient/component-tooling/scripts/family-fixture.test-support.ts';

import {
  allowedStylesheetRoots,
  exportsStylesheets,
  packageStylesheetPath,
  readStylePackages,
  rewriteStylesheetPackageImports,
  stylePackages,
  stylesheetUrlFor,
} from './package-stylesheets.ts';

const fixture = createFamilyFixture();
afterAll(() => {
  rmSync(fixture.root, { recursive: true, force: true });
});

// The isolated linker links each of core's dependencies into core's own `node_modules`.
mkdirSync(join(fixture.coreRoot, 'node_modules', '@lostgradient'), { recursive: true });
symlinkSync(
  join('..', '..', '..', 'fixture-family'),
  join(fixture.coreRoot, 'node_modules', '@lostgradient', 'fixture-family'),
);
mkdirSync(join(fixture.coreRoot, 'src', 'styles'), { recursive: true });
const aggregator = join(fixture.coreRoot, 'src', 'styles', 'components.css');
writeFileSync(
  aggregator,
  [
    "@import '../components/button/button.css';",
    `@import '@lostgradient/fixture-family/components/${fixture.familyComponent}/${fixture.familyComponent}.css' layer(components);`,
    "@import url('@lostgradient/fixture-family/styles');",
    "@import '@lostgradient/absent/absent.css';",
    '',
  ].join('\n'),
);

const coreRoot = realpathSync(fixture.coreRoot);
const familyRoot = realpathSync(fixture.familyRoot);
const coreComponentsRoot = realpathSync(fixture.coreComponentsRoot);
const familyComponentsRoot = realpathSync(fixture.familyComponentsRoot);
const packages = readStylePackages(fixture.coreRoot, [fixture.coreComponentsRoot]);

describe('readStylePackages', () => {
  test("reads the family from core's dependencies, at its real directory", () => {
    expect(packages.core).toEqual({
      name: '@lostgradient/cinder',
      root: coreRoot,
      urlSegment: 'cinder',
    });
    expect(packages.dependencies).toEqual([
      { name: fixture.familyPackage, root: familyRoot, urlSegment: 'fixture-family' },
    ]);
    expect(allowedStylesheetRoots(packages)).toEqual([
      join(coreRoot, 'src', 'styles'),
      coreComponentsRoot,
      familyRoot,
    ]);
  });

  test('counts a package as a style package only when its exports name a stylesheet', () => {
    expect(
      exportsStylesheets({ '.': './src/index.ts', './styles': './src/styles/index.css' }),
    ).toBe(true);
    expect(exportsStylesheets({ './*.css': './src/*.css' })).toBe(true);
    expect(
      exportsStylesheets({ '.': { svelte: './src/index.ts', default: './src/index.ts' } }),
    ).toBe(false);
    expect(exportsStylesheets(undefined)).toBe(false);
  });

  test('finds no style dependency in the real core, which has extracted none yet', () => {
    expect(stylePackages().dependencies).toEqual([]);
  });
});

describe('stylesheetUrlFor', () => {
  test("keeps core's URLs and gives a family's files their own package prefix", () => {
    expect(stylesheetUrlFor(aggregator, packages)).toBe('/styles/components.css');
    expect(stylesheetUrlFor(join(coreComponentsRoot, 'button', 'button.css'), packages)).toBe(
      '/components/button/button.css',
    );
    // A family's own index.css can never shadow core's /styles/index.css.
    expect(stylesheetUrlFor(join(familyRoot, 'src', 'styles', 'index.css'), packages)).toBe(
      '/package-styles/fixture-family/src/styles/index.css',
    );
    expect(stylesheetUrlFor(join(fixture.root, 'package.json'), packages)).toBeNull();
  });
});

describe('rewriteStylesheetPackageImports', () => {
  test("rewrites each package specifier to the URL of the file the package's exports resolve to", async () => {
    const css = rewriteStylesheetPackageImports(
      await Bun.file(aggregator).text(),
      aggregator,
      packages,
    );
    expect(css.split('\n')).toEqual([
      "@import '../components/button/button.css';",
      `@import '/package-styles/fixture-family/src/components/${fixture.familyComponent}/${fixture.familyComponent}.css' layer(components);`,
      "@import url('/package-styles/fixture-family/src/styles/index.css');",
      // A specifier no package resolves is left as written, for the export to refuse.
      "@import '@lostgradient/absent/absent.css';",
      '',
    ]);
  });
});

describe("the playground's own dependencies", () => {
  // The playground reaches tokens, foundation and the families through core's dependencies, so it
  // keeps depending on `@lostgradient/cinder` alone among Cinder's packages (COR-2083).
  test('declare no family, tokens or foundation package', async () => {
    const families = (await Bun.file(
      join(import.meta.dir, '..', '..', '..', 'internal', 'component-tooling', 'families.json'),
    ).json()) as { packages: Record<string, { kind: string }> };
    const splitPackages = Object.entries(families.packages)
      .filter(([, entry]) => ['family', 'tokens', 'foundation'].includes(entry.kind))
      .map(([name]) => `@lostgradient/${name}`);
    const manifest = (await Bun.file(join(import.meta.dir, '..', 'package.json')).json()) as Record<
      string,
      Record<string, string> | undefined
    >;
    const declared = ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((field) =>
      Object.keys(manifest[field] ?? {}),
    );

    expect(splitPackages.length).toBeGreaterThan(100);
    expect(declared.filter((name) => splitPackages.includes(name))).toEqual([]);
  });
});

describe('packageStylesheetPath', () => {
  test("resolves a file inside the family's directory", () => {
    expect(
      packageStylesheetPath(
        'fixture-family',
        `src/components/${fixture.familyComponent}/${fixture.familyComponent}.css`,
        packages,
      ),
    ).toBe(join(familyComponentsRoot, fixture.familyComponent, `${fixture.familyComponent}.css`));
  });

  test('rejects a path outside every allowed root, and a package core does not depend on', () => {
    expect(
      packageStylesheetPath('fixture-family', '../core/src/styles/components.css', packages),
    ).toBeNull();
    expect(packageStylesheetPath('fixture-family', '/etc/passwd', packages)).toBeNull();
    expect(packageStylesheetPath('fixture-family', 'src/..\\..\\core/x.css', packages)).toBeNull();
    expect(packageStylesheetPath('cinder', 'src/styles/index.css', packages)).toBeNull();
    expect(packageStylesheetPath('absent', 'src/styles/index.css', packages)).toBeNull();
  });
});
