/**
 * Token-usage discipline report + guard for Cinder component styles.
 *
 * Backs the themeability policy: a consumer overrides a documented set of design
 * tokens and the whole library follows. That contract breaks when component CSS
 * references a `var(--cinder-*)` name that resolves to nothing — a typo, a stale
 * rename, or an undeclared "looks-like-a-token" name. Those references silently
 * fall back to their inline default (or `unset`), so the component stops tracking
 * the token system without any error.
 *
 * Every `var(--cinder-*)` reference in component styling is classified into one
 * category, and the report groups by category so a fixer knows the right action:
 *   - `global`         — a public token declared in the DTCG corpus (read from
 *                        the generated registry). OK.
 *   - `component-owned` — `--cinder-<this-file's-component>-*`. A public component
 *     override variable, valid even when only ever read-with-fallback / JS-set. OK.
 *   - `private`         — `--_cinder-*`. An implementation detail. OK.
 *   - `runtime`         — a JS/inline-style-set state variable on the runtime
 *     allowlist (read OUTSIDE its owning component). OK, documented.
 *   - `unresolved`      — none of the above. This is the debt: a stale name to
 *     rename, a missing token to add to the DTCG corpus, or a cross-component
 *     reference that should be a shared token. REPORTED.
 *
 * The ownership prefix is the CURRENT FILE's own component-directory name, NOT
 * "any component name." This matters: a `surface/` component dir exists, so an
 * "any-dir" rule would wrongly bless the stale `--cinder-surface-muted` reference
 * in `feed.css` as component-owned. Per-file-prefix flags it correctly.
 *
 * Two modes (mirrors `check-platform-features.ts` / `check-component-css-raw-colors.ts`):
 *   - default: print the per-category inventory + the unresolved sites. Exits 0.
 *   - `--strict`: compare unresolved sites against the baseline
 *     (`token-usage-baseline.json`); exit non-zero only when a NEW unresolved
 *     reference appears. `--update-baseline` rewrites it after an intentional
 *     change (a stale name fixed → the baseline shrinks).
 *
 * Run via `bun run --filter=@lostgradient/cinder tokens:audit` (report) / `tokens:audit
 * --strict` (gate; wired into `check-component-css-token-usage.test.ts`, which runs
 * under `bun run validate` as part of the package's default test suite).
 *
 * Scan surface (COR-344): a `--cinder-*` reference can go undeclared in three
 * places the original single-package, `<style>`-only scan could not see:
 *
 *   1. A component in a DIFFERENT workspace package. `--cinder-*` is a
 *      workspace-wide convention — chat and editor components declare and
 *      reference their own `--cinder-<component>-*` overrides exactly like a
 *      Cinder component does (e.g. `--cinder-chat-font-size`,
 *      `--cinder-review-editor-popover-width`) — so a stale reference there is
 *      the same defect this audit exists to catch. {@link defaultScanRoots}
 *      additionally walks `components/chat`, `components/editor`, and
 *      `scripts/browser-fixtures/src`: the last has no per-directory
 *      component-ownership convention of its own (a test fixture), but COR-348
 *      found undeclared `--cinder-border-*` references in exactly that kind of
 *      tree, so leaving it out would leave the audit blind to the class of site
 *      that caused that bug.
 *   2. An inline `style="…"` attribute in a `.svelte` file's markup.
 *      {@link extractStyleSurface} used to blank everything outside a `<style>`
 *      block, which hid a reference like
 *      `style="border: 1px solid var(--cinder-border-subtle)"` from the scanner
 *      entirely. It now also keeps `style="…"` / `style='…'` attribute values.
 *   3. A `*.examples.json` file's embedded `code` string. These ship as public,
 *      independently-importable metadata (`@lostgradient/chat`'s
 *      `chat-navigation-rail.examples.json` is a published export), so a stale
 *      reference inside one reaches consumers exactly like a stale reference in
 *      component source does. `isTestPath` used to exclude every
 *      `*.examples.json` file outright — reasonable for the DECLARATION pass,
 *      since example code is consumer-facing demo content, not a source of
 *      truth a component "owns" a prefix from, but wrong for the REFERENCE
 *      pass, which is what let `--cinder-border-default` and
 *      `--cinder-border-subtle` ship undetected. `isExamplesJsonPath` now
 *      separates the two: still excluded from declarations, included in
 *      references (via {@link extractExamplesJsonSurfaces}).
 */

