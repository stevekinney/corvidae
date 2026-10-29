/**
 * Fails when a workspace exports a symbol without a documentation comment.
 *
 * Run from a workspace directory, as each library's and component's `lint` does. The check starts
 * at every entry point in the workspace's `exports` map, follows re-exports to the declaring
 * symbol, and requires that symbol to carry a non-empty documentation comment. A comment that
 * holds only tags does not count. It also judges each own, non-private property, method, and
 * accessor of an exported interface, class, or type alias to an object literal type, and each
 * overload signature of an overloaded function or method, which needs its own comment. Inherited
 * members, enums, namespaces, mapped and conditional types, and aliases such as `z.infer` are not
 * judged, and neither are call, construct, and index signatures or constructors. A symbol declared
 * in another workspace is that workspace's to document, and a dependency's is no one's, so both
 * are skipped, as are Svelte components, which Cinder's component metadata documents instead.
 *
 * An application has no `exports` map, so `--entries <glob>…` names the entry points instead:
 * every file under the workspace directory that matches a glob is judged as an entry point, and a
 * glob that begins with `!` removes the files it matches (`'!src/host/*.test.ts'`). In this mode the
 * entry-point part of every key is the file's path relative to the workspace, with forward
 * slashes (`src/host/host.ts Host`). A glob that matches no file fails, a file with no exports is
 * skipped, and the flag combines with `--seed`, `--seed-members`, and `--shrink`.
 *
 * Exports that were undocumented when the check arrived are listed in the workspace's
 * `documentation-coverage-allowlist.json`, and members in `documentation-member-allowlist.json`
 * under keys of the form `<entry point> <Symbol>.<member>` (an overload adds `(overload <n>)`). A
 * missing file is an empty list. Each list can only shrink: an undocumented export or member it
 * does not name fails, and so does an entry that is now documented or gone. `--shrink` drops those
 * stale entries from both files. `--seed` writes the first export list, refusing to run once the
 * file has entries, and `--seed-members` writes the first member list, refusing to run once the
 * file exists.
 */

import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export const ALLOWLIST_FILE = 'documentation-coverage-allowlist.json';
export const MEMBER_ALLOWLIST_FILE = 'documentation-member-allowlist.json';
const ALLOWLIST_DESCRIPTION =
  'Exports allowed to lack a documentation comment, checked by scripts/check-documentation-coverage.ts. The list can only shrink: --shrink drops stale entries, --seed refuses to run once this file has entries.';
const MEMBER_ALLOWLIST_DESCRIPTION =
  'Members of exported interfaces, classes, and object type aliases allowed to lack a documentation comment, as "<entry point> <Symbol>.<member>", checked by scripts/check-documentation-coverage.ts. The list can only shrink: --shrink drops stale entries, --seed-members refuses to run once this file exists.';

/** One `exports` entry: the subpath consumers import and the source module it maps to. */
export interface EntryPoint {
  subpath: string;
  file: string;
  /** Set for a file named by an `--entries` glob: a file with no exports is skipped, not an error. */
  optional?: boolean;
}

/**
 * Resolves `--entries` globs to entry points. Each pattern is matched against the files under
 * `directory`; a pattern that begins with `!` removes the files it matches from the others'
 * matches. The subpath of each entry point is its path relative to `directory`, with forward
 * slashes, and the result is sorted by it. A positive pattern that matches no file throws.
 */
export function expandEntries(directory: string, patterns: readonly string[]): EntryPoint[] {
  const included = patterns.filter((pattern) => !pattern.startsWith('!'));
  if (included.length === 0) throw new Error(`${directory}: --entries needs at least one glob`);
  const excluded = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => new Bun.Glob(pattern.slice(1)));
  const paths = new Set<string>();
  for (const pattern of included) {
    const matches = [...new Bun.Glob(pattern).scanSync({ cwd: directory })].map((match) =>
      match.split(sep).join('/'),
    );
    if (matches.length === 0) throw new Error(`${directory}: --entries ${pattern} matches no file`);
    for (const match of matches) paths.add(match);
  }
  return [...paths]
    .filter((path) => !excluded.some((glob) => glob.match(path)))
    .toSorted()
    .map((path) => ({ subpath: path, file: resolve(directory, path), optional: true }));
}

/** The modes and options the command line accepts. */
export interface Arguments {
  mode: '--seed' | '--seed-members' | '--shrink' | undefined;
  /** The `--entries` globs, or `undefined` when the workspace's `exports` map names the entries. */
  entries: string[] | undefined;
}

