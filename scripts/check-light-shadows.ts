/**
 * Ban a shadow whose color derives from a text, ink or white value.
 *
 * A shadow is darkness: it has to darken what is under it in both themes. A shadow mixed from
 * `--cinder-text-default` is near-black in light mode and near-white in dark mode, so in dark mode
 * the panel glows white beneath itself (the command palette, the data grid's scroll edges). The
 * owner has asked for the glows to go several times (COR-2441), so this guard keeps the class out.
 *
 * The scan is textual. In each CSS, Svelte, HTML, TypeScript and JavaScript source under
 * `components`, `applications`, `packages` and `plugins` it reads every `box-shadow`, `boxShadow`
 * and `--*shadow*` declaration, and every `drop-shadow(...)` call, across lines, and fails when the
 * value references `--cinder-text-`, `--cinder-ink`, `--cinder-polarity-ink`, `currentColor`,
 * `white`, `#fff` or `#ffffff`, or an `oklch(` with a lightness of 90% or more. Block comments are
 * ignored. The same rule covers any custom property whose name contains `edge`, `glow`, `fade`,
 * `scrim` or `shade`, and any `linear-`, `radial-` or `conic-gradient(...)` whose selector or
 * declaration names an edge, glow, fade, scrim, shade or shadow: a scroll-edge fade painted from
 * `--cinder-text-default` glows near-white in dark mode just as a shadow does. A focus ring is not an elevation shadow: references to the ring tokens
 * (`--cinder-ring-*`, `--_cinder-focus-ring-shadow`) are allowed by name, and so is a declaration
 * of `--_cinder-focus-ring-shadow` itself. White is matched in every spelling (`white`, 3, 4, 6 and
 * 8-digit hex, `rgb`/`rgba` 255 255 255 with any separators and alpha, `hsl` and `oklch` lightness
 * 100%). The color picker's dark thumb ring is white on purpose and is exempt by name.
 *
 * The resolved theme tokens (`components/cinder/src/tokens/resolved/{light,dark}.json`) are checked
 * as well: every shadow colour is black in both themes, and in light no layer is heavier than the
 * agreed alpha in `AGREED_LIGHT_SHADOWS`. A new shadow token needs an agreed ceiling in the same
 * change. Owner standing order, 2026-11-19: light mode is not heavy, dark mode has no bright shadow.
 *
 * Runs from the root `lint:guards` script.
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ensureCinderGenerated } from './ensure-cinder-generated.ts';

const root = join(import.meta.dir, '..');

/** Directories scanned, relative to the repository root. */
export const SCANNED_DIRECTORIES = ['components', 'applications', 'packages', 'plugins'];

const SCANNED_EXTENSIONS = new Set(['.css', '.svelte', '.html', '.ts', '.js']);

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'build',
  'dist',
  'artifacts',
  'coverage',
  'playwright-report',
  'test-results',
  'test-output',
]);

export type LightShadowViolation = { line: number; text: string; reason: string };

/** Replaces each block comment with spaces and newlines, so line numbers stay put. */
function blankComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

const DECLARATION =
  /(?<![\w-])(box-shadow|boxShadow|--[\w-]*(?:shadow|edge|glow|fade|scrim|shade)[\w-]*)\s*:/gi;
