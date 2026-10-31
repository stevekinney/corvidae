/**
 * Fails when Interborough's visible words or app styles break the interface rules the redesign set
 * (COR-1838; index rows 09b, 09f, 15a, 15i, 15j, 15q, 18b, 24c). Run from the package directory, as
 * `lint` does:
 *
 *   bun scripts/check-interface-rules.ts
 *
 * The check reads two kinds of source.
 *
 * Copy: every `src/**\/*.svelte` and `src/**\/*.ts` that is not a test, a harness, or under
 * `src/host` or `src/mcp-apps`. A TypeScript module counts because the sentences a page shows live
 * in them (`src/app/copy.ts`, a status table, a scope catalog). A string counts as visible when it
 * is template text, a mustache, a text attribute, an argument to `{@render}`, a `{@const}`, or, in a
 * script or module, a string that reads as prose (it has a space or starts with a capital letter).
 * A string compared with `===`, `in` or `case` is a key, not copy, and is skipped. The copy rules
 * are:
 *
 * - `product-word`: Engine and Bureau are internal names, not words a person using the product
 *   knows. A scope or package name such as `bureau.memory:write` is an identifier and passes.
 * - `issue-reference`: a COR number, `repository#123`, or a maintainer.
 * - `lowercase-acronym`: an acronym from Cinder's `IDENTIFIER_ACRONYMS` (read from Cinder's
 *   source, not copied) that is not in its canonical spelling.
 * - `api-documentation`: a string with `ctx.`, a backticked code identifier, "worker binding" or
 *   "task queue routing" explains the API, and the product says what a person can do instead.
 * - `large-size`: `size="lg"` is for a page's primary action, so every use is listed with a reason.
 * - `empty-state-title`: an `EmptyState` without a `title`.
 *
 * Styles: every `.css` under `src` and every component `<style>`, including nested rules.
 *
 * - `app-header-class`: a class ending in `__header` or `-header` is a page or panel header built
 *   from app CSS where Cinder's `PageHeader` and `Card` belong.
 * - `cinder-selector`: a selector that names a `.cinder-` class, or the class list by prefix
 *   (`[class*='cinder-']`), reaches into Cinder's markup.
 * - `uppercase-label`: a rule that sets `text-transform: uppercase` with letter spacing.
 *
 * A violation passes only through one of two lists in `tests/`, and each is enforced both ways: a
 * listed entry that no longer violates fails (remove it), and an unlisted violation fails.
 *
 * - `interface-lint-allowlist.json`: a deliberate exception, with a `reason`.
 * - `interface-lint-pending.json`: a violation inside a panel a page issue rewrites, with the
 *   `issue` that owns it. The list can only shrink; adding an entry is a reviewed edit.
 *
 * The exports below serve `scripts/check-interface-rules.test.ts`, `tests/interface-lint.test.ts`
 * and `tests/empty-state-kinds.test.ts`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { parse } from 'svelte/compiler';

import { IDENTIFIER_ACRONYMS } from '../../../components/cinder/src/utilities/humanize-identifier.ts';

/** The rules this check enforces. */
export type InterfaceRule =
  | 'product-word'
  | 'issue-reference'
  | 'lowercase-acronym'
  | 'api-documentation'
  | 'large-size'
  | 'empty-state-title'
  | 'app-header-class'
  | 'cinder-selector'
  | 'uppercase-label';

/** One breach: the rule, where it is, and the thing that breaks it. */
export type InterfaceViolation = {
  readonly rule: InterfaceRule;
  /** The path from the package root, with forward slashes. */
  readonly file: string;
  /** What breaks the rule: the matched words, the class, the selector. It keys the entry lists. */
  readonly subject: string;
  readonly line: number;
};

/** One line of `interface-lint-allowlist.json` or `interface-lint-pending.json`. */
export type InterfaceEntry = {
  readonly rule: InterfaceRule;
  readonly file: string;
  readonly subject: string;
  readonly reason?: string;
  readonly issue?: string;
};