/** Parses the command line; a string result is the error to print. */
export function parseArguments(argv: readonly string[]): Arguments | string {
  let mode: Arguments['mode'];
  let entries: string[] | undefined;
  let collecting = false;
  for (const argument of argv) {
    if (argument === '--entries') {
      if (entries !== undefined) return 'unknown argument --entries given twice';
      entries = [];
      collecting = true;
    } else if (argument === '--seed' || argument === '--seed-members' || argument === '--shrink') {
      if (mode !== undefined) return `unknown argument ${argument} (already ${mode})`;
      mode = argument;
      collecting = false;
    } else if (collecting && !argument.startsWith('--')) {
      entries?.push(argument);
    } else {
      return `unknown argument ${argument}`;
    }
  }
  if (entries?.length === 0) return '--entries needs at least one glob';
  return { mode, entries };
}

/** Reads the workspace's `exports` map, which must map each subpath straight to a TypeScript file. */
export function readEntryPoints(directory: string, exports: unknown): EntryPoint[] {
  const map: Record<string, unknown> =
    typeof exports === 'string' ? { '.': exports } : ((exports ?? {}) as Record<string, unknown>);
  return Object.entries(map).map(([subpath, target]) => {
    if (typeof target !== 'string' || !/\.tsx?$/.test(target)) {
      throw new Error(
        `${directory}: export ${subpath} must map to a TypeScript source file, got ${JSON.stringify(target)}`,
      );
    }
    return { subpath, file: resolve(directory, target) };
  });
}

function isAmbientSvelteModule(declaration: ts.Declaration): boolean {
  for (let node: ts.Node | undefined = declaration; node; node = node.parent) {
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      return node.name.text.endsWith('.svelte');
    }
  }
  return false;
}

/** What the check found undocumented: exports and members, each as sorted allowlist keys. */
export interface UndocumentedFindings {
  /** `<subpath> <name>` keys of exports with no documentation comment. */
  exports: string[];
  /** `<subpath> <Symbol>.<member>` keys of members and overload signatures with no comment. */
  members: string[];
}

type CallableDeclaration = ts.FunctionDeclaration | ts.MethodDeclaration | ts.MethodSignature;

function isCallable(node: ts.Node): node is CallableDeclaration {
  return (
    ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node)
  );
}

function hasText(parts: ts.SymbolDisplayPart[]): boolean {
  return ts.displayPartsToString(parts).trim() !== '';
}

function hasBody(declaration: CallableDeclaration): boolean {
  return !ts.isMethodSignature(declaration) && declaration.body !== undefined;
}

/**
 * Judges a group of declarations of one function or method. An overloaded one has several
 * signatures, and each needs its own comment: the result lists `(overload <n>)` for every
 * signature without one. A callable with a single signature is judged as a whole and yields `''`
 * when undocumented.
 */
function undocumentedSignatures(
  checker: ts.TypeChecker,
  declarations: readonly CallableDeclaration[],
  symbol: ts.Symbol | undefined,
): string[] {
  const signatures = declarations.some(hasBody)
    ? declarations.filter((declaration) => !hasBody(declaration))
    : declarations;
  if (signatures.length >= 2) {
    return signatures.flatMap((declaration, index) => {
      const signature = checker.getSignatureFromDeclaration(declaration);
      return signature && hasText(signature.getDocumentationComment(checker))
        ? []
        : [`(overload ${index + 1})`];
    });
  }
  return symbol && hasText(symbol.getDocumentationComment(checker)) ? [] : [''];
}

/** The own members of an exported interface, class, or object literal type alias. */
function ownMembers(declaration: ts.Declaration): readonly ts.Node[] {
  if (ts.isInterfaceDeclaration(declaration)) return declaration.members;
  if (ts.isClassDeclaration(declaration)) {
    return declaration.members.flatMap((member): readonly ts.Node[] =>
      ts.isConstructorDeclaration(member) ? member.parameters : [member],
    );
  }
  if (ts.isTypeAliasDeclaration(declaration)) {
    let type = declaration.type;
    while (ts.isParenthesizedTypeNode(type)) type = type.type;
    return ts.isTypeLiteralNode(type) ? type.members : [];
  }
  return [];
}

type JudgedMember =
  | ts.PropertySignature
  | ts.PropertyDeclaration
  | ts.MethodSignature
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ParameterDeclaration;

function isJudgedMember(node: ts.Node): node is JudgedMember {
  // A constructor parameter with an accessibility or `readonly` modifier declares a property.
  if (ts.isParameter(node)) {
    return (
      ts.isIdentifier(node.name) &&
      ts.isParameterPropertyDeclaration(node, node.parent) &&
      (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Private) === 0
    );
  }
  if (!(
    ts.isPropertySignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )) {
    return false;
  }
  const isPrivate =
    ts.isPrivateIdentifier(node.name) ||
    (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Private) !== 0;
  return !isPrivate;
}

function isCallableMember(node: JudgedMember): node is ts.MethodDeclaration | ts.MethodSignature {
  return isCallable(node);
}