const DROP_SHADOW = /drop-shadow\(/g;
const GRADIENT = /(?<![\w-])(?:repeating-)?(?:linear|radial|conic)-gradient\(/g;
/** A word that marks a gradient as painting an edge, a fade, a scrim or a shade. */
const EDGE_WORDS = /edge|glow|fade|scrim|shade|shadow/i;

/** The selector and the declaration text before `index`, which say what a gradient paints. */
function gradientContext(text: string, index: number): string {
  const declarationStart = Math.max(
    text.lastIndexOf(';', index),
    text.lastIndexOf('{', index),
    text.lastIndexOf('}', index),
  );
  const ruleStart = text.lastIndexOf('{', index);
  const selectorStart = Math.max(
    text.lastIndexOf('}', ruleStart),
    text.lastIndexOf(';', ruleStart),
  );
  return `${text.slice(selectorStart + 1, ruleStart)} ${text.slice(declarationStart + 1, index)}`;
}

/** The text from `start` to the end of a CSS value: a `;`, an unmatched `}` or `)`, or a quote. */
function readValue(source: string, start: number, stopAtComma: boolean): string {
  let depth = 0;
  let end = start;
  for (; end < source.length; end += 1) {
    const character = source[end];
    if (character === '(') depth += 1;
    else if (character === ')') {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && (character === ';' || character === '}')) break;
    else if (depth === 0 && stopAtComma && character === ',') break;
    else if (depth === 0 && end > start && (character === '"' || character === '`')) break;
  }
  return source.slice(start, end);
}

/** The value with every allowed ring-token reference removed. */
function withoutRingTokens(value: string): string {
  return value.replace(/var\(\s*--(?:_cinder-focus-ring-shadow|cinder-ring-[\w-]*)[^)]*\)/g, ' ');
}

/** Every spelling of white: the keyword, hex with or without alpha, rgb, hsl and OKLCH. */
const WHITE = new RegExp(
  [
    '(?<![\\w-])white(?![\\w-])',
    '#fff(?:[0-9a-f]|fff(?:[0-9a-f]{2})?)?(?![0-9a-f])',
    'rgba?\\(\\s*(?:255|100%)[\\s,]+(?:255|100%)[\\s,]+(?:255|100%)(?![\\d.])',
    'hsla?\\(\\s*[^,)\\s]+[\\s,]+[^,)\\s]+[\\s,]+100(?:\\.0*)?%',
    'oklch\\(\\s*(?:100(?:\\.0*)?%|1(?:\\.0*)?(?![\\d.]))',
  ].join('|'),
  'i',
);

/**
 * Declarations that are shadows drawn white on purpose. The color picker's thumb outline puts a
 * white outer ring on dark chrome so the thumb stays visible over a dark surface; the ring is not a
 * panel's elevation shadow and the light arm is transparent.
 */
const WHITE_ON_PURPOSE = new Set(['--_cinder-color-picker-thumb-shadow-support-dark']);

/** Why a shadow value reads as light ink, or `undefined` when it does not. */
export function lightReason(value: string): string | undefined {
  const checked = withoutRingTokens(value);
  if (/--cinder-text-/.test(checked)) return 'references a --cinder-text-* token';
  if (/--cinder-(?:polarity-)?ink\b/.test(checked)) return 'references an ink token';
  if (/currentColor/i.test(checked)) return 'references currentColor';
  if (WHITE.test(checked)) return 'references white';
  for (const match of checked.matchAll(/oklch\(\s*([\d.]+)(%?)/gi)) {
    const lightness = Number(match[1]);
    const percent = match[2] === '%' ? lightness : lightness * 100;
    if (percent >= 90) return `uses an oklch lightness of ${percent}%`;
  }
  return undefined;
}

/** Every shadow declaration in `source` whose value references light ink or white. */
export function findLightShadows(source: string): LightShadowViolation[] {
  const text = blankComments(source);
  const violations: LightShadowViolation[] = [];
  const report = (start: number, value: string): void => {
    const reason = lightReason(value);
    if (reason === undefined) return;
    const line = text.slice(0, start).split('\n').length;
    violations.push({ line, text: value.replace(/\s+/g, ' ').trim(), reason });
  };
  for (const match of text.matchAll(DECLARATION)) {
    if (match[1] === '--_cinder-focus-ring-shadow' || WHITE_ON_PURPOSE.has(match[1]!)) continue;
    const start = match.index + match[0].length;
    report(match.index, readValue(text, start, match[1] === 'boxShadow'));
  }
  for (const match of text.matchAll(DROP_SHADOW)) {
    report(match.index, readValue(text, match.index + match[0].length, false));
  }
  for (const match of text.matchAll(GRADIENT)) {
    if (!EDGE_WORDS.test(gradientContext(text, match.index))) continue;
    report(match.index, readValue(text, match.index + match[0].length, false));
  }
  return violations.toSorted((first, second) => first.line - second.line);
}

/** Appends to `paths` every source file under `directory` the scan reads. */
export function collectScannedFiles(directory: string, paths: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      collectScannedFiles(path, paths);
    } else if (
      entry.isFile() &&
      SCANNED_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.'))) &&
      !/\.(?:test|spec)\.[jt]s$/.test(entry.name)
    ) {
      paths.push(path);
    }
  }
}

