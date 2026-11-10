/**
 * The sorted export names of a TypeScript barrel.
 *
 * ```sh
 * bun scripts/export-names.ts src/index.ts          # a `runtime` list, then a `types` list
 * ```
 *
 * Each list is one name per line, sorted, under a `# runtime` or `# types` heading. The names are
 * read from the syntax, so no type resolution is needed and a `.svelte` re-export counts by the
 * name it gives. A relative `export * from './leaf.ts'` is followed into that file; a specifier
 * that does not resolve to a TypeScript file contributes nothing. An interface, a type alias, an
 * `export type { … }` clause, or an `export { type X }` element is a type; every other export is
 * runtime, and `default` appears when a module exports one. A name exported both ways (a class and
 * a merged interface) is runtime. Diff the output before and after a change to see exactly which
 * names it added or removed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import ts from 'typescript';

const EXPORT_MODIFIER = ts.SyntaxKind.ExportKeyword;
const DEFAULT_MODIFIER = ts.SyntaxKind.DefaultKeyword;

function resolveModule(specifier: string, fromFile: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const candidate = resolve(dirname(fromFile), specifier);
  for (const path of [candidate, `${candidate}.ts`, resolve(candidate, 'index.ts')]) {
    if (path.endsWith('.ts') && existsSync(path)) return path;
  }
  return undefined;
}

/** The sorted export names of a module, split by whether they exist at runtime. */
export type ExportNames = { runtime: string[]; types: string[] };

type Collected = { runtime: Set<string>; types: Set<string> };

function declaredNames(statement: ts.Statement): { name: string; type: boolean }[] {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
  if (modifiers?.some((modifier) => modifier.kind === EXPORT_MODIFIER) !== true) return [];
  if (modifiers.some((modifier) => modifier.kind === DEFAULT_MODIFIER)) {
    return [{ name: 'default', type: ts.isInterfaceDeclaration(statement) }];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [{ name: declaration.name.text, type: false }] : [],
    );
  }
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
    return [{ name: statement.name.text, type: true }];
  }
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  ) {
    return statement.name === undefined ? [] : [{ name: statement.name.text, type: false }];
  }
  return [];
}

function collectNames(file: string, seen: Set<string>, names: Collected, typesOnly = false): void {
  if (seen.has(file)) return;
  seen.add(file);
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      (typesOnly ? names.types : names.runtime).add('default');
    } else if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause === undefined) {
        const specifier = statement.moduleSpecifier;
        const target =
          specifier !== undefined && ts.isStringLiteral(specifier)
            ? resolveModule(specifier.text, file)
            : undefined;
        if (target !== undefined)
          collectNames(target, seen, names, typesOnly || statement.isTypeOnly);
      } else if (ts.isNamespaceExport(clause)) {
        (typesOnly || statement.isTypeOnly ? names.types : names.runtime).add(clause.name.text);
      } else {
        for (const element of clause.elements) {
          const type = typesOnly || statement.isTypeOnly || element.isTypeOnly;
          (type ? names.types : names.runtime).add(element.name.text);
        }
      }
    } else {
      for (const { name, type } of declaredNames(statement)) {
        (type || typesOnly ? names.types : names.runtime).add(name);
      }
    }
  }
}

/** The sorted, de-duplicated runtime and type export names of `entry`. */
export function exportNames(entry: string): ExportNames {
  const names: Collected = { runtime: new Set(), types: new Set() };
  collectNames(resolve(entry), new Set(), names);
  return {
    runtime: [...names.runtime].toSorted(),
    types: [...names.types].filter((name) => !names.runtime.has(name)).toSorted(),
  };
}

/** The text the command prints: a `# runtime` list, then a `# types` list. */
export function formatExportNames({ runtime, types }: ExportNames): string {
  return ['# runtime', ...runtime, '# types', ...types].join('\n') + '\n';
}

if (import.meta.main) {
  const entry = process.argv[2];
  if (entry === undefined) {
    process.stderr.write('Usage: bun scripts/export-names.ts <entry.ts>\n');
    process.exit(1);
  }
  process.stdout.write(formatExportNames(exportNames(entry)));
}
