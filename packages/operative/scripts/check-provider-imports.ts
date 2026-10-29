/**
 * Fails when Operative's source blurs the line between provider-neutral code and provider code.
 *
 * Each model provider (Anthropic, OpenAI, Gemini) lives in its own package, and the move of each
 * changed only imports, which is true only while the code respects the boundary. This check
 * classifies every file by path and reads every import to prove it does, and it fails when a
 * provider-owned path reappears in Operative.
 *
 * Ownership is decided by path, under `packages/operative/`, for provider `<p>`:
 *
 * - `src/<p>.ts`
 * - `src/providers/<p>.ts` and `src/providers/<p>-*.ts`
 * - `src/providers/{batches,embeddings}/<p>.ts`
 * - `src/providers/streaming/normalize-<p>.ts`
 * - `src/providers/test/<p>-*.ts`
 * - `test/<p>/**`
 *
 * `src/index.ts` and every `index.ts` under `src/providers/` are barrels: they only re-export, and a
 * barrel may re-export a provider file until that provider moves. Every other file is neutral.
 *
 * It exits 1 when:
 *
 * 0. a provider-owned path exists in the package at all (every provider has moved out, so a file
 *    at `src/<p>.ts`, `src/providers/<p>-*.ts`, `test/<p>/**`, or any other path above is a copy
 *    that has drifted back; the rule reads every file under `src/` and `test/`, not only `.ts`);
 * 1. a neutral file that is not a barrel imports a provider file (a re-export is an import too);
 * 2. one provider's file imports another provider's file;
 * 3. a provider file imports a symbol by name from a neutral module that the file could not reach
 *    after the move. A provider source file may reach only what `src/provider-kit.ts` exports. A
 *    provider-owned test or test-support file may reach what one of the entries a provider
 *    package's tests may import exports: `src/index.ts` (the root), `provider-kit`,
 *    `provider-testing`, and `decision-testing`. The check is symbol-level, not module-level.
 *
 * It reads every `import`, `import type`, `export … from`, `export * from`, `import x = require()`,
 * and dynamic `import()` whose specifier is a string literal, written with or without an extension.
 * A namespace import, a star re-export, or a whole-module dynamic import of a neutral module from
 * a provider file cannot be checked by name and fails for the same reason.
 *
 * It reads all of `src/` and `test/`, tests and test support included.
 *
 * A name imported through a re-export is judged by the file that declares it, so a neutral file
 * cannot reach a provider symbol by importing it from a barrel (or any other re-exporting module).
 * Rules 1 and 2 follow `export … from` chains, renames, and `export *` to the declaring file; a
 * whole-module import of a barrel that re-exports a provider-owned symbol fails too, except for the
 * package root `src/index.ts`, whose namespace is the public surface and may be read whole.
 *
 * Run from the Operative directory, as `lint` does. `--root <directory>` points the check at
 * another copy of the package, which is how a seeded violation is shown to fail.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

/** The model providers whose files are owned by path. */
export const PROVIDERS = ['anthropic', 'openai', 'gemini'] as const;

/** One of the model providers whose files are owned by path. */
export type Provider = (typeof PROVIDERS)[number];

/** Who owns a file: a barrel, one provider, or nobody (provider-neutral). */
export type Ownership =
  { kind: 'barrel' } | { kind: 'neutral' } | { kind: 'provider'; provider: Provider };

/** The package-relative entry files a provider-owned test may import, once they exist. */
export const PROVIDER_TEST_ENTRY_FILES = [
  'src/index.ts',
  'src/provider-kit.ts',
  'src/provider-testing.ts',
  'src/decision-testing.ts',
] as const;

/** The package-relative entry file a provider source file may import neutral symbols from. */
export const PROVIDER_SOURCE_ENTRY_FILES = ['src/provider-kit.ts'] as const;

const TEST_FILE = /\.(test|test-d|test-support)\.ts$/;

/**
 * Whether a package-relative path is a test file or test support.
 *
 * @param path - The path relative to the package directory, with forward slashes.
 */