type AstNode = {
  type: string;
  start?: number;
  end?: number;
  data?: unknown;
  name?: unknown;
  value?: unknown;
  expression?: unknown;
  operator?: unknown;
  attributes?: unknown;
  content?: unknown;
  declaration?: unknown;
  quasis?: unknown;
  consequent?: unknown;
  alternate?: unknown;
  left?: unknown;
  right?: unknown;
  [key: string]: unknown;
};

const PACKAGE_ROOT = join(import.meta.dir, '..');

/** Where each list lives, relative to the package root. */
export const ALLOWLIST_PATH = 'tests/interface-lint-allowlist.json';
export const PENDING_PATH = 'tests/interface-lint-pending.json';

/** Source the copy rules do not read: the host runs on a server, and the MCP apps are other pages. */
const SKIPPED_DIRECTORIES = ['src/host/', 'src/mcp-apps/'];
const SKIPPED_FILE = /\.test[.-]|harness/;

/** Attributes whose string is never words a person reads. */
const NON_COPY_ATTRIBUTES = new Set([
  'class',
  'id',
  'href',
  'src',
  'srcset',
  'type',
  'name',
  'for',
  'role',
  'style',
  'rel',
  'target',
  'method',
  'action',
  'value',
  'variant',
  'size',
  'tone',
  'kind',
  'slot',
  'key',
  'autocomplete',
  'inputmode',
  'width',
  'height',
  'viewBox',
  'd',
  'fill',
  'stroke',
  'tag',
  'level',
  'this',
  'language',
  'view',
  'mode',
  'format',
]);

/** Attributes that always carry words, so a single lowercase word in one still counts. */
const COPY_ATTRIBUTES = new Set([
  'title',
  'aria-label',
  'aria-description',
  'placeholder',
  'alt',
  'label',
  'description',
  'text',
  'heading',
  'message',
  'hint',
  'trigger',
  'summary',
]);

