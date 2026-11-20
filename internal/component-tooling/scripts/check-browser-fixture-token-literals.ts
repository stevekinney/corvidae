/** Follow Cinder tokens in authored browser fixture styles, with a shrinking baseline. */

import { Glob } from 'bun';
import { join, resolve } from 'node:path';
import { parse as parseCss } from 'postcss';
import { parse } from 'svelte/compiler';

import { COLOR_PROBES } from './check-component-css-raw-colors.ts';

const repository = resolve(import.meta.dir, '../../..');
const baselinePath = join(import.meta.dir, 'browser-fixture-token-literals-baseline.json');
const fixtureLocations = [
  { directory: 'scripts/browser-fixtures/src/fixtures', pattern: '**/*.{css,svelte}' },
  { directory: 'components/cinder/src/components', pattern: '**/*.fixture.svelte' },
];

type FixtureLiteral = { line: number; property: string; value: string };
type SourceNode = Record<string, unknown>;
type Baseline = Record<string, readonly string[]>;

const SIZING_PROPERTY =
  /^(?:--|(?:margin|padding|scroll-margin|scroll-padding|gap|row-gap|column-gap|inset|top|right|bottom|left|width|height|(?:min-|max-)?(?:inline|block)-size|(?:min-|max-)(?:width|height)|flex|grid|translate|font|line-height|border|outline|box-shadow|text-shadow|background-size|letter-spacing|word-spacing)(?:-|$))/;
const COLOR_PROPERTY =
  /^(?:--|(?:background|border|outline|fill|stroke|filter|box-shadow|text-shadow|text-decoration|text-emphasis|caret|accent|scrollbar|color|flood|lighting|stop|-webkit-text-fill|-webkit-text-stroke)(?:-|$))/;
const SVG_PAINT_ATTRIBUTES = new Set([
  'fill',
  'stroke',
  'stop-color',
  'flood-color',
  'lighting-color',
]);
// Keep the fluid CSS units used to size a fixture relative to its viewport or container.
const LENGTH =
  /^[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:px|r?em|r?ex|r?ch|r?lh|r?cap|r?ic|cm|mm|q|in|pt|pc)$/i;
const VALUE_TOKEN =
  /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|#[\w-]+|[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:[a-z]+|%)?|[\w-]+\(?|[()]/gi;

function hasDesignLiteral(property: string, value: string): boolean {
  const sizing = SIZING_PROPERTY.test(property);
  const paint = COLOR_PROPERTY.test(property);
  if (!sizing && !paint) return false;

  let skippedDepth = 0;
  for (const match of value.matchAll(VALUE_TOKEN)) {
    const token = match[0].toLowerCase();
    if (skippedDepth > 0) {
      if (token.endsWith('(')) skippedDepth += 1;
      if (token === ')') skippedDepth -= 1;
      continue;
    }
    if (token === 'var(' || token === 'url(') {
      skippedDepth = 1;
      continue;
    }
    if (sizing && LENGTH.test(token) && Number.parseFloat(token) !== 0) return true;
    if (!paint) continue;

    if (token.startsWith('#')) {
      if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/.test(token)) return true;
    } else if (token.endsWith('(')) {
      // A token-derived relative color or light/dark choice can stay theme-aware.
      const usesTokenOrigin = /^\s*from\s+var\(/i.test(value.slice(match.index + token.length));
      if (
        !usesTokenOrigin &&
        token !== 'light-dark(' &&
        (COLOR_PROBES.some(({ pattern }) => token.search(pattern) === 0) ||
          /^(?:lab|lch|oklab|hwb|color|device-cmyk)\($/.test(token))
      ) {
        return true;
      }
    } else if (/^[a-z]+$/.test(token) && token !== 'transparent') {
      if (Bun.color(token, 'hex')?.startsWith('#')) return true;
    }
  }
  return false;
}

function isNode(value: unknown): value is SourceNode {
  return typeof value === 'object' && value !== null;
}

const DYNAMIC_VALUE = 'var(--fixture-expression)';

/** Recover literal style text while leaving runtime expressions opaque. */
function styleValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    if (value.length === 1) return styleValues(value[0]);
    return [value.map((part: unknown) => styleValues(part)[0] ?? DYNAMIC_VALUE).join('')];
  }
  if (!isNode(value)) return [];

  switch (value['type']) {
    case 'Text':
      return typeof value['data'] === 'string' ? [value['data']] : [];
    case 'ExpressionTag':
      return styleValues(value['expression']);
    case 'Literal':
      return typeof value['value'] === 'string' || typeof value['value'] === 'number'
        ? [String(value['value'])]
        : [];
    case 'ConditionalExpression':
      return [...styleValues(value['consequent']), ...styleValues(value['alternate'])];
    case 'TemplateLiteral': {
      const quasis = value['quasis'];
      const expressions = value['expressions'];
      if (!Array.isArray(quasis) || !Array.isArray(expressions)) return [];
      return [
        quasis
          .map((part: unknown, index) => {
            const contents = isNode(part) ? part['value'] : undefined;
            const text =
              isNode(contents) && typeof contents['cooked'] === 'string' ? contents['cooked'] : '';
            return index < expressions.length
              ? text + (styleValues(expressions[index])[0] ?? DYNAMIC_VALUE)
              : text;
          })
          .join(''),
      ];
    }
    default:
      return [];
  }
}

