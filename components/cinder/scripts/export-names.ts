/**
 * The sorted export names of a TypeScript barrel.
 *
 * ```sh
 * bun scripts/export-names.ts src/index.ts          # one name per line, sorted
 * ```
 *
 * The names are read from the syntax, so no type resolution is needed and a `.svelte` re-export
 * counts by the name it gives. A relative `export * from './leaf.ts'` is followed into that file;
 * a specifier that does not resolve to a TypeScript file contributes nothing. Types and values
 * share one list, and `default` appears when a module exports one. Diff the output before and after
 * a change to see exactly which names it added or removed.
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

function declaredNames(statement: ts.Statement): string[] {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
  if (modifiers?.some((modifier) => modifier.kind === EXPORT_MODIFIER) !== true) return [];
  if (modifiers.some((modifier) => modifier.kind === DEFAULT_MODIFIER)) return ['default'];
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  }
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  ) {
    return statement.name === undefined ? [] : [statement.name.text];
  }
  return [];
}

function collectNames(file: string, seen: Set<string>, names: Set<string>): void {
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
      names.add('default');
    } else if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause === undefined) {
        const specifier = statement.moduleSpecifier;
        const target =
          specifier !== undefined && ts.isStringLiteral(specifier)
            ? resolveModule(specifier.text, file)
            : undefined;
        if (target !== undefined) collectNames(target, seen, names);
      } else if (ts.isNamespaceExport(clause)) {
        names.add(clause.name.text);
      } else {
        for (const element of clause.elements) names.add(element.name.text);
      }
    } else {
      for (const name of declaredNames(statement)) names.add(name);
    }
  }
}

/** The sorted, de-duplicated export names of `entry`. */
export function exportNames(entry: string): string[] {
  const names = new Set<string>();
  collectNames(resolve(entry), new Set(), names);
  return [...names].toSorted();
}

if (import.meta.main) {
  const entry = process.argv[2];
  if (entry === undefined) {
    process.stderr.write('Usage: bun scripts/export-names.ts <entry.ts>\n');
    process.exit(1);
  }
  process.stdout.write(`${exportNames(entry).join('\n')}\n`);
}
