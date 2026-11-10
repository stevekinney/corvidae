/**
 * Cascade fingerprint for a stylesheet and everything it `@import`s.
 *
 * The fingerprint answers one question a refactor has to settle: did the CSS a consumer receives
 * change? It flattens the entry stylesheet (every `@import` replaced by the imported stylesheet,
 * wrapped in the `layer(…)`, `supports(…)`, and media condition the import named), drops comments,
 * and normalizes whitespace, so a comment or formatting edit leaves the value alone while a rule
 * edit, a reordered rule, or a different cascade layer changes it.
 *
 * Usage (from `components/cinder`):
 *
 * ```sh
 * bun scripts/css-fingerprint.ts [entry.css …]                 # a hash of the ordered flattened CSS
 * bun scripts/css-fingerprint.ts --rules [entry.css …]         # every rule, in cascade order
 * bun scripts/css-fingerprint.ts --rule-multiset [entry.css …] # the same lines, sorted
 * bun scripts/css-fingerprint.ts --package-root <dir> …        # fingerprint another checkout's package
 * ```
 *
 * With no entry the command flattens both package entries, `src/styles/all.css` (the full cascade
 * aggregator) and `src/styles/index.css` (the base the root entry imports), and prints a value for
 * each under a `# <entry>` heading. The hash mode also prints the SHA-256 of every resolved theme
 * JSON (`src/tokens/resolved/*.json`), the data the generated token stylesheets come from.
 * `--rules` is the order check (diff it before and after); `--rule-multiset` ignores order, so a
 * diff of it lists exactly the rules that were added or removed.
 *
 * The flattening is separable from the file system: {@link flattenStylesheet} takes a resolver, so
 * the playground's parity script flattens stylesheets by URL with the same code.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { parse, type AtRule, type ChildNode, type Container, type Rule } from 'postcss';

/** A stylesheet's identity (a path or a URL, as the resolver defines it) and its text. */
export type StylesheetSource = { id: string; source: string };

/**
 * Resolves an `@import` specifier written in `importerId` to the stylesheet it names, or
 * `undefined` for one that cannot be followed (a remote URL, a missing file). An unresolved import
 * stays in the flattened output as the statement it was.
 */
export type ImportResolver = (
  specifier: string,
  importerId: string,
) => StylesheetSource | undefined;

/** A normalized node of flattened CSS. Comments never appear. */
export type CssNode =
  | { kind: 'statement'; text: string }
  | { kind: 'declaration'; text: string }
  | { kind: 'block'; header: string; children: CssNode[] };

/** What flattening a stylesheet produced. */
export type FlattenedStylesheet = {
  nodes: CssNode[];
  /** Every stylesheet the entry reached, the entry included, in first-visit order. */
  visited: string[];
  /** Stylesheets that contain no resolvable `@import`, in first-visit order. */
  leaves: string[];
};

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();
const normalizeList = (text: string): string => collapse(text).replace(/\s*,\s*/g, ',');

type ImportClauses = {
  specifier: string;
  layer: string | undefined;
  supports: string | undefined;
  media: string;
};

/** The text inside the balanced parentheses that open at `open`, and the index after them. */
function balanced(text: string, open: number): { inner: string; end: number } | undefined {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(open + 1, index), end: index + 1 };
    }
  }
  return undefined;
}

/** Split the parameters of an `@import` into its specifier and its layer, supports, and media. */
function parseImport(params: string): ImportClauses | undefined {
  const head =
    /^\s*(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)|"([^"]*)"|'([^']*)')\s*/s.exec(params);
  if (head === null) return undefined;
  const specifier = head[1] ?? head[2] ?? head[3] ?? head[4] ?? head[5] ?? '';
  let rest = params.slice(head[0].length);
  let layer: string | undefined;
  let supports: string | undefined;
  for (;;) {
    const clause = /^(layer|supports)\b\s*/i.exec(rest);
    if (clause === null) break;
    const keyword = clause[1]!.toLowerCase();
    const afterKeyword = rest.slice(clause[0].length);
    if (afterKeyword.startsWith('(')) {
      const group = balanced(afterKeyword, 0);
      if (group === undefined) break;
      if (keyword === 'layer') layer = collapse(group.inner);
      else supports = collapse(group.inner);
      rest = afterKeyword.slice(group.end).trimStart();
    } else if (keyword === 'layer') {
      layer = '';
      rest = afterKeyword;
    } else {
      break;
    }
  }
  return { specifier, layer, supports, media: collapse(rest) };
}