import { Glob } from 'bun';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const componentsRoot = resolve(scriptDirectory, '..');
const componentsSource = join(componentsRoot, 'src');
/** Exported so the workspace-wide gate test can read the same registry the CLI does. */
export const tokenRegistryPath = join(componentsSource, 'tokens', 'registry.generated.json');
const defaultBaselinePath = join(scriptDirectory, 'token-usage-baseline.json');

/**
 * Runtime-state variables that are set from JS (`element.style.setProperty`) or an
 * inline `style:` binding and READ from a file other than their owning component.
 * Component-prefixed runtime vars (e.g. `--cinder-color-picker-hue`) do NOT belong
 * here — they resolve via the component-owned rule from their own component. Each
 * entry needs a written reason so the allowlist stays honest.
 */
export const RUNTIME_VARIABLE_ALLOWLIST: Array<{ name: string; reason: string }> = [
  // (none yet — every runtime var found so far is component-prefixed and resolves
  // via the component-owned rule. Add cross-component runtime vars here with a reason.)
];

/**
 * Shared CSS partials under `src/styles/components/` have no component directory,
 * so their "owned" custom-property prefixes are enumerated explicitly. A reference
 * in one of these files is `component-owned` when it matches one of the listed
 * prefixes. Keep this minimal and reasoned.
 */
export const SHARED_PARTIAL_OWNED_PREFIXES: Record<string, string[]> = {
  'src/styles/components/_input-frame.css': ['--cinder-input-frame'],
  'src/styles/components/_control-item.css': ['--cinder-control-item'],
  'src/styles/components/_dismiss-button.css': ['--cinder-dismiss-button'],
  'src/styles/components/_floating-surface.css': ['--cinder-floating-surface'],
  'src/styles/components/_scroll-fade.css': ['--cinder-scroll-fade'],
  'src/styles/components/json-highlight.css': ['--cinder-json-highlight'],
  'src/styles/components/experimental/_json-viewer-node.css': ['--cinder-json-viewer'],
  'src/styles/components/experimental/popover.css': ['--cinder-popover'],
  'src/styles/components/experimental.css': [],
};

export type TokenCategory = 'global' | 'component-owned' | 'private' | 'runtime' | 'unresolved';

export type TokenFlag = {
  /** Source-relative POSIX path. */
  filePath: string;
  /** 1-based line number where the reference starts. */
  lineNumber: number;
  /** The full custom-property name, e.g. `--cinder-surface-muted`. */
  name: string;
  /** Resolution category. */
  category: TokenCategory;
};

/** Normalizes a path to forward slashes so baseline keys are OS-independent. */
export function toPosixPath(path: string): string {
  return path.replaceAll('\\', '/');
}

/** True for test/spec sources, which are never part of the authoring rule. */
export function isTestPath(relativePath: string): boolean {
  return (
    /(?:^|\/)__tests__\//.test(relativePath) || /\.(?:test|spec)\.[cm]?tsx?$/.test(relativePath)
  );
}

/**
 * True for a `*.examples.json` file (per `examples.schema.json`). These are
 * excluded from the DECLARATION pass — a published example snippet is
 * consumer-facing demo content, not a source of truth a component "owns" a
 * `--cinder-<component>-*` prefix from — but, unlike {@link isTestPath}, are
 * NOT excluded from the REFERENCE pass: see the module doc comment (COR-344).
 */
export function isExamplesJsonPath(relativePath: string): boolean {
  return relativePath.endsWith('.examples.json');
}

/** Strips block comments, preserving newline count (shared shape across guards). */
export function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => {
    const newlines = comment.match(/\n/g)?.length ?? 0;
    return ' ' + '\n'.repeat(newlines);
  });
}

