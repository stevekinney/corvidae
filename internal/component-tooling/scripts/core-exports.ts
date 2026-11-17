/**
 * Where each name core's barrel exports comes from (P-COR-101 item 4). Every Cinder example imports
 * `{ Button, … }` from `@lostgradient/cinder`; inside a family package that is an import of core,
 * which depends on the family. `derive-families.ts` reads such an import as a need for the
 * packages that hold the names, and `extract-families.ts` rewrites it to import each name from
 * its package. Both read modules through a {@link ModuleReader}, so this works on the tree before
 * and after the split.
 */

import ts from 'typescript';

/** Reads a module by the path a resolver names it with, or undefined when it cannot. */
export type ModuleReader = {
  read: (file: string) => string | undefined;
  resolve: (from: string, specifier: string) => string | undefined;
};

/** One name core's barrel exports: the statement's first module and the module that defines it. */
export type ExportTarget = {
  /** The specifier core's barrel names the name's statement with. */
  firstSpecifier: string;
  /** The module that specifier names. */
  firstModule: string | undefined;
  /** The module that defines the name, after every re-export. */
  file: string;
  /** The name that module exports it as (`default` for a component's entry). */
  imported: string;
};

function exportDeclarations(file: string, source: string): ts.ExportDeclaration[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  return parsed.statements.filter(ts.isExportDeclaration);
}

function hasModifier(statement: ts.Statement, kind: ts.SyntaxKind): boolean {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
  return modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function declaredNames(statement: ts.Statement): string[] {
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return [];
  if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) return ['default'];
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  }
  const named =
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement);
  return named && statement.name !== undefined ? [statement.name.text] : [];
}

/** The names a module exports, following its `export *` statements. */
export function moduleExportNames(
  file: string,
  reader: ModuleReader,
  seen = new Set<string>(),
): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const source = reader.read(file);
  if (source === undefined) return [];
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  const names: string[] = [];
  for (const statement of parsed.statements) {
    if (!ts.isExportDeclaration(statement)) {
      names.push(...declaredNames(statement));
      continue;
    }
    const clause = statement.exportClause;
    if (clause !== undefined) {
      names.push(
        ...(ts.isNamedExports(clause)
          ? clause.elements.map((element) => element.name.text)
          : [clause.name.text]),
      );
      continue;
    }
    const specifier = statement.moduleSpecifier;
    const target =
      specifier !== undefined && ts.isStringLiteral(specifier)
        ? reader.resolve(file, specifier.text)
        : undefined;
    if (target !== undefined) names.push(...moduleExportNames(target, reader, seen));
  }
  return names;
}

/** The module that defines `name` as `file` exports it, following re-exports (`export … from`). */
function followExport(
  file: string,
  name: string,
  reader: ModuleReader,
  depth = 0,
): { file: string; imported: string } {
  const source = reader.read(file);
  if (source === undefined || depth > 12) return { file, imported: name };
  for (const statement of exportDeclarations(file, source)) {
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
    const clause = statement.exportClause;
    if (clause !== undefined && ts.isNamedExports(clause)) {
      const element = clause.elements.find((candidate) => candidate.name.text === name);
      if (element === undefined) continue;
      const target = reader.resolve(file, specifier.text);
      if (target === undefined) return { file, imported: name };
      const local = element.propertyName?.text ?? element.name.text;
      return followExport(target, local, reader, depth + 1);
    }
    if (clause === undefined) {
      const target = reader.resolve(file, specifier.text);
      if (target !== undefined && moduleExportNames(target, reader).includes(name)) {
        return followExport(target, name, reader, depth + 1);
      }
    }
  }
  return { file, imported: name };
}

/** Where each name core's barrel (`entry`) exports comes from. */
export function coreExportTargets(entry: string, reader: ModuleReader): Map<string, ExportTarget> {
  const targets = new Map<string, ExportTarget>();
  const source = reader.read(entry);
  if (source === undefined) return targets;
  for (const statement of exportDeclarations(entry, source)) {
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
    const firstModule = reader.resolve(entry, specifier.text);
    const clause = statement.exportClause;
    let names: [string, string][] = [];
    if (clause !== undefined && ts.isNamedExports(clause)) {
      names = clause.elements.map((element) => [
        element.name.text,
        element.propertyName?.text ?? element.name.text,
      ]);
    } else if (firstModule !== undefined) {
      names = moduleExportNames(firstModule, reader).map((name) => [name, name]);
    }
    for (const [exported, local] of names) {
      if (targets.has(exported)) continue;
      const defined =
        firstModule === undefined
          ? { file: entry, imported: exported }
          : followExport(firstModule, local, reader);
      targets.set(exported, { firstSpecifier: specifier.text, firstModule, ...defined });
    }
  }
  return targets;
}

/** One `import { … } from '@lostgradient/cinder'` statement. */
export type CoreNamedImport = {
  start: number;
  end: number;
  typeOnly: boolean;
  /** Each element: the exported name, the local alias, and whether it imports a type only. */
  elements: { name: string; local: string; typeOnly: boolean }[];
};

const CORE_NAMED_IMPORT =
  /import\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"])@lostgradient\/cinder\3\s*;?/g;

/** Every named import of core's barrel in a module's text. */
export function coreNamedImports(text: string): CoreNamedImport[] {
  return [...text.matchAll(CORE_NAMED_IMPORT)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    typeOnly: match[1] !== undefined,
    elements: (match[2] ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .map((part) => {
        const typeOnly = part.startsWith('type ');
        const [name = '', local] = part.replace(/^type\s+/, '').split(/\s+as\s+/);
        return { name, local: local ?? name, typeOnly };
      }),
  }));
}

/** How many times a module's text names core's barrel at all. */
export function coreBarrelMentions(specifiers: readonly string[]): number {
  return specifiers.filter((specifier) => specifier === '@lostgradient/cinder').length;
}