const ACRONYMS = new Map<string, string>(
  IDENTIFIER_ACRONYMS.map((acronym) => [acronym.toLowerCase(), acronym]),
);
const ACRONYM_PATTERN = new RegExp(
  `(?<![\\w.:/@#$-])(${[...ACRONYMS.keys()]
    .toSorted((a, b) => b.length - a.length)
    .map((acronym) => acronym.replace(/[-]/g, '\\-'))
    .join('|')})(?![\\w@#$/-]|\\.\\w|:[\\w/])`,
  'gi',
);
const PRODUCT_WORD_PATTERN =
  /(?<![\w.:/@#-])(engine|bureau)(?:s|['’]s)?(?!\w|\.[A-Za-z]|:[A-Za-z])/gi;
const ISSUE_PATTERNS = [
  /\bCOR-\d+\b/g,
  /\bGH-\d+\b/g,
  /\b[A-Za-z][\w-]*#\d+\b/g,
  /\bmaintainers?\b/gi,
  /\bissue\s+#\d+\b/gi,
];
const API_DOCUMENTATION_PATTERNS = [
  /\bctx\./g,
  /`[^`\n]+`/g,
  /\bworker binding\b/gi,
  /\btask queue routing\b/gi,
];

const HEADER_CLASS_PATTERN = /\.((?:[\w-]*)(?:__|-)header)(?![\w-])/g;
const CINDER_CLASS_PATTERN = /\.(cinder-[\w-]+)/g;
/** An attribute selector on the class list that names Cinder's prefix: `[class*='cinder-']`. */
const CINDER_ATTRIBUTE_PATTERN = /\[\s*class\s*[~|^$*]?=\s*(["']?)cinder-[^\]"']*\1\s*[is]?\s*\]/g;

/** The path of `file` from `root`, with forward slashes. */
function relativePath(root: string, file: string): string {
  return relative(root, file).split('\\').join('/');
}

/** Every file under `directory` that `accept` admits, as absolute paths in a stable order. */
function filesUnder(directory: string, accept: (path: string) => boolean): string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path, accept));
    else if (accept(path)) found.push(path);
  }
  return found.toSorted();
}

/**
 * The source files whose words a person reads: every Svelte file and every TypeScript module under
 * `src` that is not a test, a harness, the host or an MCP app. A module such as
 * `src/lib/system-lease.ts` holds sentences the page renders, and `src/app/copy.ts` is one of them.
 */
export function copyFiles(root: string): string[] {
  return filesUnder(join(root, 'src'), (path) => {
    if (SKIPPED_FILE.test(path) || path.endsWith('.d.ts')) return false;
    if (!path.endsWith('.svelte') && !path.endsWith('.ts')) return false;
    const relativeToRoot = relativePath(root, path);
    return !SKIPPED_DIRECTORIES.some((directory) => relativeToRoot.startsWith(directory));
  });
}

/** The stylesheets of the app: `src/styles` and the stylesheets that sit beside a route. */
export function styleFiles(root: string): string[] {
  return filesUnder(join(root, 'src'), (path) => path.endsWith('.css') && !SKIPPED_FILE.test(path));
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as AstNode).type === 'string';
}

/** A string literal or template piece, with where it starts. */
type Piece = {
  readonly text: string;
  readonly offset: number;
  readonly always: boolean;
  /** Text of a `<code>`, `<pre>` or `<kbd>`: an identifier, judged only as API documentation. */
  readonly code?: boolean;
};

const CODE_ELEMENTS = new Set(['code', 'pre', 'kbd']);

const COMPARISON_OPERATORS = new Set(['===', '!==', '==', '!=', 'in']);

/** Whether a string in an expression reads as prose: it has a space or opens with a capital. */
function readsAsProse(text: string): boolean {
  return /\s/.test(text.trim()) || /^[A-Z]/.test(text.trim());
}

/**
 * The strings an expression or program holds that could be copy. A string a comparison, a `case`,
 * an import or an object key holds is a name, not words, and is left out.
 */
function collectStrings(root: unknown, offsetBase: number, always: boolean): Piece[] {
  const pieces: Piece[] = [];
  const visit = (value: unknown, skip: boolean): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, skip);
      return;
    }
    if (!isNode(value)) return;
    const node = value;
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') return;
    if (node.type === 'Literal' && typeof node.value === 'string' && !skip) {
      pieces.push({ text: node.value, offset: (node.start ?? 0) + offsetBase, always });
      return;
    }
    if (node.type === 'TemplateElement' && !skip) {
      const cooked = (node.value as { cooked?: string | null } | undefined)?.cooked;
      if (typeof cooked === 'string') {
        pieces.push({ text: cooked, offset: (node.start ?? 0) + offsetBase, always });
      }
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'loc') continue;
      if (node.type === 'BinaryExpression' && COMPARISON_OPERATORS.has(node.operator as string)) {
        if (key === 'left' || key === 'right') {
          visit(child, true);
          continue;
        }
      }
      if (node.type === 'SwitchCase' && key === 'test') continue;
      if (node.type === 'Property' && key === 'key') continue;
      if (node.type === 'MemberExpression' && key === 'property') continue;
      if (node.type === 'TSLiteralType' || node.type === 'TSEnumMember') continue;
      visit(child, skip);
    }
  };
  visit(root, false);
  return pieces;
}

/** Walks a template fragment, handing back the words it shows. */
function collectTemplatePieces(fragment: unknown): Piece[] {
  const pieces: Piece[] = [];
  const visit = (value: unknown, code = false): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, code);
      return;
    }
    if (!isNode(value)) return;
    const node = value;
    if (node.type === 'Comment') return;
    if (node.type === 'Text') {
      const text = node.data as string;
      if (text.trim() !== '') pieces.push({ text, offset: node.start ?? 0, always: true, code });
      return;
    }
    if (node.type === 'ExpressionTag' || node.type === 'RenderTag') {
      // `{@render row('Engine down')}` hands its arguments to a snippet that shows them.
      pieces.push(...collectStrings(node.expression, 0, false));
      return;
    }
    if (node.type === 'ConstTag') {
      pieces.push(...collectStrings(node.declaration, 0, false));
      return;
    }
    if (node.type === 'Attribute') {
      pieces.push(...attributePieces(node));
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'metadata') continue;
      if (key === 'expression' || key === 'test') {
        pieces.push(...collectStrings(child, 0, false));
        continue;
      }
      visit(
        child,
        code || (node.type === 'RegularElement' && CODE_ELEMENTS.has(node.name as string)),
      );
    }
  };
  visit(fragment);
  return pieces;
}

function attributePieces(node: AstNode): Piece[] {
  const name = node.name as string;
  if (
    NON_COPY_ATTRIBUTES.has(name) ||
    name.startsWith('data-') ||
    /^aria-(?!label$|description$)/.test(name)
  ) {
    return [];
  }
  const always = COPY_ATTRIBUTES.has(name);
  const value = node.value;
  if (value === true) return [];
  const parts = Array.isArray(value) ? value : [value];
  const pieces: Piece[] = [];
  for (const part of parts) {
    if (!isNode(part)) continue;
    if (part.type === 'Text') {
      pieces.push({ text: part.data as string, offset: part.start ?? 0, always });
    } else if (part.type === 'ExpressionTag') {
      pieces.push(...collectStrings(part.expression, 0, always));
    }
  }
  return pieces;
}

/** Every `<EmptyState>` and `size="lg"` in a template, with the attributes it passes. */
type Usage = {
  readonly offset: number;
  readonly names: ReadonlySet<string>;
  readonly spread: boolean;
};

function collectElements(fragment: unknown, wanted: (name: string) => boolean): Usage[] {
  const usages: Usage[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isNode(value)) return;
    const node = value;
    const name = node.name as string | undefined;
    if (
      (node.type === 'Component' || node.type === 'RegularElement') &&
      name !== undefined &&
      wanted(name)
    ) {
      const attributes = (node.attributes as AstNode[] | undefined) ?? [];
      usages.push({
        offset: node.start ?? 0,
        names: new Set(
          attributes.filter((a) => a.type === 'Attribute').map((a) => a.name as string),
        ),
        spread: attributes.some((a) => a.type === 'SpreadAttribute'),
      });
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'metadata') continue;
      visit(child);
    }
  };
  visit(fragment);
  return usages;
}

type ParsedSource = {
  readonly pieces: Piece[];
  readonly fragment: unknown;
  /** The text of the component's `<style>` and where it starts in the file. */
  readonly style?: { readonly text: string; readonly start: number } | undefined;
};

/** Parses a Svelte file, or `copy.ts` as the script of one, into the words it holds. */
function parseSource(file: string, text: string): ParsedSource {
  const isCopyModule = file.endsWith('.ts');
  const wrapper = '<script lang="ts">';
  const source = isCopyModule ? `${wrapper}${text}</script>` : text;
  const ast = parse(source, { modern: true }) as unknown as {
    fragment: unknown;
    instance?: AstNode;
    module?: AstNode;
    css?: { content: { start: number; styles: string } } | null;
  };
  const shift = isCopyModule ? wrapper.length : 0;
  const pieces: Piece[] = [];
  for (const script of [ast.instance, ast.module]) {
    if (script === undefined) continue;
    for (const piece of collectStrings(script.content, 0, false)) {
      pieces.push({ ...piece, offset: piece.offset - shift });
    }
  }
  if (!isCopyModule) pieces.push(...collectTemplatePieces(ast.fragment));
  const style = ast.css
    ? { text: ast.css.content.styles, start: ast.css.content.start }
    : undefined;
  return { pieces, fragment: ast.fragment, style };
}

function matchesOf(pattern: RegExp, text: string): string[] {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))].map((match) => match[0]);
}

/** The copy rules a single string breaks, as `[rule, subject]` pairs. */
function copyRulesFor(text: string, code: boolean): Array<[InterfaceRule, string]> {
  const found: Array<[InterfaceRule, string]> = [];
  if (code) {
    for (const pattern of API_DOCUMENTATION_PATTERNS) {
      for (const documentation of matchesOf(pattern, text)) {
        found.push(['api-documentation', documentation]);
      }
    }
    return found;
  }
  for (const word of matchesOf(PRODUCT_WORD_PATTERN, text)) found.push(['product-word', word]);
  for (const pattern of ISSUE_PATTERNS) {
    for (const reference of matchesOf(pattern, text)) found.push(['issue-reference', reference]);
  }
  for (const match of text.matchAll(new RegExp(ACRONYM_PATTERN.source, ACRONYM_PATTERN.flags))) {
    const canonical = ACRONYMS.get(match[1]!.toLowerCase());
    if (canonical !== undefined && match[1] !== canonical) {
      found.push(['lowercase-acronym', match[1]!]);
    }
  }
  for (const pattern of API_DOCUMENTATION_PATTERNS) {
    for (const documentation of matchesOf(pattern, text)) {
      found.push(['api-documentation', documentation]);
    }
  }
  return found;
}

/** One `<EmptyState>` in the app: where it is, and whether it passes a `title` and a `kind`. */
export type EmptyStateUsage = {
  readonly file: string;
  readonly line: number;
  readonly hasTitle: boolean;
  readonly hasKind: boolean;
};

/** Every `<EmptyState>` in the app's Svelte files. A spread attribute may carry either prop. */
export function emptyStateUsages(root: string = PACKAGE_ROOT): EmptyStateUsage[] {
  return copyFiles(root)
    .filter((file) => file.endsWith('.svelte'))
    .flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      const { fragment } = parseSource(file, text);
      return collectElements(fragment, (name) => name === 'EmptyState').map((usage) => ({
        file: relativePath(root, file),
        line: lineAt(text, usage.offset),
        hasTitle: usage.names.has('title') || usage.spread,
        hasKind: usage.names.has('kind') || usage.spread,
      }));
    });
}

/** The violations in one copy file. */
export function copyViolations(root: string, file: string): InterfaceViolation[] {
  const text = readFileSync(file, 'utf8');
  const path = relativePath(root, file);
  const { pieces, fragment, style } = parseSource(file, text);
  const violations: InterfaceViolation[] = [];
  for (const piece of pieces) {
    const collapsed = piece.text.replace(/\s+/g, ' ').trim();
    if (collapsed === '' || (!piece.always && !readsAsProse(collapsed))) continue;
    for (const [rule, subject] of copyRulesFor(collapsed, piece.code === true)) {
      violations.push({ rule, file: path, subject, line: lineAt(text, piece.offset) });
    }
  }
  if (!file.endsWith('.svelte')) return violations;
  const styled = style === undefined ? [] : cssViolations(path, style.text, text, style.start);
  return [...violations, ...templateViolations(path, text, fragment), ...styled];
}

function templateViolations(path: string, text: string, fragment: unknown): InterfaceViolation[] {
  const violations: InterfaceViolation[] = [];
  for (const usage of collectElements(fragment, (name) => name === 'EmptyState')) {
    if (!usage.names.has('title') && !usage.spread) {
      violations.push({
        rule: 'empty-state-title',
        file: path,
        subject: '<EmptyState>',
        line: lineAt(text, usage.offset),
      });
    }
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isNode(value)) return;
    if (value.type === 'Attribute' && value.name === 'size' && isLarge(value.value)) {
      violations.push({
        rule: 'large-size',
        file: path,
        subject: 'size="lg"',
        line: lineAt(text, value.start ?? 0),
      });
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'start' && key !== 'end' && key !== 'metadata') visit(child);
    }
  };
  visit(fragment);
  return violations;
}

function isLarge(value: unknown): boolean {
  const parts = Array.isArray(value) ? value : [value];
  return parts.some((part) => {
    if (!isNode(part)) return false;
    if (part.type === 'Text') return (part.data as string).trim() === 'lg';
    return yieldsLarge(part.expression);
  });
}

/** Whether an expression can evaluate to `'lg'`: the literal, or a branch of a choice between values. */
function yieldsLarge(expression: unknown): boolean {
  if (!isNode(expression)) return false;
  switch (expression.type) {
    case 'Literal':
      return expression.value === 'lg';
    case 'TemplateLiteral': {
      const quasis = expression.quasis as AstNode[] | undefined;
      return (
        quasis?.length === 1 &&
        (quasis[0]?.value as { cooked?: string } | undefined)?.cooked === 'lg'
      );
    }
    case 'ConditionalExpression':
      return yieldsLarge(expression.consequent) || yieldsLarge(expression.alternate);
    case 'LogicalExpression':
      return yieldsLarge(expression.left) || yieldsLarge(expression.right);
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
      return yieldsLarge(expression.expression);
    default:
      return false;
  }
}

/** One style rule: its selector text, its declarations and where it starts. */
type StyleRule = { readonly selector: string; readonly body: string; readonly offset: number };

const SKIPPED_AT_RULES = /^@(?:keyframes|font-face|-webkit-keyframes|property|counter-style)/;

/** A rule body without the blocks nested in it, so its declarations are its own. */
function withoutNestedBlocks(body: string): string {
  let depth = 0;
  let own = '';
  for (const character of body) {
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    else if (depth === 0) own += character;
  }
  return own;
}

/** The style rules of a stylesheet, descending through `@media` and the other grouping rules. */
function styleRules(css: string): StyleRule[] {
  const rules: StyleRule[] = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
  const walk = (from: number, to: number): void => {
    let cursor = from;
    while (cursor < to) {
      const open = stripped.indexOf('{', cursor);
      const semicolon = stripped.indexOf(';', cursor);
      if (open === -1 || open >= to) return;
      if (semicolon !== -1 && semicolon < open) {
        cursor = semicolon + 1;
        continue;
      }
      let depth = 1;
      let close = open + 1;
      while (close < to && depth > 0) {
        const character = stripped[close];
        if (character === '{') depth += 1;
        else if (character === '}') depth -= 1;
        close += 1;
      }
      const selector = stripped.slice(cursor, open).trim();
      if (selector.startsWith('@')) {
        if (!SKIPPED_AT_RULES.test(selector)) walk(open + 1, close - 1);
      } else {
        const leading =
          stripped.slice(cursor, open).length - stripped.slice(cursor, open).trimStart().length;
        const body = stripped.slice(open + 1, close - 1);
        rules.push({ selector, body: withoutNestedBlocks(body), offset: cursor + leading });
        // A rule can nest rules (`.a { .b { } }`, `& .b`) and at-rules, which are rules too.
        if (body.includes('{')) walk(open + 1, close - 1);
      }
      cursor = close;
    }
  };
  walk(0, stripped.length);
  return rules;
}

function hasUppercaseLabel(body: string): boolean {
  if (!/text-transform\s*:\s*uppercase/.test(body)) return false;
  const spacing = /letter-spacing\s*:\s*([^;]+)/.exec(body);
  if (spacing === null) return false;
  const value = spacing[1]!.trim();
  return value !== 'normal' && !/^0(?:\.0+)?(?:px|em|rem)?$/.test(value);
}

/** The violations in one stylesheet. */
export function styleViolations(root: string, file: string): InterfaceViolation[] {
  const css = readFileSync(file, 'utf8');
  return cssViolations(relativePath(root, file), css, css, 0);
}

/** The violations in CSS that starts `base` characters into `source`, which names the lines. */
function cssViolations(
  path: string,
  css: string,
  source: string,
  base: number,
): InterfaceViolation[] {
  const seen = new Set<string>();
  const violations: InterfaceViolation[] = [];
  const add = (rule: InterfaceRule, subject: string, offset: number): void => {
    const key = `${rule}\0${subject}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ rule, file: path, subject, line: lineAt(source, base + offset) });
  };
  for (const rule of styleRules(css)) {
    for (const match of rule.selector.matchAll(HEADER_CLASS_PATTERN)) {
      if (!match[1]!.startsWith('cinder-')) add('app-header-class', `.${match[1]!}`, rule.offset);
    }
    for (const match of rule.selector.matchAll(CINDER_CLASS_PATTERN)) {
      add('cinder-selector', `.${match[1]!}`, rule.offset);
    }
    for (const match of rule.selector.matchAll(CINDER_ATTRIBUTE_PATTERN)) {
      add('cinder-selector', match[0].replace(/\s+/g, ''), rule.offset);
    }
    if (hasUppercaseLabel(rule.body)) {
      add('uppercase-label', rule.selector.replace(/\s+/g, ' '), rule.offset);
    }
  }
  return violations;
}

