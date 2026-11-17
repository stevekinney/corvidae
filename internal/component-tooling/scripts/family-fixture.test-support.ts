/**
 * A miniature repository whose core depends on one family package (COR-2085), for the tests that
 * prove discovery and serving read family packages without other edits.
 *
 * `components/core` is named `@lostgradient/cinder` and holds `button`; `components/fixture-family`
 * is a package `create-package.ts` scaffolds, which core lists among its dependencies, and holds
 * `fixture-family` with a stylesheet and one example.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createPackage } from './create-package.ts';

export type FamilyFixture = {
  /** The miniature repository's root. */
  root: string;
  /** Core's directory, `components/core`. */
  coreRoot: string;
  /** The family's directory, `components/fixture-family`. */
  familyRoot: string;
  /** The family's package name. */
  familyPackage: string;
  /** The family's one component. */
  familyComponent: string;
  /** Core's components root, `components/core/src/components`. */
  coreComponentsRoot: string;
  /** The family's components root, `components/fixture-family/src/components`. */
  familyComponentsRoot: string;
};

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Write the miniature repository under a new temporary directory; the caller removes `root`. */
export function createFamilyFixture(): FamilyFixture {
  const root = mkdtempSync(join(tmpdir(), 'component-family-fixture-'));
  write(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fixture-root', private: true, workspaces: ['components/*'] }, null, 2)}\n`,
  );
  const coreRoot = join(root, 'components', 'core');
  write(
    join(coreRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: '@lostgradient/cinder',
        private: true,
        type: 'module',
        dependencies: { '@lostgradient/fixture-family': 'workspace:*', svelte: 'catalog:' },
      },
      null,
      2,
    )}\n`,
  );
  write(join(coreRoot, 'src', 'components', 'button', 'button.svelte'), '<button></button>\n');
  write(join(coreRoot, 'src', 'components', 'button', 'button.types.ts'), 'export {};\n');
  write(join(coreRoot, 'src', 'components', 'button', 'button.css'), '.cinder-button {}\n');

  createPackage(root, 'fixture-family');
  const familyRoot = join(root, 'components', 'fixture-family');
  const componentDirectory = join(familyRoot, 'src', 'components', 'fixture-family');
  write(join(componentDirectory, 'fixture-family.types.ts'), 'export {};\n');
  write(join(componentDirectory, 'fixture-family.css'), '.cinder-fixture-family {}\n');
  write(
    join(componentDirectory, 'examples', 'basic.example.svelte'),
    '<script lang="ts">\n  export const title = \'Basic\';\n</script>\n',
  );
  return {
    root,
    coreRoot,
    familyRoot,
    familyPackage: '@lostgradient/fixture-family',
    familyComponent: 'fixture-family',
    coreComponentsRoot: join(coreRoot, 'src', 'components'),
    familyComponentsRoot: join(familyRoot, 'src', 'components'),
  };
}