/**
 * Keeps only `<style>` block content AND inline `style="…"` / `style='…'`
 * attribute values for a `.svelte` file (blanking everything else, preserving
 * newline count so line numbers stay accurate); passes `.css` through
 * untouched. Svelte's `style:property={expression}` directive is a JS
 * expression, not a CSS declaration list, and is deliberately NOT matched —
 * only the plain HTML `style` attribute is (COR-344: a `var(--cinder-*)`
 * reference inside an inline `style="…"` used to be invisible to this scan
 * because everything outside a `<style>` block was blanked).
 */
export function extractStyleSurface(source: string, isSvelte: boolean): string {
  if (!isSvelte) return source;

  const keepSpans: Array<[number, number]> = [];

  const styleBlock = /<style\b[^>]*>([\s\S]*?)<\/style>/g;
  let match: RegExpExecArray | null;
  while ((match = styleBlock.exec(source)) !== null) {
    const blockStart = match.index + match[0].indexOf('>') + 1;
    const blockEnd = blockStart + (match[1]?.length ?? 0);
    keepSpans.push([blockStart, blockEnd]);
  }

  const inlineStyleAttribute = /\sstyle\s*=\s*(["'])([\s\S]*?)\1/dg;
  while ((match = inlineStyleAttribute.exec(source)) !== null) {
    const indices = (match as RegExpExecArray & { indices?: Array<[number, number]> }).indices;
    const valueSpan = indices?.[2];
    if (valueSpan) keepSpans.push(valueSpan);
  }

  keepSpans.sort((a, b) => a[0] - b[0]);

  let result = '';
  let lastIndex = 0;
  for (const [start, end] of keepSpans) {
    if (start < lastIndex) continue; // defensive: spans should never overlap
    result += source.slice(lastIndex, start).replace(/[^\n]/g, ' ');
    result += source.slice(start, end);
    lastIndex = end;
  }
  result += source.slice(lastIndex).replace(/[^\n]/g, ' ');
  return result;
}

/**
 * Extracts every example's `code` snippet from a `*.examples.json` file (per
 * `examples.schema.json`: `{ examples: [{ id, code, ... }] }`) as a
 * `{ id, surface }` pair ready for {@link findReferences}. Each `code` string
 * is a complete, self-contained Svelte snippet — once `JSON.parse` has undone
 * its `\n` escaping it is real Svelte source, so it is run through the same
 * {@link extractStyleSurface} a `.svelte` component file gets, keeping
 * `<style>` blocks and inline `style="…"` attributes.
 *
 * Returns `[]` for malformed JSON or a shape that doesn't match the schema,
 * rather than throwing: a schema-invalid examples file is a defect this audit
 * doesn't own catching, and this scan should not crash the whole run over it.
 */
export function extractExamplesJsonSurfaces(
  source: string,
): Array<{ id: string; surface: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const examples = readField(parsed, 'examples');
  if (!Array.isArray(examples)) return [];

  const surfaces: Array<{ id: string; surface: string }> = [];
  for (const example of examples) {
    if (typeof example !== 'object' || example === null) continue;
    const id = readField(example, 'id');
    const code = readField(example, 'code');
    if (typeof id === 'string' && typeof code === 'string') {
      surfaces.push({ id, surface: extractStyleSurface(code, true) });
    }
  }
  return surfaces;
}

/** One field of an already-narrowed object, without asserting a shape over it. */
function readField(source: object, field: string): unknown {
  return Object.hasOwn(source, field)
    ? (Object.getOwnPropertyDescriptor(source, field)?.value as unknown)
    : undefined;
}

/**
 * The public global tokens, read from the generated registry rather than
 * scraped out of `tokens-base.css`.
 *
 * Parsing the CSS asked the wrong question. It found what the stylesheet
 * HAPPENS TO DECLARE, so a component could only be caught referencing a token
 * after that token had been generated into CSS -- and a name that appeared in
 * the CSS for any reason counted as a documented token. The registry answers
 * what the design system DECLARES to be public, which is the question the
 * check is actually asking, and it is available before any CSS is emitted.
 *
 * The two agree exactly on the current corpus: 216 tokens, no difference in
 * either direction. That is not a coincidence to rely on quietly -- CIN-30's
 * completeness check inside `tokens:check` requires every emitted custom
 * property to have a corpus entry, so the sets are held equal by a gate.
 *
 * `public` is filtered on deliberately: a private `--_cinder-*` token is not a
 * global a component may reference, and the registry is the only source that
 * knows the difference. The CSS scan could not distinguish them at all.
 */
export function parseGlobalTokens(registrySource: string): Set<string> {
  // Narrowed through `unknown` rather than asserted straight out of
  // `JSON.parse`, whose return is `any`: a malformed registry should fail here
  // with a named reason, not as a confusing property access downstream.
  const parsed: unknown = JSON.parse(registrySource);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('The token registry is not a JSON object.');
  }
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new Error('The token registry has no `entries` array.');
  }

  const tokens = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    // Validated per entry, not just at the top level: a malformed artifact
    // should name the offending index here rather than surface as a TypeError
    // from reading `.public` off a string several frames away.
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`The token registry's entries[${index}] is not an object.`);
    }
    const cssProperty = readField(entry, 'cssProperty');
    const isPublic = readField(entry, 'public');
    if (typeof cssProperty !== 'string' || typeof isPublic !== 'boolean') {
      throw new Error(
        `The token registry's entries[${index}] is missing a string cssProperty or boolean public.`,
      );
    }
    if (isPublic) tokens.add(cssProperty);
  }
  return tokens;
}