/** Find authored declarations with raw design colors or dimensions; preserve source line numbers. */
export function findFixtureLiterals(source: string, filePath: string): FixtureLiteral[] {
  const found: FixtureLiteral[] = [];
  function scanDeclarations(styles: string, firstLine: number, inline = false): void {
    const css = inline ? `fixture{${styles}}` : styles;
    const root = parseCss(css, { from: filePath });
    root.walkDecls((declaration) => {
      const property = declaration.prop.toLowerCase();
      if (!hasDesignLiteral(property, declaration.value)) return;
      found.push({
        line: firstLine + (declaration.source?.start?.line ?? 1) - 1,
        property,
        value: declaration.value,
      });
    });
  }

  if (filePath.endsWith('.css')) {
    scanDeclarations(source, 1);
    return found;
  }

  const ast = parse(source, { filename: filePath, modern: true });
  const lineAt = (offset: unknown) =>
    typeof offset === 'number' ? source.slice(0, offset).split('\n').length : 1;

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isNode(value)) return;

    const name = value['name'];
    const key = value['key'];
    if (value['type'] === 'RegularElement' && Array.isArray(value['attributes'])) {
      for (const attribute of value['attributes']) {
        if (!isNode(attribute) || attribute['type'] !== 'Attribute') continue;
        const property = attribute['name'];
        if (typeof property !== 'string' || !SVG_PAINT_ATTRIBUTES.has(property)) continue;
        for (const styles of styleValues(attribute['value'])) {
          scanDeclarations(`${property}: ${styles}`, lineAt(attribute['start']), true);
        }
      }
    }
    const styleProperty =
      value['type'] === 'Property' &&
      isNode(key) &&
      ((key['type'] === 'Identifier' && key['name'] === 'style') ||
        (key['type'] === 'Literal' && key['value'] === 'style'));
    if (styleProperty || (value['type'] === 'Attribute' && name === 'style')) {
      for (const styles of styleValues(value['value'])) {
        scanDeclarations(styles, lineAt(value['start']), true);
      }
    } else if (value['type'] === 'StyleDirective' && typeof name === 'string') {
      for (const styles of styleValues(value['value'])) {
        scanDeclarations(`${name}: ${styles}`, lineAt(value['start']), true);
      }
    }

    for (const child of Object.values(value)) visit(child);
  }

  visit(ast.fragment);
  if (ast.css) scanDeclarations(ast.css.content.styles, lineAt(ast.css.content.start));

  return found.toSorted((left, right) => left.line - right.line);
}

/** Collect only authored fixtures, including Svelte fixtures colocated with Cinder components. */
export async function scanBrowserFixtureLiterals(): Promise<Map<string, FixtureLiteral[]>> {
  const found = new Map<string, FixtureLiteral[]>();
  for (const { directory, pattern } of fixtureLocations) {
    const glob = new Glob(pattern);
    for await (const file of glob.scan({ cwd: join(repository, directory) })) {
      const relativePath = `${directory}/${file.replaceAll('\\', '/')}`;
      const source = await Bun.file(join(repository, relativePath)).text();
      const literals = findFixtureLiterals(source, relativePath);
      if (literals.length > 0) found.set(relativePath, literals);
    }
  }
  return found;
}

function declarationKey({ property, value }: FixtureLiteral): string {
  return `${property}: ${value}`;
}

/** Compare declarations by count so moving an existing line is harmless and copying it fails. */
export function newFixtureLiterals(
  declarations: readonly FixtureLiteral[],
  baseline: readonly string[],
): FixtureLiteral[] {
  const remaining = new Map<string, number>();
  for (const entry of baseline) remaining.set(entry, (remaining.get(entry) ?? 0) + 1);
  return declarations.filter((declaration) => {
    const key = declarationKey(declaration);
    const count = remaining.get(key) ?? 0;
    if (count === 0) return true;
    remaining.set(key, count - 1);
    return false;
  });
}

/** Serialize the inventory in stable order for explicit baseline reductions. */
export function browserFixtureBaseline(found: Map<string, FixtureLiteral[]>): Baseline {
  return Object.fromEntries(
    Array.from(found.keys())
      .toSorted()
      .map((file) => [file, found.get(file)?.map(declarationKey).toSorted() ?? []]),
  );
}

/** Run the fixture guard, allowing an explicit baseline update only when it shrinks. */
export async function checkBrowserFixtureLiterals({
  strict = false,
  update = false,
}: { strict?: boolean; update?: boolean } = {}): Promise<void> {
  const found = await scanBrowserFixtureLiterals();
  const baseline: Baseline = await Bun.file(baselinePath).json();
  let newCount = 0;
  for (const [file, declarations] of found) {
    const previous = Object.hasOwn(baseline, file) ? (baseline[file] ?? []) : [];
    for (const declaration of newFixtureLiterals(declarations, previous)) {
      newCount += 1;
      process.stdout.write(`${file}:${declaration.line}: ${declarationKey(declaration)}\n`);
    }
  }

  if (newCount > 0) {
    process.stdout.write(
      `Found ${newCount} new raw fixture declaration(s). Use Cinder components or CSS variables for color, spacing, and sizing.\n`,
    );
    if (strict || update) process.exitCode = 1;
    return;
  }

  const current = browserFixtureBaseline(found);
  const currentCount = Object.values(current).flat().length;
  const baselineCount = Object.values(baseline).flat().length;
  if (currentCount < baselineCount) {
    if (update) {
      const { format, resolveConfig } = await import('prettier');
      await Bun.write(
        baselinePath,
        await format(JSON.stringify(current), {
          ...(await resolveConfig(baselinePath)),
          filepath: baselinePath,
        }),
      );
    } else {
      process.stdout.write(
        'Fixture token baseline can shrink. Run: bun internal/component-tooling/scripts/check-design-token-literals.ts --browser-fixtures --update-baseline\n',
      );
      if (strict) process.exitCode = 1;
      return;
    }
  }
  process.stdout.write(
    `Browser fixture token literals — OK (${currentCount} existing declarations).\n`,
  );
}
