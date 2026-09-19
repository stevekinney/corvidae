import { posix } from 'node:path';

import { parse } from 'svelte/compiler';
import ts from 'typescript';

/**
 * The closure gate over emitted source: nothing the transform emits may import something the
 * transform does not emit.
 *
 * COR-1221 ruled that source is a workspace's `src/` tree plus declared inputs. Separately,
 * COR-1189's restore put nineteen published entry points back, three of which are shims that sit
 * inside `src/` and re-export from outside it — `src/cli/index.ts` is the `cinder` binary,
 * `src/cli/knowledge.ts` is the published `@lostgradient/cinder/knowledge` subpath, and
 * `src/exports/metadata-manifest.ts` is reached from `src/index.ts`, the package's main entry.
 * Each decision was right on its own; together they let the transform emit a target whose
 * `bun run typecheck` cannot resolve its own imports, and whose build cannot produce the binary.
 *
 * The existing surface gate cannot see this. `checkTargetCoverage` asks whether the file an
 * `exports` target names exists in corvidae; it never asks whether that file's own imports land
 * anywhere. So the hole is not "a missing entry point" — it is "an entry point that resolves to a
 * module nobody emitted", one edge further out, and it needs its own gate.
 *
 * **Why this reads the plan rather than the workspaces.** The emitted set is the plan's keys:
 * source, manifests, TypeScript configuration and declared inputs together. A specifier that
 * resolves to `packages/components/package.json` is satisfied by the manifest half even though
 * the source half never wrote it. Checking the workspace on disk instead would answer a different
 * question — whether corvidae has the file — which is the question the surface gate already
 * answers and is exactly the one that missed this.
 *
 * **Why the specifiers are parsed rather than matched.** `export * from` escapes as surely as
 * `import`, a type-only `import('…')` escapes at typecheck time, and a `.svelte` file carries its
 * imports inside a `<script>` block that no expression over the file text can delimit reliably.
 * The TypeScript compiler and Svelte's own parser are both already root dependencies —
 * `scripts/workspace-imports.test.ts` uses the first and `scripts/measure-codebase.ts` the
 * second — so the module graph is read from real syntax trees, and a string in a comment or a
 * fixture is never mistaken for an edge.
 *
 * **What it does not see.** A path a module reads at run time — `readFile(join(packageRoot,
 * 'components.json'))` in `scripts/knowledge/knowledge.ts`, the token corpus `scripts/tokens/
 * load.ts` opens — is a string computed at run time, not a module edge, and no closure over the
 * module graph can reach it. The gate's claim is bounded accordingly: the emitted target can
 * *resolve* every import, which is what its typecheck and its build ask. Whether a file some
 * emitted module opens at run time is also in the tarball is the `files` allowlist's question,
 * which `checkTargetCoverage` and `checkTarball` ask separately.
 */

export class SourceEscapeError extends Error {}

/** One emitted file's module specifier that resolves outside the emitted set. */
export interface SourceEscape {
  /** Target-relative path of the emitted file carrying the specifier. */
  file: string;
  /** The specifier exactly as written. */
  specifier: string;
  /** Target-relative path it resolves to, which no half of the transform emits. */
  resolved: string;
}

/**
 * Extensions whose contents carry module specifiers.
 *
 * `.d.ts` and `.d.mts` end in a listed extension and are read as the declarations they are. Every
 * other emitted file — a manifest, a stylesheet, the PNG fixture — is a valid *target* of a
 * specifier and never a source of one.
 */
const scannableExtensions = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.svelte',
] as const;

function isScannable(path: string): boolean {
  return scannableExtensions.some((extension) => path.endsWith(extension));
}

/**
 * Candidate emitted paths one resolved specifier could name.
 *
 * Corvidae writes extension-ful specifiers nearly everywhere, but not everywhere:
 * `packages/armorer`'s composition tests import `../test/helpers/async-assertions` with no
 * extension at all, and TypeScript's `NodeNext` resolution lets a `.js` specifier name a `.ts`
 * file. Every candidate here can only make a specifier *satisfied*, so the list is the difference
 * between a gate that reports real holes and one that reports resolution styles.
 */
function candidatePaths(resolved: string): string[] {
  const candidates = [resolved];
  const rewritten: Record<string, readonly string[]> = {
    '.js': ['.ts', '.tsx'],
    '.mjs': ['.mts'],
    '.cjs': ['.cts'],
    '.jsx': ['.tsx'],
  };
  for (const [suffix, replacements] of Object.entries(rewritten)) {
    if (!resolved.endsWith(suffix)) continue;
    const stem = resolved.slice(0, -suffix.length);
    for (const replacement of replacements) candidates.push(`${stem}${replacement}`);
  }
  for (const extension of [...scannableExtensions, '.json', '.css', '.d.ts']) {
    candidates.push(`${resolved}${extension}`);
    candidates.push(`${resolved}/index${extension}`);
  }
  return candidates;
}

