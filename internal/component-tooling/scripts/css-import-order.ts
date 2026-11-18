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
 * reached. Bare specifiers (packages) are not followed.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import ts from 'typescript';

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

function resolveModule(specifier: string, from: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(from), specifier);
  return [base, `${base}.ts`, join(base, 'index.ts')].find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
}

/** The stylesheets evaluating `entry` reaches, in first-reached order, as absolute paths. */
export function cssImportOrder(entry: string): string[] {
  const order: string[] = [];
  const seenStylesheets = new Set<string>();
  const visited = new Set<string>();
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    for (const specifier of runtimeSpecifiers(file)) {
      if (specifier.endsWith('.css')) {
        const stylesheet = resolve(dirname(file), specifier);
        if (specifier.startsWith('.') && !seenStylesheets.has(stylesheet)) {
          seenStylesheets.add(stylesheet);
          order.push(stylesheet);
        }
        continue;
      }
      if (/\.(?:json|svg|md|txt)$/.test(specifier)) continue;
      const target = resolveModule(specifier, file);
      if (target !== undefined) visit(target);
    }
  };
  visit(resolve(entry));
  return order;
}

if (import.meta.main) {
  // The package is the working directory, as for every tooling command run from a package.
  const packageRoot = process.cwd();
  const entry = resolve(packageRoot, process.argv[2] ?? join('src', 'index.ts'));
  for (const stylesheet of cssImportOrder(entry)) {
    process.stdout.write(`${relative(packageRoot, stylesheet)}\n`);
  }
}