/** Every violation in the package, sorted by file, line and rule. */
export function collectViolations(root: string = PACKAGE_ROOT): InterfaceViolation[] {
  const violations = [
    ...copyFiles(root).flatMap((file) => copyViolations(root, file)),
    ...styleFiles(root).flatMap((file) => styleViolations(root, file)),
  ];
  return violations.toSorted(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule),
  );
}

/** The key two records share when they name the same breach. */
export function entryKey(entry: Pick<InterfaceEntry, 'rule' | 'file' | 'subject'>): string {
  return `${entry.rule}\0${entry.file}\0${entry.subject}`;
}

/** What a list has to say about the violations found. */
export type Reconciliation = {
  /** Violations no entry covers. */
  readonly unlisted: InterfaceViolation[];
  /** Entries that no longer match a violation, which must be removed. */
  readonly stale: InterfaceEntry[];
};

/**
 * The one enforcement both entry lists share: a violation with no entry is unlisted, and an entry
 * with no violation is stale. A list therefore only shrinks.
 */
export function reconcile(
  violations: readonly InterfaceViolation[],
  entries: readonly InterfaceEntry[],
): Reconciliation {
  const found = new Set(violations.map(entryKey));
  const listed = new Set(entries.map(entryKey));
  return {
    unlisted: violations.filter((violation) => !listed.has(entryKey(violation))),
    stale: entries.filter((entry) => !found.has(entryKey(entry))),
  };
}