function isStatic(member: JudgedMember): boolean {
  return (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0;
}

/** The symbol whose comment documents the member: a parameter property's property symbol. */
function memberSymbol(checker: ts.TypeChecker, member: JudgedMember): ts.Symbol | undefined {
  if (ts.isParameter(member) && ts.isIdentifier(member.name)) {
    return checker.getSymbolsOfParameterPropertyDeclaration(member, member.name.text)[1];
  }
  return checker.getSymbolAtLocation(member.name);
}

function memberName(name: ts.PropertyName | ts.BindingName): string {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : name.getText();
}

/** Lists the `<Symbol>.<member>` keys, without the entry point, of undocumented own members. */
function undocumentedMembers(
  checker: ts.TypeChecker,
  symbolName: string,
  declarations: readonly ts.Declaration[],
): string[] {
  const groups = new Map<string, JudgedMember[]>();
  for (const declaration of declarations) {
    for (const member of ownMembers(declaration)) {
      if (!isJudgedMember(member)) continue;
      // A static member and an instance member of the same name are different properties.
      const name = `${isStatic(member) ? 'static.' : ''}${memberName(member.name)}`;
      groups.set(name, [...(groups.get(name) ?? []), member]);
    }
  }
  const undocumented: string[] = [];
  for (const [name, members] of groups) {
    const symbol = memberSymbol(checker, members[0]!);
    const suffixes = members.every(isCallableMember)
      ? undocumentedSignatures(checker, members, symbol)
      : symbol && hasText(symbol.getDocumentationComment(checker))
        ? []
        : [''];
    for (const suffix of suffixes) undocumented.push(`${symbolName}.${name}${suffix}`);
  }
  return undocumented;
}

/**
 * Lists the workspace's undocumented exports and members as `<subpath> <name>` and
 * `<subpath> <Symbol>.<member>` keys, sorted. A symbol exported from several entry points is
 * judged once, under the first entry point that exports it. `declarationFiles` are the ambient
 * declarations the workspace compiles with, such as its `*.svelte` module declaration.
 */
export function findUndocumented(
  directory: string,
  entryPoints: readonly EntryPoint[],
  options: ts.CompilerOptions,
  declarationFiles: readonly string[] = [],
): UndocumentedFindings {
  const program = ts.createProgram(
    [...entryPoints.map((entry) => entry.file), ...declarationFiles],
    { ...options, noEmit: true },
  );
  const checker = program.getTypeChecker();
  const ownDirectory = resolve(directory) + sep;
  const seen = new Set<ts.Symbol>();
  const undocumented: string[] = [];
  const members: string[] = [];

  for (const entry of entryPoints) {
    const sourceFile = program.getSourceFile(entry.file);
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) {
      if (entry.optional) continue;
      throw new Error(`${directory}: cannot load export ${entry.subpath}`);
    }

    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      if (seen.has(symbol)) continue;
      seen.add(symbol);

      const declarations = symbol.declarations ?? [];
      const owned = declarations.filter((declaration) => {
        const fileName = resolve(declaration.getSourceFile().fileName);
        return fileName.startsWith(ownDirectory) && !fileName.includes(`${sep}node_modules${sep}`);
      });
      if (owned.length === 0 || owned.some(isAmbientSvelteModule)) continue;

      const documentation = ts.displayPartsToString(symbol.getDocumentationComment(checker));
      if (documentation.trim() === '') undocumented.push(`${entry.subpath} ${exported.name}`);

      const functions = owned.filter(ts.isFunctionDeclaration);
      const overloads =
        functions.length > 0 ? undocumentedSignatures(checker, functions, symbol) : [];
      for (const suffix of overloads.filter((overload) => overload !== '')) {
        members.push(`${entry.subpath} ${exported.name}${suffix}`);
      }
      for (const key of undocumentedMembers(checker, exported.name, owned)) {
        members.push(`${entry.subpath} ${key}`);
      }
    }
  }
  return { exports: undocumented.toSorted(), members: members.toSorted() };
}

/** Lists the workspace's undocumented exports as `<subpath> <name>` keys, sorted. */
export function findUndocumentedExports(
  directory: string,
  entryPoints: readonly EntryPoint[],
  options: ts.CompilerOptions,
  declarationFiles: readonly string[] = [],
): string[] {
  return findUndocumented(directory, entryPoints, options, declarationFiles).exports;
}

export interface CoverageJudgement {
  /** Undocumented exports or members the allowlist does not name. */
  missing: string[];
  /** Allowlist entries for exports or members that are documented now, or gone. */
  stale: string[];
}

export function judgeCoverage(
  undocumented: readonly string[],
  allowlist: readonly string[],
): CoverageJudgement {
  const allowed = new Set(allowlist);
  const current = new Set(undocumented);
  return {
    missing: undocumented.filter((key) => !allowed.has(key)),
    stale: allowlist.filter((key) => !current.has(key)),
  };
}

