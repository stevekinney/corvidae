import {
  internalScope,
  isInternalSpecifier,
  isScannable,
  moduleSpecifierRanges,
  protectedRanges,
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
 * **Why comments are rewritten too, and separately.** A specifier walk is blind to comments by
 * construction, and the emitted weft target carried 1,121 mentions of `@corvidae/weft` in JSDoc
 * across 271 files — 1,051 of them on `import … from '@corvidae/weft'` lines inside `@example`
 * fences. The target's own `verify:jsdoc:doctests` compiles those examples against the package's
 * public face, so it failed 907 of 1,021 manifest entries on a name that resolves nowhere
 * downstream, while hover documentation showed every consumer the same name. A specifier and a
 * documented import are the same fact stated twice; `package-map.json` answers both.
 *
 * The comment pass is a second, narrower walk rather than part of the first, because the first
 * one's subject is module edges and a JSDoc mention is not one. What keeps it safe is
 * `protectedRanges`: every literal is off limits, so what remains in a TypeScript file is comment
 * trivia and code, and code cannot spell a package name.
 *
 * **Why Markdown is included.** The five documents weft's protocol suite reads ship downstream
 * and carried 19 mentions of `@corvidae/weft`, four of them `import … from '@corvidae/weft'`
 * inside fences that the target's `verify:markdown-doctests` extracts. A reader-facing document
 * naming a package that exists on no registry is wrong in the same way an `@example` is, so a
 * Markdown file takes the prose pass over its whole text, fences included. It takes no specifier
 * pass: a fenced import is text rather than a module edge, and there is no AST to walk.
 *
 * **What it does not reach, deliberately.** An internal name inside a literal, wherever it sits:
 * a code sample stored as a JSON string,
 * `Symbol.for('@corvidae/operative/backend-descriptors')`, the `WEFT_PACKAGE_NAME` constant
 * `weft codegen` writes into the declarations it generates, a `describe('@corvidae/weft barrel
 * re-exports')` test name and an error message that interpolates one. Rewriting an arbitrary
 * string because it looks like a package name is how a transform corrupts data; each of those is
 * a decision about corvidae's own source, made there rather than guessed at here. Svelte markup
 * is protected for the same reason — a name there is rendered text, not documentation.
 *
 * **A name the map does not know is left alone in a comment, where a specifier throws.** An
 * unmapped specifier is a broken import in somebody else's repository; an unmapped mention in
 * prose is a sentence about a workspace that target does not receive, and failing a whole sync
 * over a sentence trades a real defect for a worse one. Measured across both targets today, no
 * comment names a workspace `package-map.json` cannot translate.
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

/**
 * Every internal name a comment could be naming, longest first so a subpath wins over its root.
 *
 * Built from the scope rather than hard-coded so the two constants cannot drift. The character
 * class is npm's, which admits a dot, so a sentence-final `@corvidae/lifecycle.` matches with the
 * period attached; `publicNameInProse` trims that rather than the pattern refusing it, because a
 * package name may legitimately contain a dot and only the map can tell the two apart.
 */
const internalNameInProse = new RegExp(
  `${internalScope}/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*`,
  'g',
);

/** Trailing characters a sentence can leave on a name that a package name cannot end with. */
const sentencePunctuation = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', "'", '"', '`']);

/**
 * The public name one prose mention becomes, or `undefined` to leave it exactly as it is.
 *
 * The match is trimmed one trailing character at a time and each candidate is asked of the map,
 * so `@corvidae/weft` inside `(@corvidae/weft)` resolves, `@corvidae/weft/storage/testing` keeps
 * its whole face, and a name the map does not know returns `undefined` rather than throwing.
 */
export function publicNameInProse(
  match: string,
  publicNames: ReadonlyMap<string, string>,
): string | undefined {
  for (let candidate = match; candidate.length > 0; candidate = candidate.slice(0, -1)) {
    const [scope, name, ...subpath] = candidate.split('/');
    if (name === undefined || name.length === 0) break;
    const publicName = publicNames.get(`${scope}/${name}`);
    if (publicName !== undefined && subpath.every((segment) => segment.length > 0)) {
      return `${[publicName, ...subpath].join('/')}${match.slice(candidate.length)}`;
    }
    if (!sentencePunctuation.has(candidate.slice(-1))) break;
  }
  return undefined;
}

/**
 * Replace every internal package name a file's comments mention with its public name.
 *
 * Applied after the specifier rewrite and over that rewrite's output, so the ranges come from the
 * text as it will ship. Edits run from the end backwards for the same reason they do above: each
 * one's offsets have to be the offsets the parser reported.
 */
export function rewriteInternalProse(
  contents: string,
  path: string,
  publicNames: ReadonlyMap<string, string>,
): string {
  const protectedSpans = protectedRanges(contents, path);
  const edits: { start: number; end: number; replacement: string }[] = [];
  for (const match of contents.matchAll(internalNameInProse)) {
    const start = match.index;
    if (protectedSpans.some((span) => start >= span.start && start < span.end)) continue;
    const replacement = publicNameInProse(match[0], publicNames);
    if (replacement === undefined || replacement === match[0]) continue;
    edits.push({ start, end: start + match[0].length, replacement });
  }
  let rewritten = contents;
  for (const edit of edits.toSorted((left, right) => right.start - left.start)) {
    rewritten = `${rewritten.slice(0, edit.start)}${edit.replacement}${rewritten.slice(edit.end)}`;
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
  const documentation = path.endsWith('.md');
  if (!isScannable(path) && !documentation) return contents;
  const text = decoder.decode(contents);
  if (!text.includes(`${internalScope}/`)) return contents;
  // A Markdown document has no module edges to walk — a fenced import is text, not an edge the
  // parser would report — so it takes the prose pass alone. Everything else takes both, prose
  // second and over the specifier pass's output.
  const specified = documentation ? text : rewriteInternalSpecifiers(text, path, publicNames);
  const rewritten = rewriteInternalProse(specified, path, publicNames);
  return rewritten === text ? contents : encoder.encode(rewritten);
}