/**
 * Extracts every custom-property name a source DECLARES or SETS: a CSS LHS
 * declaration (`--cinder-kanban-column-width: 18rem;`), a JS
 * `style.setProperty('--cinder-toast-height', …)`, or an inline Svelte
 * `style="--cinder-toast-swipe-x: …"` / `style:--x`. These are the variables a
 * component OWNS even when its prefix is a shortened form of the directory name
 * (`toast-region/` owns `--cinder-toast-*`; `kanban-board/` owns
 * `--cinder-kanban-*`). Pure for testability.
 */
export function findDeclaredNames(source: string): Set<string> {
  const declared = new Set<string>();
  // Strip `var(…)` calls first so that names in fallback positions —
  // e.g. `var(--cinder-a, --cinder-b: fallback)` — are removed before
  // scanning. Without this, the naive `--name:` pattern would falsely collect
  // `--cinder-b` as a declaration. The strip replaces the entire `var(` call
  // up to its matching `)` with whitespace (preserving line structure) rather
  // than removing it, so source offsets remain stable if callers also need
  // them. Nested `var()` are handled by repeated stripping until no `var(`
  // remains, which is safe for typical 1-2 nesting levels in CSS.
  let stripped = source;
  let previous: string;
  do {
    previous = stripped;
    stripped = stripped.replace(/var\([^()]*\)/g, (match) => match.replace(/[^\n]/g, ' '));
  } while (stripped !== previous);

  // CSS LHS declaration: `--cinder-x:` on the left side of a property value.
  const cssDeclaration = /(--_?cinder-[a-z0-9-]+)\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = cssDeclaration.exec(stripped)) !== null) {
    if (match[1]) declared.add(match[1]);
  }
  const setProperty = /setProperty\(\s*['"](--_?cinder-[a-z0-9-]+)/g;
  while ((match = setProperty.exec(source)) !== null) {
    if (match[1]) declared.add(match[1]);
  }
  return declared;
}

/** Escapes a literal string for use inside a `RegExp` constructor. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Derives the owning component prefix for a component-tree file path. For
 * `src/components/color-picker/color-picker.css` the component dir is
 * `color-picker`, so the owned prefix is `--cinder-color-picker`. Leaf files in a
 * compound component (e.g. `accordion-item/`) own their own dir's prefix; a family
 * reference to the parent is intentionally NOT auto-owned (parent tokens that are
 * shared belong in tokens-base or are flagged for promotion). Returns null for a
 * path that is not directly under `<componentsPrefix>/<dir>/`.
 *
 * `componentsPrefix` defaults to Cinder's own `src/components` (the original,
 * single-package shape); {@link defaultScanRoots} passes each workspace
 * package's own components-root prefix (e.g. `chat/src/lib/components`) so the
 * same ownership rule applies workspace-wide (COR-344).
 */
export function componentOwnedPrefix(
  posixPath: string,
  componentsPrefix = 'src/components',
): string | null {
  const match = new RegExp(`^${escapeRegExp(componentsPrefix)}/([^/]+)/`).exec(posixPath);
  if (!match || !match[1]) return null;
  // A bare file like `src/components/_sortable-item.svelte` has no component dir.
  if (match[1].endsWith('.svelte')) return null;
  return `--cinder-${match[1]}`;
}

/** True when `name` equals `prefix` or extends it at a hyphen boundary. */
export function matchesPrefix(name: string, prefix: string): boolean {
  return name === prefix || name.startsWith(`${prefix}-`);
}

/**
 * Classifies a single `--cinder-*` reference for a file. `ownedPrefixes` are the
 * file's component-owned prefixes (dir-derived or shared-partial); `ownedDeclared`
 * is the set of custom-property names the file's OWN component declares/sets
 * (catches shortened prefixes like `toast-region/` owning `--cinder-toast-*`);
 * `globals` is the set of declared global token names. Pure for testability.
 */
export function classifyReference(
  name: string,
  ownedPrefixes: string[],
  ownedDeclared: Set<string>,
  globals: Set<string>,
): TokenCategory {
  if (name.startsWith('--_cinder')) return 'private';
  if (globals.has(name)) return 'global';
  if (ownedPrefixes.some((prefix) => matchesPrefix(name, prefix))) return 'component-owned';
  if (ownedDeclared.has(name)) return 'component-owned';
  if (RUNTIME_VARIABLE_ALLOWLIST.some((entry) => entry.name === name)) return 'runtime';
  return 'unresolved';
}

/**
 * The component-dir key for a component-tree posix path, or null. See
 * {@link componentOwnedPrefix} for `componentsPrefix`.
 */
export function componentDirKey(
  posixPath: string,
  componentsPrefix = 'src/components',
): string | null {
  const match = new RegExp(`^${escapeRegExp(componentsPrefix)}/([^/]+)/`).exec(posixPath);
  if (!match || !match[1] || match[1].endsWith('.svelte')) return null;
  return match[1];
}

/** All `var(--cinder-*)` reference names + line numbers in a (stripped) surface. */
export function findReferences(surface: string): Array<{ name: string; lineNumber: number }> {
  const references: Array<{ name: string; lineNumber: number }> = [];
  // Match each `var( --cinder-NAME` opener — a nested fallback
  // `var(--a, var(--b))` yields two openers, so both --a and --b are captured.
  const pattern = /var\(\s*(--_?cinder-[a-z0-9-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(surface)) !== null) {
    const name = match[1];
    if (!name) continue;
    const lineNumber = surface.slice(0, match.index).split('\n').length;
    references.push({ name, lineNumber });
  }
  return references;
}

export type ScanRoot = {
  /** Absolute directory to scan. */
  dir: string;
  /** Prefix used to build each flag's reported `filePath`. */
  reportPrefix: string;
  /**
   * The components-root prefix passed to {@link componentOwnedPrefix} /
   * {@link componentDirKey} for files under this root — always equal to
   * `reportPrefix` in this codebase, since every root with directory-based
   * ownership already has `dir` pointing AT the directory whose immediate
   * children are component directories. `null` when this root has no
   * per-directory ownership convention of its own (an application view tree,
   * a test-fixture tree, or Cinder's shared `styles/components/` partials,
   * which use the explicit {@link SHARED_PARTIAL_OWNED_PREFIXES} map instead).
   */
  componentsPrefix: string | null;
};

/**
 * The workspace-wide scan roots this audit walks (COR-344 — see the module
 * doc comment for why each root beyond Cinder's own two is included). Passing
 * `sourceRoot` (the CLI `--source-root` override) replaces the whole
 * workspace-wide list with a single ad hoc `<sourceRoot>/components` (+
 * `<sourceRoot>/styles/components` if present) pair, for pointing the scan at
 * a synthetic fixture tree instead of the real repo.
 *
 * Cinder's own two roots keep their original `reportPrefix` exactly
 * (`src/components`, `src/styles/components`) so every existing
 * `token-usage-baseline.json` entry's `filePath` — and therefore its
 * identity — is unaffected by this function existing.
 */
export function defaultScanRoots(sourceRoot?: string): ScanRoot[] {
  const cinderSource = sourceRoot ?? componentsSource;
  const roots: ScanRoot[] = [
    {
      dir: join(cinderSource, 'components'),
      reportPrefix: 'src/components',
      componentsPrefix: 'src/components',
    },
  ];
  const sharedStylesRoot = join(cinderSource, 'styles', 'components');
  if (existsSync(sharedStylesRoot)) {
    roots.push({
      dir: sharedStylesRoot,
      reportPrefix: 'src/styles/components',
      componentsPrefix: null,
    });
  }
  if (sourceRoot) return roots;

  const workspaceRoot = resolve(componentsRoot, '..', '..');
  roots.push(
    {
      dir: join(workspaceRoot, 'components/chat/src/lib/components'),
      reportPrefix: 'chat/src/lib/components',
      componentsPrefix: 'chat/src/lib/components',
    },
    {
      dir: join(workspaceRoot, 'components/editor/src/lib/components'),
      reportPrefix: 'editor/src/lib/components',
      componentsPrefix: 'editor/src/lib/components',
    },
    {
      dir: join(workspaceRoot, 'scripts/browser-fixtures/src'),
      reportPrefix: 'scripts/browser-fixtures/src',
      componentsPrefix: null,
    },
  );
  return roots;
}

/** Scans every component style surface and classifies every `--cinder-*` reference. */
export async function scan(globals: Set<string>, roots: ScanRoot[]): Promise<TokenFlag[]> {
  const flags: TokenFlag[] = [];

  // Pass 1: collect, per component directory, every custom-property name that
  // component declares or sets (across ALL its files, including .svelte script +
  // markup). A reference to one of its OWN declared names is component-owned even
  // when the prefix is a shortened form of the directory name. `*.examples.json`
  // is excluded here — it is consumer-facing demo content, not a source of truth
  // a component "owns" a prefix from (see the module doc comment).
  const declaredByComponent = new Map<string, Set<string>>();
  for (const { dir, reportPrefix, componentsPrefix } of roots) {
    if (componentsPrefix === null) continue; // nothing owns a prefix in this root
    const glob = new Glob('**/*.{css,svelte,ts}');
    for await (const relativePath of glob.scan({ cwd: dir })) {
      if (isTestPath(relativePath) || isExamplesJsonPath(relativePath)) continue;
      const posix = `${reportPrefix}/${toPosixPath(relativePath)}`;
      const componentKey = componentDirKey(posix, componentsPrefix);
      if (!componentKey) continue;
      const declared = findDeclaredNames(await Bun.file(join(dir, relativePath)).text());
      if (declared.size === 0) continue;
      const existing = declaredByComponent.get(componentKey) ?? new Set<string>();
      for (const name of declared) existing.add(name);
      declaredByComponent.set(componentKey, existing);
    }
  }

  // Pass 2: classify every reference in .css / .svelte surfaces, AND every
  // `*.examples.json` example's embedded code (COR-344).
  for (const { dir, reportPrefix, componentsPrefix } of roots) {
    const glob = new Glob('**/*.{css,svelte,examples.json}');
    for await (const relativePath of glob.scan({ cwd: dir })) {
      if (isTestPath(relativePath)) continue;
      const posix = `${reportPrefix}/${toPosixPath(relativePath)}`;
      const ownedPrefixes =
        SHARED_PARTIAL_OWNED_PREFIXES[posix] ??
        (componentsPrefix === null
          ? []
          : ((p) => (p ? [p] : []))(componentOwnedPrefix(posix, componentsPrefix)));
      const componentKey =
        componentsPrefix === null ? null : componentDirKey(posix, componentsPrefix);
      const ownedDeclared =
        (componentKey && declaredByComponent.get(componentKey)) || new Set<string>();

      if (isExamplesJsonPath(relativePath)) {
        const rawSource = await Bun.file(join(dir, relativePath)).text();
        for (const { id, surface } of extractExamplesJsonSurfaces(rawSource)) {
          const stripped = stripCssComments(surface);
          for (const reference of findReferences(stripped)) {
            flags.push({
              filePath: `${posix}#${id}`,
              lineNumber: reference.lineNumber,
              name: reference.name,
              category: classifyReference(reference.name, ownedPrefixes, ownedDeclared, globals),
            });
          }
        }
        continue;
      }

      const rawSource = await Bun.file(join(dir, relativePath)).text();
      const surface = stripCssComments(
        extractStyleSurface(rawSource, relativePath.endsWith('.svelte')),
      );

      for (const reference of findReferences(surface)) {
        flags.push({
          filePath: posix,
          lineNumber: reference.lineNumber,
          name: reference.name,
          category: classifyReference(reference.name, ownedPrefixes, ownedDeclared, globals),
        });
      }
    }
  }
  return flags;
}

// ── Baseline (count-based, unresolved only) ─────────────────────────────────────

export type BaselineEntry = { filePath: string; name: string; allowedCount: number };

/** Identity key for an unresolved reference: file + token name. */
export function flagKey(flag: { filePath: string; name: string }): string {
  return `${flag.filePath}::${flag.name}`;
}

export function countByKey(flags: Array<{ filePath: string; name: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const flag of flags) {
    counts.set(flagKey(flag), (counts.get(flagKey(flag)) ?? 0) + 1);
  }
  return counts;
}

function isBaselineEntry(value: unknown): value is BaselineEntry {
  if (typeof value !== 'object' || value === null) return false;
  return (
    typeof (value as { filePath?: unknown }).filePath === 'string' &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { allowedCount?: unknown }).allowedCount === 'number'
  );
}

export function parseBaseline(parsed: unknown): Map<string, number> {
  if (!Array.isArray(parsed)) {
    throw new Error('baseline must be a JSON array of {filePath, name, allowedCount} entries.');
  }
  const allowed = new Map<string, number>();
  for (const entry of parsed) {
    if (!isBaselineEntry(entry)) {
      throw new Error(`invalid baseline entry: ${JSON.stringify(entry)}`);
    }
    allowed.set(flagKey(entry), entry.allowedCount);
  }
  return allowed;
}

export async function readBaseline(
  baselinePath: string = defaultBaselinePath,
): Promise<Map<string, number>> {
  const file = Bun.file(baselinePath);
  if (!(await file.exists())) return new Map();
  return parseBaseline(await file.json());
}

export function buildBaselineEntries(
  flags: Array<{ filePath: string; name: string }>,
): BaselineEntry[] {
  const counts = countByKey(flags);
  const byKey = new Map<string, BaselineEntry>();
  for (const flag of flags) {
    const key = flagKey(flag);
    if (!byKey.has(key)) {
      byKey.set(key, {
        filePath: flag.filePath,
        name: flag.name,
        allowedCount: counts.get(key) ?? 0,
      });
    }
  }
  return [...byKey.values()].toSorted(
    (a, b) => a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name),
  );
}

