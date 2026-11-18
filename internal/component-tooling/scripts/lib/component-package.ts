/**
 * One component package the component generators run on: cinder, chat, editor or terminal.
 *
 * The generators default to cinder; `--package-root <dir>` on `generate-component-artifacts.ts`
 * runs them on another package, whose name comes from its `package.json` and whose components live
 * in `src/lib/components/`.
 */

import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { CINDER_PACKAGE_ROOT, componentsRootOf } from '../discover-component-directories.ts';

export type ComponentPackage = {
  /** Absolute package root. */
  root: string;
  /** The package name, which is also the import specifier its components ship under. */
  name: string;
  /** Absolute directory holding the component directories. */
  componentsRoot: string;
  /** Cinder alone has a root barrel, a CSS aggregator, constraints and an a2ui catalog. */
  isCinder: boolean;
};

export function componentPackage(root: string = CINDER_PACKAGE_ROOT): ComponentPackage {
  const absolute = resolve(root);
  const manifest: unknown = JSON.parse(readFileSync(join(absolute, 'package.json'), 'utf8'));
  const name =
    typeof manifest === 'object' && manifest !== null && 'name' in manifest
      ? String(manifest.name)
      : '';
  if (!name.startsWith('@lostgradient/')) {
    throw new Error(`${absolute}/package.json does not name a @lostgradient package`);
  }
  return {
    root: absolute,
    name,
    componentsRoot: componentsRootOf(absolute),
    isCinder: absolute === resolve(CINDER_PACKAGE_ROOT),
  };
}

/** A path inside the package, relative to its root, with forward slashes. */
export function packageRelative(pkg: ComponentPackage, path: string): string {
  return relative(pkg.root, path).split('\\').join('/');
}