export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path) || path.startsWith('src/providers/test/') || path.startsWith('test/');
}

/**
 * Classifies a package-relative path by the file-ownership rules.
 *
 * @param path - The path relative to the package directory, with forward slashes.
 */
export function classifyFile(path: string): Ownership {
  if (path === 'src/index.ts') {
    return { kind: 'barrel' };
  }
  if (path.startsWith('src/providers/') && path.endsWith('/index.ts')) {
    return { kind: 'barrel' };
  }
  if (path === 'src/providers/index.ts') {
    return { kind: 'barrel' };
  }
  for (const provider of PROVIDERS) {
    const name = escapeForPattern(provider);
    const owned = [
      new RegExp(`^src/${name}\\.ts$`),
      new RegExp(`^src/providers/${name}(-[^/]*)?\\.(test|test-d)\\.ts$`),
      new RegExp(`^src/providers/${name}(-[^/]*)?\\.ts$`),
      new RegExp(`^src/providers/(batches|embeddings)/${name}\\.ts$`),
      new RegExp(`^src/providers/streaming/normalize-${name}\\.ts$`),
      new RegExp(`^src/providers/test/${name}-[^/]*\\.ts$`),
      new RegExp(`^test/${name}/`),
    ];
    if (owned.some((pattern) => pattern.test(path))) {
      return { kind: 'provider', provider };
    }
  }
  return { kind: 'neutral' };
}

/**
 * Lists the provider-owned paths among a package's files. Every provider has moved to its own
 * package, so any such path in Operative is a copy that has drifted back.
 *
 * @param paths - The paths relative to the package directory, with forward slashes.
 */
export function findProviderOwnedPaths(paths: Iterable<string>): Violation[] {
  const violations: Violation[] = [];
  for (const path of [...paths].toSorted((left, right) => left.localeCompare(right))) {
    const owner = classifyFile(path);
    if (owner.kind === 'provider') {
      violations.push({
        file: path,
        line: 1,
        message: `${owner.provider}-owned path exists in Operative; ${owner.provider} lives in @lostgradient/operative-${owner.provider}`,
      });
    }
  }
  return violations;
}

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One import-like reference found in a file. */
export interface ImportReference {
  /** The specifier exactly as written. */
  specifier: string;
  /** The 1-based line of the reference. */
  line: number;
  /** The imported names, with `default` for a default import. */
  names: string[];
  /** True when the reference names the whole module (namespace import, star re-export, dynamic import, `require`). */
  wholeModule: boolean;
}

/**
 * Reads every import-like reference with a string-literal specifier from a source text.
 *
 * @param fileName - The file name, used only for the parser's script kind.
 * @param source - The file's text.
 */
