/**
 * Ban the middle dot (U+00B7) as a separator in interface copy.
 *
 * Owner standing order (2026-11-10): `Waiting on you, then a dot, then Chat` is never acceptable. A
 * middle dot between pieces of copy reads as noise to a screen reader, wraps badly, and teaches
 * every prototype built from Cinder's design system to do the same (COR-2335). A comma between
 * metadata pieces is no better (COR-2449). Give each piece its own element, separate the pieces
 * with a space and a weight or colour step (a muted piece beside a stronger one), break the line,
 * or lay label and value metadata out as a description list.
 *
 * The scan is textual and has no notion of a "separator": any U+00B7 in a scanned file is
 * reported, whether it sits in a string, a template, markup, a stylesheet `content` value, a
 * comment or a regular expression. That keeps the rule checkable and the fix local. The escaped
 * spellings are reported too (a JavaScript `\u00b7` or `\u{b7}`, a `\xb7`, a CSS `\00b7`, an HTML
 * `&middot;`, `&#183;` or `&#xb7;`), because they draw the same glyph. Code that must name the
 * character, such as a test asserting its absence, builds it with `String.fromCodePoint(0xb7)`.
 *
 * The scan roots are the code that writes copy for people: Cinder (every package of it), Chat, the
 * playground, Interborough, and the browser fixtures, whose copy the screenshot baselines and the
 * design review show: the root suite's `src` while it exists, and each package's
 * `browser/fixtures` once COR-2092 moves them there. The rest of a package's browser suite (its
 * specs and harness) is test code and left out. A line with a genuine non-separator use
 * carries a trailing or preceding `middle-dot-allowed: <reason>` marker whose reason is at least
 * twenty characters; none does today, and an addition needs a reason a reviewer would accept.
 *
 * Runs from the root `lint:root` script.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dir, '..');

/** Cinder's core package directory, relative to the repository root. */
const CORE_DIRECTORY = 'components/core';

/**
 * Directories scanned, relative to the repository root: Cinder (core and every package core
 * depends on that the split extracted beside it, P-COR-101), Chat, the playground, Interborough,
 * and the root browser suite's fixtures while that suite exists (COR-2092 moves them into the
 * packages' `browser/fixtures`, which the walk below reads).
 */
export function scannedDirectories(repositoryRoot: string = root): string[] {
  const manifest = JSON.parse(
    readFileSync(join(repositoryRoot, CORE_DIRECTORY, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  const cinderPackages = Object.entries(manifest.dependencies ?? {})
    .filter(
      ([name, specification]) =>
        name.startsWith('@lostgradient/') && specification === 'workspace:*',
    )
    .map(([name]) => `components/${name.slice('@lostgradient/'.length)}`)
    .filter((directory) => existsSync(join(repositoryRoot, directory, 'src')))
    .toSorted();
  const directories = [
    CORE_DIRECTORY,
    ...cinderPackages,
    'components/chat',
    'applications/playground',
    'applications/interborough',
  ];
  if (existsSync(join(repositoryRoot, 'scripts/browser-fixtures/src'))) {
    directories.push('scripts/browser-fixtures/src');
  }
  return directories;
}

// Installed dependencies and generated output, mirroring `.gitignore`, and `vendor`, which holds a
// third party's published build byte for byte (React's UMD builds, for the design-system render
// check) and writes no copy. Dot directories (`.svelte-kit`, `.turbo`, `.types`) are skipped
// wholesale.
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'vendor',
  'build',
  'dist',
  'artifacts',
  'coverage',
  'playwright-report',
  'test-results',
  'test-output',
]);

// Binary formats; every other file is read as text and skipped if it holds a NUL byte.
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.pdf',
  '.zip',
  '.gz',
  '.mp4',
  '.webm',
  '.sqlite',
]);

// The character itself, then every escaped spelling of it: JavaScript (`\u00b7`, `\u{b7}`,
// `\xb7`), CSS (`\00b7`, at least two zeros so a regular expression's `\b7` is not caught) and
// HTML (`&middot;`, `&#183;`, `&#xb7;`).
const MIDDLE_DOT_PATTERN = new RegExp(
  [
    '\u00b7',
    '\\\\u0*b7(?![0-9a-f])',
    '\\\\u\\{0*b7\\}',
    '\\\\x0*b7(?![0-9a-f])',
    '\\\\0{2,5}b7(?![0-9a-f])',
    '&middot;',
    '&#0*183;',
    '&#x0*b7;',
  ].join('|'),
  'i',
);
const ALLOW_MARKER = /middle-dot-allowed:\s*(\S.{18,}\S)/;

/** The failure message's advice: no glyph and no comma, a space plus a weight or colour step. */
export const FAILURE_ADVICE =
  'check-middle-dot-separators - a middle dot (U+00B7) appears in interface copy.\n' +
  'Never use it as a separator, and never a comma either. Give each piece its own element and\n' +
  'separate the pieces with a space and a weight or colour step (a muted piece beside a stronger\n' +
  'one), a line break, or a description list for label and value metadata. Code that must name\n' +
  'the character builds it with String.fromCodePoint(0xb7). A line with a real non-separator use\n' +
  'carries a `middle-dot-allowed: <reason of twenty characters or more>` marker.';

export type MiddleDotViolation = { line: number; text: string };

/** Every line of `source` that holds a middle dot, except one carrying an allow marker with a reason. */
export function findMiddleDotSeparators(source: string): MiddleDotViolation[] {
  const lines = source.split('\n');
  const violations: MiddleDotViolation[] = [];
  lines.forEach((text, index) => {
    if (!MIDDLE_DOT_PATTERN.test(text)) return;
    if (ALLOW_MARKER.test(text) || ALLOW_MARKER.test(lines[index - 1] ?? '')) return;
    violations.push({ line: index + 1, text: text.trim() });
  });
  return violations;
}

export function collectScannedFiles(directory: string, paths: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      if (entry.name === 'browser' && existsSync(join(directory, 'package.json'))) {
        // A package's browser suite: its fixtures draw the copy the baselines and the design
        // review show; its specs and harness are test code.
        if (existsSync(join(path, 'fixtures'))) collectScannedFiles(join(path, 'fixtures'), paths);
        continue;
      }
      collectScannedFiles(path, paths);
    } else if (
      entry.isFile() &&
      !BINARY_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))
    ) {
      paths.push(path);
    }
  }
}

async function scan(): Promise<string[]> {
  const findings: string[] = [];
  const paths: string[] = [];
  for (const directory of scannedDirectories()) collectScannedFiles(join(root, directory), paths);

  for (const path of paths.toSorted()) {
    const source = await Bun.file(path).text();
    if (source.includes('\u0000')) continue;
    for (const violation of findMiddleDotSeparators(source)) {
      const text =
        violation.text.length > 120 ? `${violation.text.slice(0, 117)}...` : violation.text;
      findings.push(`${relative(root, path)}:${violation.line} - ${text}`);
    }
  }

  return findings;
}

async function main(): Promise<void> {
  const findings = await scan();
  if (findings.length === 0) {
    process.stdout.write('check-middle-dot-separators - OK (no middle dot in interface copy).\n');
    return;
  }

  process.stderr.write(`${FAILURE_ADVICE}\n\n`);
  for (const finding of findings) {
    process.stderr.write(`  ${finding}\n`);
  }
  process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-middle-dot-separators failed:', error);
    process.exitCode = 1;
  });
}
