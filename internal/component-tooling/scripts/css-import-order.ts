/**
 * The order in which importing a module evaluates the stylesheets in its static import graph.
 *
 * ```sh
 * bun scripts/css-import-order.ts [entry.ts]   # one stylesheet per line, package-relative
 * ```
 *
 * A consumer that imports `@lostgradient/cinder` (Interborough, the playground's bundles) gets each
 * component's CSS through that component's barrel, which runs `import './<name>.css'`. A bundler
 * emits those stylesheets in module evaluation order, so the order of the root barrel's exports is
 * the order of the component rules inside `@layer cinder.components`. `css-fingerprint.ts` only
 * flattens `@import` chains, so it cannot see this order; this walk can.
 *
 * The walk follows static `import` and `export … from` statements (not `import type`/`export type`,
 * which compile away) depth first, in source order, through `.ts`, `.svelte.ts` and `.svelte`
 * modules (a `.svelte` file's `<script>` blocks), and records each stylesheet the first time it is
 * reached. Bare specifiers (packages) are followed only into the Cinder packages core depends on
 * (P-COR-101 moved core's components and partials into them), and each stylesheet is printed with
 * the path core gave it, so the order reads the same before and after a package is extracted.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

import { CORE_ROOT, cinderPackages } from './discover-component-directories.ts';

function moduleSource(file: string): string {
  const text = readFileSync(file, 'utf8');
  if (!file.endsWith('.svelte')) return text;
  return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1] ?? '')
    .join('\n');
}

function runtimeSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, moduleSource(file), ts.ScriptTarget.Latest, false);
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.isTypeOnly === true) continue;
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const specifier = statement.moduleSpecifier;
      if (specifier !== undefined && ts.isStringLiteral(specifier)) specifiers.push(specifier.text);
    }
  }
  return specifiers;
}

/** The package a bare specifier names: `@scope/name` or `name`. */
function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

function resolveModule(
  specifier: string,
  from: string,
  followed: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith('.')) {
    // A package the split extracted from core holds what core's barrel held: follow it, through
    // its `exports`, to the source file in the repository.
    if (!followed.has(packageName(specifier))) return undefined;
    return realpathSync(Bun.resolveSync(specifier, dirname(from)));
  }
  const base = resolve(dirname(from), specifier);
  return [base, `${base}.ts`, join(base, 'index.ts')].find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
}

/**
 * The stylesheets evaluating `entry` reaches, in first-reached order, as absolute paths. Bare
 * specifiers are followed only into the packages `followed` names (by default, the Cinder packages
 * core depends on: tokens, foundation and the families).
 */
export function cssImportOrder(
  entry: string,
  followed: ReadonlySet<string> = new Set(cinderPackages(CORE_ROOT).map(([name]) => name)),
): string[] {
  const order: string[] = [];
  const seenStylesheets = new Set<string>();
  const visited = new Set<string>();
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    for (const specifier of runtimeSpecifiers(file)) {
      if (specifier.endsWith('.css')) {
        const stylesheet = specifier.startsWith('.')
          ? resolve(dirname(file), specifier)
          : resolveModule(specifier, file, followed);
        if (stylesheet !== undefined && !seenStylesheets.has(stylesheet)) {
          seenStylesheets.add(stylesheet);
          order.push(stylesheet);
        }
        continue;
      }
      if (/\.(?:json|svg|md|txt)$/.test(specifier)) continue;
      const target = resolveModule(specifier, file, followed);
      if (target !== undefined) visit(target);
    }
  };
  visit(resolve(entry));
  return order;
}

/**
 * A stylesheet's path as core named it before the split: `src/…` relative to core, also for a
 * stylesheet a Cinder package now holds, since each keeps core's layout under its own `src`.
 */
export function corePackagePath(stylesheet: string, coreRoot: string = CORE_ROOT): string {
  for (const [, packageRoot] of cinderPackages(coreRoot)) {
    const inside = relative(packageRoot, stylesheet);
    if (!inside.startsWith('..')) return inside.split(sep).join('/');
  }
  return relative(coreRoot, stylesheet).split(sep).join('/');
}

if (import.meta.main) {
  const entry = process.argv[2] ?? join(CORE_ROOT, 'src', 'index.ts');
  for (const stylesheet of cssImportOrder(entry)) {
    process.stdout.write(`${corePackagePath(stylesheet)}\n`);
  }
}