export type Regression = { filePath: string; name: string; allowed: number; found: number };

export function findRegressions(
  unresolvedFlags: Array<{ filePath: string; name: string }>,
  allowed: Map<string, number>,
): Regression[] {
  const counts = countByKey(unresolvedFlags);
  // Iterate the typed flags (deduped by key) so filePath/name keep their types —
  // no string-key re-parse. Matches the pattern used in check-component-css-raw-colors.ts.
  const seen = new Set<string>();
  const regressions: Regression[] = [];
  for (const flag of unresolvedFlags) {
    const key = flagKey(flag);
    if (seen.has(key)) continue;
    seen.add(key);
    const found = counts.get(key) ?? 0;
    const allowedCount = allowed.get(key) ?? 0;
    if (found > allowedCount) {
      regressions.push({ filePath: flag.filePath, name: flag.name, allowed: allowedCount, found });
    }
  }
  return regressions.toSorted(
    (a, b) => a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name),
  );
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function renderReport(flags: TokenFlag[]): string {
  const order: TokenCategory[] = ['unresolved', 'global', 'component-owned', 'private', 'runtime'];
  const byCategory = new Map<TokenCategory, TokenFlag[]>();
  for (const flag of flags) {
    const list = byCategory.get(flag.category) ?? [];
    list.push(flag);
    byCategory.set(flag.category, list);
  }
  let report = 'Token-usage audit — Cinder component styles\n\n';
  for (const category of order) {
    const list = byCategory.get(category) ?? [];
    report += `## ${category}: ${list.length} reference(s)\n`;
    if (category === 'unresolved') {
      for (const flag of list.toSorted(
        (a, b) => a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber,
      )) {
        report += `  ${flag.filePath}:${flag.lineNumber}  ${flag.name}\n`;
      }
    }
    report += '\n';
  }
  return report;
}