/** Wrap imported nodes in the conditions the `@import` carried. */
function wrapImported(nodes: CssNode[], clauses: ImportClauses): CssNode[] {
  let wrapped = nodes;
  if (clauses.media !== '') {
    wrapped = [{ kind: 'block', header: `@media ${clauses.media}`, children: wrapped }];
  }
  if (clauses.supports !== undefined) {
    wrapped = [{ kind: 'block', header: `@supports ${clauses.supports}`, children: wrapped }];
  }
  if (clauses.layer !== undefined) {
    const header = clauses.layer === '' ? '@layer' : `@layer ${clauses.layer}`;
    wrapped = [{ kind: 'block', header, children: wrapped }];
  }
  return wrapped;
}

/** The specifier of every top-level or nested `@import` in a stylesheet, in source order. */
export function importSpecifiersOf(source: string): string[] {
  const specifiers: string[] = [];
  parse(source).walkAtRules('import', (atRule) => {
    const clauses = parseImport(atRule.params);
    if (clauses !== undefined) specifiers.push(clauses.specifier);
  });
  return specifiers;
}

/**
 * Flatten `entry`, following every `@import` the resolver can resolve. An import cycle is followed
 * once; the repeat is dropped, as a browser drops it.
 */
export function flattenStylesheet(
  entry: StylesheetSource,
  resolveImport: ImportResolver,
): FlattenedStylesheet {
  const visited: string[] = [];
  const leaves: string[] = [];

  function normalizeChildren(
    container: Container,
    importerId: string,
    stack: readonly string[],
    state: { resolvedImports: number },
  ): CssNode[] {
    const nodes: CssNode[] = [];
    for (const child of container.nodes as ChildNode[]) {
      nodes.push(...normalizeNode(child, importerId, stack, state));
    }
    return nodes;
  }

  function normalizeNode(
    node: ChildNode,
    importerId: string,
    stack: readonly string[],
    state: { resolvedImports: number },
  ): CssNode[] {
    if (node.type === 'comment') return [];
    if (node.type === 'decl') {
      const important = node.important ? '!important' : '';
      return [{ kind: 'declaration', text: `${node.prop}:${collapse(node.value)}${important}` }];
    }
    if (node.type === 'rule') {
      const rule: Rule = node;
      return [
        {
          kind: 'block',
          header: normalizeList(rule.selector),
          children: normalizeChildren(rule, importerId, stack, state),
        },
      ];
    }
    const atRule: AtRule = node;
    if (atRule.name.toLowerCase() === 'import') {
      const clauses = parseImport(atRule.params);
      const imported =
        clauses === undefined ? undefined : resolveImport(clauses.specifier, importerId);
      if (clauses === undefined || imported === undefined) {
        return [{ kind: 'statement', text: `@import ${normalizeList(atRule.params)}` }];
      }
      if (stack.includes(imported.id)) return [];
      state.resolvedImports += 1;
      return wrapImported(flatten(imported, [...stack, imported.id]), clauses);
    }
    const header = normalizeList(`@${atRule.name} ${atRule.params}`);
    if (atRule.nodes === undefined) return [{ kind: 'statement', text: header }];
    return [
      { kind: 'block', header, children: normalizeChildren(atRule, importerId, stack, state) },
    ];
  }

  function flatten(source: StylesheetSource, stack: readonly string[]): CssNode[] {
    if (!visited.includes(source.id)) visited.push(source.id);
    const state = { resolvedImports: 0 };
    const nodes = normalizeChildren(
      parse(source.source, { from: source.id }),
      source.id,
      stack,
      state,
    );
    if (state.resolvedImports === 0 && !leaves.includes(source.id)) leaves.push(source.id);
    return nodes;
  }

  return { nodes: flatten(entry, [entry.id]), visited, leaves };
}

function serializeNode(node: CssNode): string {
  if (node.kind === 'statement' || node.kind === 'declaration') return `${node.text};`;
  return `${node.header}{${node.children.map(serializeNode).join('')}}`;
}

/** The canonical text of flattened CSS: no comments, normalized whitespace, cascade order kept. */
export function serializeFlattened(nodes: readonly CssNode[]): string {
  return nodes.map(serializeNode).join('\n');
}

/** SHA-256 of the canonical flattened text. */
export function fingerprintNodes(nodes: readonly CssNode[]): string {
  return createHash('sha256').update(serializeFlattened(nodes)).digest('hex');
}