export function readImportReferences(fileName: string, source: string): ImportReference[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const references: ImportReference[] = [];
  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names: string[] = [];
      let wholeModule = false;
      if (clause?.name) {
        names.push('default');
      }
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        wholeModule = true;
      } else if (bindings) {
        for (const element of bindings.elements) {
          names.push((element.propertyName ?? element.name).text);
        }
      }
      references.push({
        specifier: node.moduleSpecifier.text,
        line: lineOf(node),
        names,
        wholeModule,
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const exported = node.exportClause;
      const names =
        exported && ts.isNamedExports(exported)
          ? exported.elements.map((element) => (element.propertyName ?? element.name).text)
          : [];
      const wholeModule = !exported || ts.isNamespaceExport(exported);
      references.push({
        specifier: node.moduleSpecifier.text,
        line: lineOf(node),
        names,
        wholeModule,
      });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      references.push({
        specifier: node.moduleReference.expression.text,
        line: lineOf(node),
        names: [],
        wholeModule: true,
      });
    } else if (
      ts.isCallExpression(node) &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      references.push({
        specifier: node.arguments[0].text,
        line: lineOf(node),
        names: [],
        wholeModule: true,
      });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      references.push({
        specifier: node.argument.literal.text,
        line: lineOf(node),
        names: node.qualifier ? [firstQualifier(node.qualifier)] : [],
        wholeModule: node.qualifier === undefined,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

function firstQualifier(name: ts.EntityName): string {
  let current: ts.EntityName = name;
  while (ts.isQualifiedName(current)) {
    current = current.left;
  }
  return current.text;
}

/**
 * The package's own entry points by specifier, so `import … from '@lostgradient/operative/x'` is
 * read like the file it names. A test pins this to the `exports` field of `package.json`.
 */
export const SELF_ENTRY_POINTS: Readonly<Record<string, string>> = {
  '@lostgradient/operative': 'src/index.ts',
  '@lostgradient/operative/provider-kit': 'src/provider-kit.ts',
  '@lostgradient/operative/provider-testing': 'src/provider-testing.ts',
  '@lostgradient/operative/run-engine-workflow-types': 'src/durable/run-engine-workflow-types.ts',
};

/** The source files of a package, keyed by package-relative path. */
export type SourceFiles = ReadonlyMap<string, string>;

/**
 * Resolves a relative specifier, or one of the package's own entry-point specifiers, to a
 * package-relative file path, if it names a file in `files`.
 *
 * @param fromPath - The importing file's package-relative path.
 * @param specifier - The specifier as written.
 * @param files - The files that exist.
 */
export function resolveSpecifier(
  fromPath: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith('.')) {
    const entry = Object.hasOwn(SELF_ENTRY_POINTS, specifier)
      ? SELF_ENTRY_POINTS[specifier]
      : undefined;
    return entry !== undefined && files.has(entry) ? entry : undefined;
  }
  const base = join(dirname(fromPath), specifier).split(sep).join('/');
  const withoutExtension = base.replace(/\.(ts|js|mts|mjs)$/, '');
  const candidates = [
    base,
    `${withoutExtension}.ts`,
    `${base}.ts`,
    `${base}/index.ts`,
    `${withoutExtension}/index.ts`,
  ];
  return candidates.find((candidate) => files.has(candidate));
}

/**
 * Reads the names an entry file exports, following relative `export … from` chains.
 *
 * @param entryPath - The entry file's package-relative path.
 * @param files - The files that exist and their text.
 */
export function readExportedNames(entryPath: string, files: SourceFiles): Set<string> {
  const names = new Set<string>();
  const known = new Set(files.keys());
  const visited = new Set<string>();
  const walk = (path: string): void => {
    if (visited.has(path)) {
      return;
    }
    visited.add(path);
    const source = files.get(path);
    if (source === undefined) {
      return;
    }
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    for (const statement of sourceFile.statements) {
      if (ts.isExportDeclaration(statement)) {
        const clause = statement.exportClause;
        if (clause && ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            names.add(element.name.text);
          }
        } else if (clause && ts.isNamespaceExport(clause)) {
          names.add(clause.name.text);
        } else if (
          !clause &&
          statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          const target = resolveSpecifier(path, statement.moduleSpecifier.text, known);
          if (target) {
            walk(target);
          }
        }
      } else if (ts.isExportAssignment(statement)) {
        names.add('default');
      } else if (
        ts.canHaveModifiers(statement) &&
        ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        const isDefault = ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
        if (isDefault) {
          names.add('default');
        } else if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            collectBindingNames(declaration.name, names);
          }
        } else if ('name' in statement && statement.name && ts.isIdentifier(statement.name)) {
          names.add(statement.name.text);
        }
      }
    }
  };
  walk(entryPath);
  return names;
}

function collectBindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      collectBindingNames(element.name, into);
    }
  }
}

function declaresLocally(sourceFile: ts.SourceFile, wanted: string): boolean {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier === undefined && statement.exportClause) {
        if (ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            names.add(element.name.text);
          }
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      names.add('default');
    } else if (
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          collectBindingNames(declaration.name, names);
        }
      } else if ('name' in statement && statement.name && ts.isIdentifier(statement.name)) {
        names.add(statement.name.text);
      }
    }
  }
  return names.has(wanted);
}

