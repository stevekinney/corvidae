/**
 * Ban a new `labelVisible={false}` on a control in Interborough's own pages.
 *
 * A field whose visible label is hidden has nothing on screen that says what it is once a value is
 * typed into it, and a person scanning a form for "Agent" or "Message" finds a row of bare inputs
 * (sweep W44, COR-2022). Cinder's own composed controls hide a label where they draw a sibling
 * label of their own (a key-value row, a tab filter), and Cinder owns that; an Interborough page
 * uses the control's visible label, which is the default. Cinder's `Toggle` carries its own visible
 * label, so a page never draws a second, hidden one beside it.
 *
 * The scan is textual: it counts `labelVisible={false}` in markup, `labelVisible: false` in an
 * object literal or a props bag, and the quoted attribute spelling `labelVisible="false"`, in each
 * source file under `applications/interborough`. A line with a real need (a control inside a group
 * that already draws the visible label for the whole group) carries a trailing or preceding
 * `hidden-label-allowed: <reason>` marker whose reason is at least twenty characters.
 *
 * Pages that hid a label before the guard existed are listed in
 * `scripts/hidden-label-allowlist.json` with the file, how many sites it holds and a reason. The
 * list only shrinks: a file that holds more sites than its entry (or any with no entry) fails, and
 * an entry that names more sites than remain is reported so it can be lowered or removed. Adding
 * or raising an entry is a reviewed edit that needs a reason.
 *
 * Runs from the root `lint:root` script.
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dir, '..');
export const ALLOWLIST_FILE = join(import.meta.dir, 'hidden-label-allowlist.json');

/** Directories scanned, relative to the repository root. */
export const SCANNED_DIRECTORIES = ['applications/interborough'];

/** The files a control can be written in. */
const SCANNED_EXTENSIONS = new Set(['.svelte', '.ts', '.js']);

// Installed dependencies and generated output, mirroring `.gitignore`. Dot directories
// (`.svelte-kit`, `.turbo`, `.types`) are skipped wholesale.
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

const HIDDEN_LABEL_PATTERN =
  /\blabelVisible\s*(?:=\s*(?:\{\s*false\s*\}|["']false["'])|:\s*false\b)/;
const ALLOW_MARKER = /hidden-label-allowed:\s*(\S.{18,}\S)/;

export type HiddenLabelViolation = { line: number; text: string };

/** Every line of `source` that hides a label, except one carrying an allow marker with a reason. */
export function findHiddenLabels(source: string): HiddenLabelViolation[] {
  const lines = source.split('\n');
  const violations: HiddenLabelViolation[] = [];
  lines.forEach((text, index) => {
    if (!HIDDEN_LABEL_PATTERN.test(text)) return;
    if (ALLOW_MARKER.test(text) || ALLOW_MARKER.test(lines[index - 1] ?? '')) return;
    violations.push({ line: index + 1, text: text.trim() });
  });
  return violations;
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
      SCANNED_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))
    ) {
      paths.push(path);
    }
  }
}

/** One page that hid a label before the guard, with how many sites it holds and why it stays. */
export type HiddenLabelAllowlistEntry = { file: string; count: number; reason: string };

/** What a scan found wrong, and what it found stale. */
export type HiddenLabelVerdict = { problems: string[]; stale: string[] };

/**
 * Judges the sites found per file (a path relative to the repository root) against the allowlist.
 * A file with more sites than its entry allows, or with sites and no entry, is a problem; an entry
 * that names more sites than the file holds, or a file with none, is stale and can be lowered.
 */
export function judgeHiddenLabels(
  found: ReadonlyMap<string, readonly HiddenLabelViolation[]>,
  allowlist: readonly HiddenLabelAllowlistEntry[],
): HiddenLabelVerdict {
  const problems: string[] = [];
  const stale: string[] = [];
  const allowed = new Map(allowlist.map((entry) => [entry.file, entry.count]));
  for (const [file, violations] of found) {
    const count = allowed.get(file) ?? 0;
    if (violations.length <= count) continue;
    for (const violation of violations.slice(count)) {
      const text =
        violation.text.length > 120 ? `${violation.text.slice(0, 117)}...` : violation.text;
      problems.push(`${file}:${violation.line} - ${text}`);
    }
  }
  for (const entry of allowlist) {
    const held = found.get(entry.file)?.length ?? 0;
    if (held < entry.count) {
      stale.push(`${entry.file} - lists ${entry.count} but holds ${held}`);
    }
  }
  return { problems, stale };
}

async function scan(): Promise<HiddenLabelVerdict> {
  const paths: string[] = [];
  for (const directory of SCANNED_DIRECTORIES) collectScannedFiles(join(root, directory), paths);

  const found = new Map<string, HiddenLabelViolation[]>();
  for (const path of paths.toSorted()) {
    const violations = findHiddenLabels(await Bun.file(path).text());
    if (violations.length > 0) found.set(relative(root, path), violations);
  }

  const allowlist = (await Bun.file(ALLOWLIST_FILE).json()) as HiddenLabelAllowlistEntry[];
  return judgeHiddenLabels(found, allowlist);
}

async function main(): Promise<void> {
  const { problems, stale } = await scan();
  for (const note of stale) {
    process.stdout.write(`check-hidden-labels - stale allowlist entry, lower or remove: ${note}\n`);
  }
  if (problems.length === 0) {
    process.stdout.write('check-hidden-labels - OK (no new hidden control label).\n');
    return;
  }

  process.stderr.write(
    'check-hidden-labels - a control hides its visible label.\n' +
      'Use the control visible label (the default): Toggle draws its own, and a field shows\n' +
      'what it is for beside its value. A line with a real need carries a\n' +
      '`hidden-label-allowed: <reason of twenty characters or more>` marker.\n\n',
  );
  for (const problem of problems) {
    process.stderr.write(`  ${problem}\n`);
  }
  process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-hidden-labels failed:', error);
    process.exitCode = 1;
  });
}