/** Every module specifier one TypeScript or JavaScript file carries, in source order. */
function typeScriptSpecifiers(contents: string, path: string): string[] {
  const tree = ts.createSourceFile(
    path,
    contents,
    { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
    false,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    const literal = moduleSpecifierNode(node);
    if (literal !== undefined && ts.isStringLiteralLike(literal)) specifiers.push(literal.text);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return specifiers;
}

/**
 * The node holding a module specifier, for every form that creates a module edge.
 *
 * The same shape `scripts/workspace-imports.test.ts` walks, for the same reason: a package's
 * dependency edges and a file's resolution edges are the same edges. `import type`, `export from`,
 * `import()` in type position and the explicit resolution calls all break a typecheck in the
 * target exactly as a plain import does.
 */
function moduleSpecifierNode(node: ts.Node): ts.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
    return node.argument.literal;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression;
  }
  if (ts.isCallExpression(node) && isModuleLoadingCall(node.expression)) return node.arguments[0];
  return undefined;
}

function isModuleLoadingCall(expression: ts.LeftHandSideExpression): boolean {
  if (expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(expression)) return expression.text === 'require';
  if (!ts.isPropertyAccessExpression(expression)) return false;
  const receiver = expression.expression;
  if (ts.isIdentifier(receiver) && receiver.text === 'Bun') {
    return expression.name.text === 'resolve' || expression.name.text === 'resolveSync';
  }
  if (expression.name.text !== 'resolve') return false;
  return (
    (ts.isIdentifier(receiver) && receiver.text === 'require') ||
    (ts.isMetaProperty(receiver) && receiver.keywordToken === ts.SyntaxKind.ImportKeyword)
  );
}

/** Whether an AST node is a plain object the walk can descend into. */
function isWalkable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Every module specifier one Svelte component carries.
 *
 * Svelte's parser is asked for the whole component rather than its `<script>` blocks alone, and
 * the walk covers the fragment too: a `{#await import('./x.ts')}` in markup is a module edge the
 * instance script never mentions. The `source.value` shape is ESTree's, shared by the
 * `ImportDeclaration`, `ExportNamedDeclaration`, `ExportAllDeclaration` and `ImportExpression`
 * nodes Svelte embeds unchanged.
 */
function svelteSpecifiers(contents: string, path: string): string[] {
  let ast: unknown;
  try {
    ast = parse(contents, { modern: true, filename: path });
  } catch (error) {
    throw new SourceEscapeError(
      `The transform emits ${path}, which Svelte cannot parse, so its imports cannot be checked: ${(error as Error).message}`,
    );
  }
  const specifiers: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!isWalkable(node)) return;
    const type = node['type'];
    const source = node['source'];
    if (
      typeof type === 'string' &&
      (type.startsWith('Import') || type.startsWith('Export')) &&
      isWalkable(source) &&
      typeof source['value'] === 'string'
    ) {
      specifiers.push(source['value']);
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(ast);
  return specifiers;
}

/** Every module specifier one emitted file carries, whatever its language. */
export function moduleSpecifiers(contents: string, path: string): string[] {
  return path.endsWith('.svelte')
    ? svelteSpecifiers(contents, path)
    : typeScriptSpecifiers(contents, path);
}

function decode(contents: string | Uint8Array): string {
  return typeof contents === 'string' ? contents : new TextDecoder().decode(contents);
}

/**
 * Resolve one specifier against the file that carries it, as a target-relative path.
 *
 * Only relative specifiers are resolvable here. A bare specifier is a package edge, which the
 * emitted manifests declare and `scripts/workspace-imports.test.ts` already gates; a `$lib` or
 * `$app` alias is SvelteKit's, resolved by the target's own configuration. A query suffix —
 * `?raw`, `?url` — names the same file through a different loader, so it is stripped before
 * resolution rather than treated as part of the path.
 */
function resolveSpecifier(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const [withoutQuery = specifier] = specifier.split('?');
  return posix.normalize(posix.join(posix.dirname(file), withoutQuery));
}

/**
 * Every emitted specifier that resolves outside the emitted set.
 *
 * A path that climbs above the target root normalizes to a `..`-prefixed string, which is in no
 * plan and so is reported like any other escape rather than needing a case of its own.
 */
export function findSourceEscapes(
  files: Readonly<Record<string, string | Uint8Array>>,
): SourceEscape[] {
  const emitted = new Set(Object.keys(files));
  const escapes: SourceEscape[] = [];
  for (const [file, contents] of Object.entries(files)) {
    if (!isScannable(file)) continue;
    for (const specifier of moduleSpecifiers(decode(contents), file)) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved === undefined) continue;
      if (candidatePaths(resolved).some((candidate) => emitted.has(candidate))) continue;
      escapes.push({ file, specifier, resolved });
    }
  }
  return escapes.toSorted(
    (left, right) =>
      left.file.localeCompare(right.file) || left.specifier.localeCompare(right.specifier),
  );
}

/**
 * Refuse a plan whose emitted source imports something the plan does not emit.
 *
 * Every offender is named in one message, because the answer is almost never one file: a shim
 * that escapes usually escapes into a module tree, and a declaration that closes one edge tends
 * to open the next. Reporting the whole set lets one pass over the message produce the whole
 * declaration instead of one line per sync attempt.
 */
export function assertNoSourceEscapes(files: Readonly<Record<string, string | Uint8Array>>): void {
  const escapes = findSourceEscapes(files);
  if (escapes.length === 0) return;
  throw new SourceEscapeError(
    `The transform emits source that imports paths it does not emit:\n${escapes
      .map((escape) => `  ${escape.file}: ${escape.specifier} -> ${escape.resolved}`)
      .join(
        '\n',
      )}\nEither the importing file belongs outside the emitted source, or the imported path belongs in \`additionalSourceRoots\` in source.ts with a reason.`,
  );
}