/** The entries of a list file, or none when the file is absent. */
export function readEntries(root: string, path: string): InterfaceEntry[] {
  const file = join(root, path);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { entries?: InterfaceEntry[] };
  return parsed.entries ?? [];
}

/** The violations neither list covers, and the entries of either list that cover nothing. */
export function checkInterfaceRules(root: string = PACKAGE_ROOT): {
  readonly unlisted: InterfaceViolation[];
  readonly stale: Array<InterfaceEntry & { readonly list: string }>;
} {
  const allowlist = readEntries(root, ALLOWLIST_PATH);
  const pending = readEntries(root, PENDING_PATH);
  const violations = collectViolations(root);
  const covered = reconcile(violations, [...allowlist, ...pending]);
  const found = new Set(violations.map(entryKey));
  const stale = [
    ...allowlist.map((entry) => ({ ...entry, list: ALLOWLIST_PATH })),
    ...pending.map((entry) => ({ ...entry, list: PENDING_PATH })),
  ].filter((entry) => !found.has(entryKey(entry)));
  return { unlisted: covered.unlisted, stale };
}

/** Prints what is wrong, and returns the exit code. */
export function run(root: string = PACKAGE_ROOT): number {
  const { unlisted, stale } = checkInterfaceRules(root);
  for (const violation of unlisted) {
    console.error(
      `${violation.file}:${String(violation.line)}: ${violation.rule}: ${violation.subject}`,
    );
  }
  for (const entry of stale) {
    console.error(
      `${entry.list}: stale ${entry.rule} entry for ${entry.file} (${entry.subject}); remove it`,
    );
  }
  if (unlisted.length + stale.length === 0) return 0;
  console.error(
    `${String(unlisted.length)} interface violation(s) and ${String(stale.length)} stale entr${stale.length === 1 ? 'y' : 'ies'}. See scripts/check-interface-rules.ts.`,
  );
  return 1;
}

if (import.meta.main) process.exit(run());