function readConfiguration(directory: string): ts.ParsedCommandLine {
  const path = join(directory, 'tsconfig.json');
  const loaded = ts.readConfigFile(path, (file) => ts.sys.readFile(file));
  if (loaded.error) {
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  }
  return ts.parseJsonConfigFileContent(loaded.config, ts.sys, directory);
}

/** Reads an allowlist's entries; a missing file is an empty list. */
export async function readAllowlist(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  const contents: { entries?: string[] } = await Bun.file(path).json();
  return contents.entries ?? [];
}

async function writeAllowlist(
  path: string,
  description: string,
  entries: readonly string[],
): Promise<void> {
  await Bun.write(
    path,
    `${JSON.stringify({ description, entries: entries.toSorted() }, null, 2)}\n`,
  );
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArguments(argv);
  if (typeof parsed === 'string') {
    process.stderr.write(`check-documentation-coverage — ${parsed}\n`);
    return 2;
  }
  const { mode, entries } = parsed;
  const directory = process.cwd();
  const name = relative(join(import.meta.dir, '..'), directory);
  const manifest: { exports?: unknown } = await Bun.file(join(directory, 'package.json')).json();
  const configuration = readConfiguration(directory);
  const found = findUndocumented(
    directory,
    entries ? expandEntries(directory, entries) : readEntryPoints(directory, manifest.exports),
    configuration.options,
    configuration.fileNames.filter((fileName) => fileName.endsWith('.d.ts')),
  );
  const allowlistPath = join(directory, ALLOWLIST_FILE);
  const memberAllowlistPath = join(directory, MEMBER_ALLOWLIST_FILE);
  const allowlist = await readAllowlist(allowlistPath);
  const memberAllowlist = await readAllowlist(memberAllowlistPath);

  if (mode === '--seed') {
    if (allowlist.length > 0) {
      process.stderr.write(
        `check-documentation-coverage — ${name}: the allowlist already has entries; not seeding.\n`,
      );
      return 1;
    }
    if (found.exports.length > 0) {
      await writeAllowlist(allowlistPath, ALLOWLIST_DESCRIPTION, found.exports);
    }
    process.stdout.write(
      `check-documentation-coverage — ${name}: seeded ${found.exports.length} entries.\n`,
    );
    return 0;
  }

  if (mode === '--seed-members') {
    if (existsSync(memberAllowlistPath)) {
      process.stderr.write(
        `check-documentation-coverage — ${name}: the member allowlist already exists; not seeding.\n`,
      );
      return 1;
    }
    await writeAllowlist(memberAllowlistPath, MEMBER_ALLOWLIST_DESCRIPTION, found.members);
    process.stdout.write(
      `check-documentation-coverage — ${name}: seeded ${found.members.length} member entries.\n`,
    );
    return 0;
  }

  const exportsJudgement = judgeCoverage(found.exports, allowlist);
  const membersJudgement = judgeCoverage(found.members, memberAllowlist);
  const missingCount = exportsJudgement.missing.length + membersJudgement.missing.length;
  const staleCount = exportsJudgement.stale.length + membersJudgement.stale.length;
  if (mode === '--shrink') {
    if (allowlist.length > 0) {
      await writeAllowlist(
        allowlistPath,
        ALLOWLIST_DESCRIPTION,
        allowlist.filter((key) => !exportsJudgement.stale.includes(key)),
      );
    }
    if (membersJudgement.stale.length > 0) {
      await writeAllowlist(
        memberAllowlistPath,
        MEMBER_ALLOWLIST_DESCRIPTION,
        memberAllowlist.filter((key) => !membersJudgement.stale.includes(key)),
      );
    }
    process.stdout.write(
      `check-documentation-coverage — ${name}: removed ${staleCount} stale entries.\n`,
    );
    return missingCount > 0 ? 1 : 0;
  }

  if (missingCount === 0 && staleCount === 0) {
    process.stdout.write(
      `check-documentation-coverage — ${name}: OK (${allowlist.length} exports and ${memberAllowlist.length} members allowlisted).\n`,
    );
    return 0;
  }
  const lines = [
    ...exportsJudgement.missing.map((key) => `undocumented export: ${key}`),
    ...membersJudgement.missing.map((key) => `undocumented member: ${key}`),
    ...exportsJudgement.stale.map(
      (key) => `stale allowlist entry (documented or no longer exported): ${key}`,
    ),
    ...membersJudgement.stale.map(
      (key) => `stale member allowlist entry (documented or no longer a member): ${key}`,
    ),
  ];
  process.stderr.write(
    `check-documentation-coverage — ${name}:\n${lines.map((line) => `  ${line}`).join('\n')}\n\n` +
      'Add a documentation comment to each undocumented export and member. ' +
      `Remove stale entries with: bun ../../scripts/check-documentation-coverage.ts --shrink\n`,
  );
  return 1;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
