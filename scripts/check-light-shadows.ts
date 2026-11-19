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
 * ignored. A focus ring is not an elevation shadow: references to the ring tokens
 * (`--cinder-ring-*`, `--_cinder-focus-ring-shadow`) are allowed by name, and so is a declaration
 * of `--_cinder-focus-ring-shadow` itself.
 *
 * Runs from the root `lint:guards` script.
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

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

const DECLARATION = /(?<![\w-])(box-shadow|boxShadow|--[\w-]*shadow[\w-]*)\s*:/g;
const DROP_SHADOW = /drop-shadow\(/g;

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

/** Why a shadow value reads as light ink, or `undefined` when it does not. */
export function lightReason(value: string): string | undefined {
  const checked = withoutRingTokens(value);
  if (/--cinder-text-/.test(checked)) return 'references a --cinder-text-* token';
  if (/--cinder-(?:polarity-)?ink\b/.test(checked)) return 'references an ink token';
  if (/currentColor/i.test(checked)) return 'references currentColor';
  if (/(?<![\w-])white(?![\w-])/i.test(checked)) return 'references white';
  if (/#fff(?:fff)?(?![0-9a-f])/i.test(checked)) return 'references #fff';
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
    if (match[1] === '--_cinder-focus-ring-shadow') continue;
    const start = match.index + match[0].length;
    report(match.index, readValue(text, start, match[1] === 'boxShadow'));
  }
  for (const match of text.matchAll(DROP_SHADOW)) {
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

async function main(): Promise<void> {
  const paths: string[] = [];
  for (const directory of SCANNED_DIRECTORIES) collectScannedFiles(join(root, directory), paths);

  const problems: string[] = [];
  for (const path of paths.toSorted()) {
    for (const violation of findLightShadows(await Bun.file(path).text())) {
      const text =
        violation.text.length > 100 ? `${violation.text.slice(0, 97)}...` : violation.text;
      problems.push(`${relative(root, path)}:${violation.line} - ${violation.reason}: ${text}`);
    }
  }

  if (problems.length === 0) {
    process.stdout.write('check-light-shadows - OK (no shadow derives from text, ink or white).\n');
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
