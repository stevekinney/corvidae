import {
  internalScope,
  isInternalSpecifier,
  isScannable,
  moduleSpecifierRanges,
} from './source-escapes.ts';

/**
 * Corvidae's internal workspace names, translated to the names the target publishes them under.
 *
 * The manifest half has always done this: `resolveInternalEdge` in `manifests.ts` maps every
 * `@corvidae/*` dependency to the public name `package-map.json` assigns it. The source half did
 * not, so the transform emitted a `packages/weft/package.json` declaring `@lostgradient/weft`
 * beside 37 files importing `@corvidae/weft` — a name that exists in this workspace and in no
 * target. That asymmetry was the whole defect: an internal name in an import statement is the
 * same fact as one in a dependency block, and `package-map.json` is the single authority for what
 * each becomes either way.
 *
 * **Why the specifiers are replaced in place rather than the file regenerated.** A printed AST is
 * a different file — different quotes, different line breaks, different trivia — so every emitted
 * source file would churn on the first sync and every subsequent diff would be unreadable. The
 * only bytes that change here are the ones between the quotes of a specifier that named corvidae.
 *
 * **Why the edges come from `source-escapes.ts`.** The rewriter and the gate that checks its work
 * have to agree on what a module edge is, or the rewriter misses a form the gate then reports —
 * or worse, the gate misses a form the rewriter never reached. One walk, two callers. That walk
 * covers `import`, `import type`, `export … from`, `export type … from`, `import()` in value and
 * type position, `require`, `require.resolve`, `import.meta.resolve`, `Bun.resolve`,
 * `import … = require(…)`, `declare module '…'`, and the same set inside a Svelte component's
 * script blocks and markup.
 *
 * **What it does not reach, deliberately.** An internal name that is not a module edge: prose in
 * a Markdown file, a code sample stored as a JSON string, `Symbol.for('@corvidae/operative/\
 * backend-descriptors')`, and the `WEFT_PACKAGE_NAME` constant `weft codegen` writes into the
 * declarations it generates. Rewriting an arbitrary string because it looks like a package name
 * is how a transform corrupts data; each of those is a decision about corvidae's own source, made
 * there rather than guessed at here.
 */

/** Raised when emitted source names a workspace `package-map.json` cannot translate. */
export class InternalNameError extends Error {}

/**
 * The public specifier one internal specifier becomes, subpath preserved.
 *
 * An unmapped name throws rather than passing through. A passthrough would emit exactly the
 * broken import this module exists to remove, and silently: the name would still be corvidae's,
 * the manifest would not declare it, and the failure would surface as a resolution error in
 * somebody else's repository.
 */
export function publicSpecifierFor(
  specifier: string,
  publicNames: ReadonlyMap<string, string>,
  context: string,
): string {
  const [scope, name, ...subpath] = specifier.split('/');
  const workspace = `${scope}/${name}`;
  const publicName = name === undefined ? undefined : publicNames.get(workspace);
  if (publicName === undefined) {
    throw new InternalNameError(
      `${context} names ${specifier}, but package-map.json gives ${workspace} no public name; every ${internalScope}/* name in emitted source must map to one, so add a disposition for it or stop emitting the file that names it`,
    );
  }
  return [publicName, ...subpath].join('/');
}

/**
 * Replace every internal module specifier in one file with its public name.
 *
 * Edits are applied from the end of the file backwards so that each one's offsets are still the
 * offsets the parser reported. The raw slice is compared against the parsed text first: they
 * differ only when the literal carries an escape sequence, and a specifier this module does not
 * recognise byte for byte is one it must not rewrite blind.
 */
export function rewriteInternalSpecifiers(
  contents: string,
  path: string,
  publicNames: ReadonlyMap<string, string>,
): string {
  const internal = moduleSpecifierRanges(contents, path).filter((range) =>
    isInternalSpecifier(range.specifier),
  );
  let rewritten = contents;
  for (const range of internal.toSorted((left, right) => right.start - left.start)) {
    const raw = rewritten.slice(range.start, range.end);
    if (raw !== range.specifier) {
      throw new InternalNameError(
        `${path} carries the specifier ${range.specifier} written as ${raw}, which cannot be rewritten in place; write it as a plain string literal`,
      );
    }
    const replacement = publicSpecifierFor(range.specifier, publicNames, path);
    rewritten = `${rewritten.slice(0, range.start)}${replacement}${rewritten.slice(range.end)}`;
  }
  return rewritten;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * One emitted file's bytes with its internal specifiers rewritten, or the same bytes untouched.
 *
 * Only a file whose language carries module specifiers is decoded at all, and only one whose
 * bytes actually mention the scope is parsed — the cinder plan is five and a half thousand files
 * and the overwhelming majority of them name nothing internal, so the cheap substring test is
 * what keeps this from adding a second full AST walk to every sync.
 */
export function rewriteEmittedSource(
  contents: Uint8Array,
  path: string,
  publicNames: ReadonlyMap<string, string>,
): Uint8Array {
  if (!isScannable(path)) return contents;
  const text = decoder.decode(contents);
  if (!text.includes(`${internalScope}/`)) return contents;
  const rewritten = rewriteInternalSpecifiers(text, path, publicNames);
  return rewritten === text ? contents : encoder.encode(rewritten);
}