/**
 * Every rule of flattened CSS as one line, in cascade order: the at-rules that enclose it, then the
 * rule itself. A block of declarations (`@font-face`) is one line; a block of rules (`@layer`,
 * `@media`) is not, its rules are.
 */
export function ruleLines(nodes: readonly CssNode[], context: readonly string[] = []): string[] {
  const lines: string[] = [];
  const prefix = context.length === 0 ? '' : `${context.join(' > ')} :: `;
  for (const node of nodes) {
    if (node.kind === 'statement') {
      lines.push(`${prefix}${node.text};`);
    } else if (node.kind === 'declaration') {
      lines.push(`${prefix}${node.text};`);
    } else if (node.children.some((child) => child.kind === 'declaration')) {
      lines.push(`${prefix}${serializeNode(node)}`);
    } else {
      lines.push(...ruleLines(node.children, [...context, node.header]));
    }
  }
  return lines;
}

/** The rules of flattened CSS, sorted: stable under reordering, so a diff lists additions and removals. */
export function ruleMultiset(nodes: readonly CssNode[]): string[] {
  return ruleLines(nodes).toSorted();
}

/**
 * A resolver over the file system. `./` and `../` specifiers are relative to the importer, `/` is
 * an absolute path, and anything else is a package specifier (`@scope/pkg/styles`) resolved the way
 * a bundler resolves it, falling back to a path relative to the importer.
 */
export function fileResolver(): ImportResolver {
  return (specifier, importerId) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(specifier) && !isAbsolute(specifier)) return undefined;
    const importerDirectory = dirname(importerId);
    let path: string | undefined;
    if (specifier.startsWith('.')) path = resolve(importerDirectory, specifier);
    else if (isAbsolute(specifier)) path = specifier;
    else {
      try {
        path = Bun.resolveSync(specifier, importerDirectory);
      } catch {
        path = resolve(importerDirectory, specifier);
      }
    }
    if (!existsSync(path)) return undefined;
    return { id: path, source: readFileSync(path, 'utf8') };
  };
}

/** Flatten a stylesheet on disk. */
export function flattenFile(entryPath: string): FlattenedStylesheet {
  const path = resolve(entryPath);
  return flattenStylesheet({ id: path, source: readFileSync(path, 'utf8') }, fileResolver());
}

/** The entries the command flattens when it is given none. */
export const DEFAULT_ENTRIES = [
  join('src', 'styles', 'all.css'),
  join('src', 'styles', 'index.css'),
];

/** Where the resolved theme JSON lives, relative to the package root. */
const RESOLVED_THEME_DIRECTORY = join('src', 'tokens', 'resolved');

/** The SHA-256 of every resolved theme JSON of a package, as `path hash` lines sorted by path. */
export function themeJsonHashes(packageRoot: string): string[] {
  const directory = resolve(packageRoot, RESOLVED_THEME_DIRECTORY);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .toSorted()
    .map((name) => {
      const bytes = readFileSync(join(directory, name));
      return `${join(RESOLVED_THEME_DIRECTORY, name)} ${createHash('sha256').update(bytes).digest('hex')}`;
    });
}

/** The command line, as a pure function of its arguments so a test can run it. */
export function runFingerprintCommand(argv: readonly string[], defaultPackageRoot: string): string {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      rules: { type: 'boolean', default: false },
      'rule-multiset': { type: 'boolean', default: false },
      'package-root': { type: 'string' },
    },
  });
  const packageRoot = resolve(values['package-root'] ?? defaultPackageRoot);
  const entries = positionals.length === 0 ? DEFAULT_ENTRIES : positionals;
  const lines: string[] = [];
  for (const entry of entries) {
    const { nodes } = flattenFile(resolve(packageRoot, entry));
    lines.push(`# ${entry}`);
    if (values.rules) lines.push(...ruleLines(nodes));
    else if (values['rule-multiset']) lines.push(...ruleMultiset(nodes));
    else lines.push(fingerprintNodes(nodes));
  }
  if (!values.rules && !values['rule-multiset']) {
    lines.push('# resolved theme JSON', ...themeJsonHashes(packageRoot));
  }
  return `${lines.join('\n')}\n`;
}

if (import.meta.main) {
  process.stdout.write(runFingerprintCommand(process.argv.slice(2), join(import.meta.dir, '..')));
}