/**
 * Finds the file that declares a name an entry file exports, following `export … from` chains,
 * renames, and `export *`. A name that is not re-exported from anywhere is declared in the file
 * itself, and so is a name nothing resolves, which keeps an unresolved chain from inventing a
 * violation.
 *
 * @param path - The file the name is imported from.
 * @param name - The imported name.
 * @param files - The files that exist and their text.
 */
export function resolveDeclaringFile(path: string, name: string, files: SourceFiles): string {
  const known = new Set(files.keys());
  const visited = new Set<string>();
  const find = (current: string, wanted: string): string | undefined => {
    const key = `${current}\0${wanted}`;
    if (visited.has(key)) {
      return undefined;
    }
    visited.add(key);
    const source = files.get(current);
    if (source === undefined) {
      return undefined;
    }
    const sourceFile = ts.createSourceFile(current, source, ts.ScriptTarget.Latest, true);
    const stars: string[] = [];
    for (const statement of sourceFile.statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        statement.moduleSpecifier === undefined ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const target = resolveSpecifier(current, statement.moduleSpecifier.text, known);
      const clause = statement.exportClause;
      if (clause === undefined) {
        if (target !== undefined) {
          stars.push(target);
        }
      } else if (ts.isNamespaceExport(clause)) {
        if (clause.name.text === wanted) {
          return target ?? current;
        }
      } else {
        for (const element of clause.elements) {
          if (element.name.text === wanted) {
            return target === undefined
              ? current
              : (find(target, (element.propertyName ?? element.name).text) ?? target);
          }
        }
      }
    }
    if (declaresLocally(sourceFile, wanted)) {
      return current;
    }
    for (const star of stars) {
      const found = find(star, wanted);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  return find(path, name) ?? path;
}

/** One boundary violation. */
export interface Violation {
  /** The importing file, relative to the package directory. */
  file: string;
  /** The 1-based line of the import. */
  line: number;
  /** What is wrong, in a sentence. */
  message: string;
}

/**
 * Checks the boundary rules over a set of files.
 *
 * @param files - Every file under the package's `src/` and `test/`, keyed by package-relative path.
 */
export function checkProviderImports(files: SourceFiles): Violation[] {
  const known = new Set(files.keys());
  const violations: Violation[] = [];
  const entryNames = new Map<string, Set<string>>();
  const entryNamesFor = (path: string): Set<string> | undefined => {
    if (!known.has(path)) {
      return undefined;
    }
    let names = entryNames.get(path);
    if (!names) {
      names = readExportedNames(path, files);
      entryNames.set(path, names);
    }
    return names;
  };

  for (const [path, source] of [...files].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!path.startsWith('src/') && !path.startsWith('test/')) {
      continue;
    }
    const isTest = isTestFile(path);
    const owner = classifyFile(path);
    for (const reference of readImportReferences(path, source)) {
      const target = resolveSpecifier(path, reference.specifier, known);
      if (target === undefined) {
        continue;
      }
      const targetOwner = classifyFile(target);
      // Judge each name by the file that declares it, so a re-export cannot hide a provider symbol.
      const declared = reference.wholeModule
        ? []
        : reference.names.map((name) => ({
            name,
            file: resolveDeclaringFile(target, name, files),
          }));
      const reexported = declared.flatMap((entry) => {
        const declaringOwner = classifyFile(entry.file);
        return entry.file !== target && declaringOwner.kind === 'provider'
          ? [{ name: entry.name, file: entry.file, provider: declaringOwner.provider }]
          : [];
      });
      const barrelReachesProvider =
        reference.wholeModule &&
        targetOwner.kind === 'barrel' &&
        target !== 'src/index.ts' &&
        [...readExportedNames(target, files)].some(
          (name) => classifyFile(resolveDeclaringFile(target, name, files)).kind === 'provider',
        );
      if (owner.kind === 'neutral' && targetOwner.kind === 'provider') {
        violations.push({
          file: path,
          line: reference.line,
          message: `provider-neutral file imports ${targetOwner.provider} file ${target}`,
        });
      } else if (owner.kind === 'neutral' && reexported.length > 0) {
        for (const entry of reexported) {
          violations.push({
            file: path,
            line: reference.line,
            message: `provider-neutral file imports ${entry.name} through ${target}, declared in ${entry.provider} file ${entry.file}`,
          });
        }
      } else if (owner.kind === 'neutral' && barrelReachesProvider) {
        violations.push({
          file: path,
          line: reference.line,
          message: `provider-neutral file imports the whole of barrel ${target}, which re-exports provider-owned files`,
        });
      } else if (
        owner.kind === 'provider' &&
        targetOwner.kind === 'provider' &&
        owner.provider !== targetOwner.provider
      ) {
        violations.push({
          file: path,
          line: reference.line,
          message: `${owner.provider} file imports ${targetOwner.provider} file ${target}`,
        });
      } else if (
        owner.kind === 'provider' &&
        reexported.some((entry) => entry.provider !== owner.provider)
      ) {
        for (const entry of reexported.filter(
          (candidate) => candidate.provider !== owner.provider,
        )) {
          violations.push({
            file: path,
            line: reference.line,
            message: `${owner.provider} file imports ${entry.name} through ${target}, declared in ${entry.provider} file ${entry.file}`,
          });
        }
      } else if (owner.kind === 'provider' && targetOwner.kind !== 'provider') {
        const entries = (isTest ? PROVIDER_TEST_ENTRY_FILES : PROVIDER_SOURCE_ENTRY_FILES).filter(
          (entry) => known.has(entry),
        );
        const reachable = new Set<string>();
        for (const entry of entries) {
          for (const name of entryNamesFor(entry) ?? []) {
            reachable.add(name);
          }
        }
        const reachableFrom = isTest
          ? 'the root, provider-kit, provider-testing, or decision-testing'
          : 'provider-kit';
        if (reference.wholeModule) {
          violations.push({
            file: path,
            line: reference.line,
            message: `${owner.provider} file imports the whole of neutral module ${target}, which cannot be matched to ${reachableFrom} by name`,
          });
          continue;
        }
        for (const name of reference.names) {
          if (!reachable.has(name)) {
            violations.push({
              file: path,
              line: reference.line,
              message: `${owner.provider} file imports ${name} from neutral module ${target}, which ${reachableFrom} does not export`,
            });
          }
        }
      }
    }
  }
  return violations;
}

/**
 * Lists every file under a package's `src/` and `test/` directories, whatever its extension.
 *
 * @param root - The package directory.
 * @returns The paths relative to `root`, with forward slashes.
 */
export function readPackagePaths(root: string): string[] {
  const paths: string[] = [];
  const walk = (directory: string): void => {
    if (!existsSync(directory)) {
      return;
    }
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry === '.types' || entry === 'coverage') {
        continue;
      }
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        paths.push(relative(root, path).split(sep).join('/'));
      }
    }
  };
  walk(join(root, 'src'));
  walk(join(root, 'test'));
  return paths;
}

function readPackageFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (directory: string): void => {
    if (!existsSync(directory)) {
      return;
    }
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry === '.types' || entry === 'coverage') {
        continue;
      }
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (path.endsWith('.ts')) {
        files.set(relative(root, path).split(sep).join('/'), readFileSync(path, 'utf8'));
      }
    }
  };
  walk(join(root, 'src'));
  walk(join(root, 'test'));
  return files;
}

if (import.meta.main) {
  const commandArguments = process.argv.slice(2);
  const rootIndex = commandArguments.indexOf('--root');
  const root = resolve(rootIndex >= 0 ? (commandArguments[rootIndex + 1] ?? '.') : '.');
  const violations = [
    ...findProviderOwnedPaths(readPackagePaths(root)),
    ...checkProviderImports(readPackageFiles(root)),
  ];
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.message}`);
  }
  if (violations.length > 0) {
    console.error(`check-provider-imports: ${violations.length} violation(s).`);
    process.exit(1);
  }
}