async function main(): Promise<void> {
  const strict = process.argv.includes('--strict');
  const updateBaseline = process.argv.includes('--update-baseline');
  const sourceRootArgumentIndex = process.argv.indexOf('--source-root');
  const sourceRootArgument =
    sourceRootArgumentIndex >= 0 ? process.argv[sourceRootArgumentIndex + 1] : undefined;
  if (sourceRootArgumentIndex >= 0 && sourceRootArgument === undefined) {
    throw new Error('--source-root requires a path argument');
  }
  const baselineArgumentIndex = process.argv.indexOf('--baseline');
  const baselineArgument =
    baselineArgumentIndex >= 0 ? process.argv[baselineArgumentIndex + 1] : undefined;
  if (baselineArgumentIndex >= 0 && baselineArgument === undefined) {
    throw new Error('--baseline requires a path argument');
  }
  const sourceRoot = sourceRootArgument ? resolve(process.cwd(), sourceRootArgument) : undefined;
  const baselinePath = baselineArgument
    ? resolve(process.cwd(), baselineArgument)
    : defaultBaselinePath;

  const globals = parseGlobalTokens(await Bun.file(tokenRegistryPath).text());
  const flags = await scan(globals, defaultScanRoots(sourceRoot));
  const unresolved = flags.filter((flag) => flag.category === 'unresolved');

  if (updateBaseline) {
    const entries = buildBaselineEntries(unresolved);
    await Bun.write(baselinePath, `${JSON.stringify(entries, null, 2)}\n`);
    process.stdout.write(`Wrote ${entries.length} baseline entries to ${baselinePath}\n`);
    return;
  }

  process.stdout.write(renderReport(flags));

  const allowed = await readBaseline(baselinePath);
  const baselineTotal = [...allowed.values()].reduce((sum, count) => sum + count, 0);
  const direction =
    unresolved.length > baselineTotal
      ? 'ABOVE'
      : unresolved.length < baselineTotal
        ? 'below'
        : 'at';
  process.stdout.write(
    `unresolved: ${unresolved.length} reference(s) — ${direction} baseline (${baselineTotal})\n`,
  );

  if (!strict) {
    process.exitCode = 0;
    return;
  }

  const regressions = findRegressions(unresolved, allowed);
  if (regressions.length > 0) {
    process.stderr.write(`\nNEW unresolved --cinder-* references (not in baseline):\n`);
    for (const regression of regressions) {
      process.stderr.write(
        `  ${regression.filePath}  ${regression.name}: found ${regression.found}, allowed ${regression.allowed}\n`,
      );
    }
    process.stderr.write(
      `\nDeclare the token in the DTCG corpus under src/tokens/, rename it to an existing token, use the ` +
        `component-owned prefix, or (after an intentional fix) run tokens:audit --update-baseline.\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}

if (import.meta.main) {
  await main();
}