export const TOKEN_FILES = [
  'components/cinder/src/tokens/resolved/light.json',
  'components/cinder/src/tokens/resolved/dark.json',
];

/** The heaviest alpha any layer of each shadow token has in the light theme. */
export const AGREED_LIGHT_SHADOWS: Readonly<Record<string, number>> = {
  'shadow.small': 0.1,
  'shadow.medium': 0.12,
  'shadow.large': 0.14,
  'shadow.overlay': 0.14,
  'scroll-shadow.color': 0.14,
  'docked-action-bar.shadow-color': 0.08,
  'theme-switch.thumb-shadow-color': 0.25,
};

/** The darkest a shadow's colour can be: OKLCH lightness as a fraction. */
const MAXIMUM_SHADOW_LIGHTNESS = 0.1;

type ShadowColor = { components: readonly number[]; alpha?: number };

function colorsOf(value: unknown): ShadowColor[] {
  if (Array.isArray(value)) return value.flatMap(colorsOf);
  if (typeof value !== 'object' || value === null) return [];
  if ('components' in value) return [value as ShadowColor];
  if ('color' in value) return colorsOf(value.color);
  return [];
}

/**
 * Why a theme's resolved tokens break the rule, one string per problem: every colour of every token
 * whose name holds `shadow` is black in both themes, and in light no layer is heavier than the agreed
 * alpha in `AGREED_LIGHT_SHADOWS`, which names every shadow token.
 */
export function judgeShadowTokens(
  theme: 'light' | 'dark',
  tokens: Readonly<Record<string, { $value?: unknown }>>,
): string[] {
  const problems: string[] = [];
  for (const [name, token] of Object.entries(tokens)) {
    if (!name.includes('shadow')) continue;
    const colors = colorsOf(token.$value);
    if (colors.length === 0) continue;
    for (const color of colors) {
      const lightness = color.components[0] ?? 0;
      if (lightness > MAXIMUM_SHADOW_LIGHTNESS) {
        problems.push(`${theme} ${name} - a shadow colour of lightness ${lightness}, not black`);
      }
    }
    if (theme !== 'light') continue;
    if (!Object.hasOwn(AGREED_LIGHT_SHADOWS, name)) {
      problems.push(
        `light ${name} - a shadow token with no agreed ceiling in AGREED_LIGHT_SHADOWS`,
      );
      continue;
    }
    const ceiling = AGREED_LIGHT_SHADOWS[name]!;
    const heaviest = Math.max(...colors.map((color) => color.alpha ?? 1));
    if (heaviest > ceiling) {
      problems.push(
        `light ${name} - a layer of alpha ${heaviest} is heavier than the agreed ${ceiling}`,
      );
    }
  }
  return problems;
}

async function main(): Promise<void> {
  // The resolved token files are generated and untracked: a fresh checkout has none.
  await ensureCinderGenerated();
  const paths: string[] = [];
  for (const directory of SCANNED_DIRECTORIES) collectScannedFiles(join(root, directory), paths);

  const problems: string[] = [];
  for (const file of TOKEN_FILES) {
    const tokens = (await Bun.file(join(root, file)).json()) as Record<
      string,
      { $value?: unknown }
    >;
    problems.push(...judgeShadowTokens(file.endsWith('light.json') ? 'light' : 'dark', tokens));
  }
  for (const path of paths.toSorted()) {
    for (const violation of findLightShadows(await Bun.file(path).text())) {
      const text =
        violation.text.length > 100 ? `${violation.text.slice(0, 97)}...` : violation.text;
      problems.push(`${relative(root, path)}:${violation.line} - ${violation.reason}: ${text}`);
    }
  }

  if (problems.length === 0) {
    process.stdout.write(
      'check-light-shadows - OK (shadow tokens are agreed and no shadow derives from text, ink or white).\n',
    );
    return;
  }
  process.stderr.write(
    'check-light-shadows - a shadow derives from a light value.\n' +
      'A shadow is darkness. Use --cinder-shadow-*, --cinder-scroll-shadow-color, or a black\n' +
      'oklch(0% 0 0 / alpha); never a text, ink or white value, which glows in dark mode.\n\n',
  );
  for (const problem of problems) process.stderr.write(`  ${problem}\n`);
  process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-light-shadows failed:', error);
    process.exitCode = 1;
  });
}
