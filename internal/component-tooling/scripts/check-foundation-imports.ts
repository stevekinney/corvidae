/**
 * Foundation imports no family (COR-2084). Every family depends on foundation, so a foundation
 * module that imports a family's would make the package graph cycle.
 *
 * ```sh
 * bun ../../internal/component-tooling/scripts/check-foundation-imports.ts   # from components/foundation
 * ```
 *
 * It reads every source file under the package's `src` and fails, naming each import, when one
 * names a family `families.json` lists: by package specifier (`@lostgradient/<family>`), or by a
 * relative path into a family's component directory (`src/components/<component>/…`) or out of the
 * package into another family's workspace (`components/<family>/…`).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, posix, relative, resolve } from 'node:path';

import { FAMILIES_PATH, type DerivedFamilies } from './derive-families.ts';
import { joinVirtual, PACKAGE_SCOPE } from './split-layout.ts';

const SOURCE_FILE = /\.(?:ts|js|svelte|css)$/;
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|@import\s+(?:url\(\s*)?)(['"])([^'"\n]+)\1/g;

/**
 * Each import in `files` (virtual paths under `src`, relative to the package root `packageRoot`,
 * itself `components/<name>`) that names one of `families`' families.
 */
export function foundationImportViolations(
  files: ReadonlyMap<string, string>,
  families: DerivedFamilies,
  packageRoot = 'components/foundation',
): string[] {
  const familyOfComponent = new Map<string, string>();
  const familyNames = new Set<string>();
  for (const [name, entry] of Object.entries(families.packages)) {
    if (entry.kind !== 'family') continue;
    familyNames.add(name);
    for (const component of entry.components) familyOfComponent.set(component, name);
  }
  const violations: string[] = [];
  for (const [path, content] of files) {
    if (!SOURCE_FILE.test(path)) continue;
    for (const match of content.matchAll(SPECIFIER)) {
      const specifier = match[2] ?? '';
      let family: string | undefined;
      if (specifier.startsWith(PACKAGE_SCOPE)) {
        const name = specifier.slice(PACKAGE_SCOPE.length).split('/')[0] ?? '';
        if (familyNames.has(name)) family = name;
      } else if (specifier.startsWith('.')) {
        const target = joinVirtual(path, specifier);
        const component = /^src\/components\/([^/]+)\//.exec(target)?.[1];
        if (component !== undefined) family = familyOfComponent.get(component);
        const outside = posix.normalize(posix.join(packageRoot, target));
        const workspace = /^components\/([^/]+)\//.exec(outside)?.[1];
        if (workspace !== undefined && familyNames.has(workspace)) family = workspace;
      }
      if (family !== undefined) {
        violations.push(`${path} imports ${specifier}, which is the family "${family}".`);
      }
    }
  }
  return violations;
}

function readSources(packageRoot: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (directory: string) => {
    for (const entry of readdirSync(join(packageRoot, directory), { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const path = posix.join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (SOURCE_FILE.test(entry.name)) {
        files.set(path, readFileSync(join(packageRoot, path), 'utf8'));
      }
    }
  };
  if (existsSync(join(packageRoot, 'src'))) walk('src');
  return files;
}

if (import.meta.main) {
  const packageRoot = resolve(process.argv[2] ?? process.cwd());
  const families = JSON.parse(readFileSync(FAMILIES_PATH, 'utf8')) as DerivedFamilies;
  const repositoryRoot = resolve(import.meta.dir, '../../..');
  const violations = foundationImportViolations(
    readSources(packageRoot),
    families,
    relative(repositoryRoot, packageRoot) || basename(packageRoot),
  );
  for (const violation of violations) process.stderr.write(`${violation}\n`);
  if (violations.length > 0) {
    process.stderr.write(
      `check-foundation-imports: foundation imports ${violations.length} family module(s); move the module to the family, or what it needs into foundation.\n`,
    );
    process.exit(1);
  }
}
