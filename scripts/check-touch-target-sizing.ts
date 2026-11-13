/**
 * Keep the touch-target minimum out of painted sizes.
 *
 * Owner complaint (2026-11-11): "Giant buttons and touch targets on mobile". A control is painted
 * compact (24 to 36px) and reaches 44px through a hit area that takes no layout: Cinder's Button
 * does it itself, and a bare control does it with a pseudo-element that sets `inset`. A style
 * that sizes a control with `--cinder-touch-target-min` paints the whole 44px instead. So does
 * one that sizes a painted face with `--cinder-button-height-*`, because those tokens rise to the
 * touch-target minimum on a coarse pointer (COR-2289 found an icon drawn taller than its row that
 * way).
 *
 * The scan reads every stylesheet and Svelte component outside Cinder, which owns the tokens and
 * the hit-area rule. It reports a `width`, `height`, `inline-size` or `block-size` declaration
 * (with or without `min-` or `max-`) whose value names either token. A hit-area pseudo-element
 * sets `inset`, which the scan does not match.
 *
 * `ALLOWED_DECLARATIONS` names the declarations that remain, per file, as an exact count. It only
 * shrinks: a file over its count fails, and so does a file under it, until the count is lowered.
 *
 * Runs from the root `lint:guards` script.
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dir, '..');

/** Directories whose children are workspaces that consume Cinder. */
const WORKSPACE_PARENTS = ['applications', 'components', 'plugins'];

/** Cinder defines the tokens and the hit-area rule, so its own styles are not scanned. */
const TOKEN_OWNER = 'components/cinder';

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

const SIZING_DECLARATION =
  /^\s*(?:min-|max-)?(?:block-size|inline-size|height|width)\s*:[^;]*--cinder-(?:touch-target-min|button-height-)/;

/** Declarations that remain, by file. Each count is exact, and the list only shrinks. */
export const ALLOWED_DECLARATIONS: Readonly<Record<string, number>> = {
  // The top bar's trail is a touch target tall so its clip holds the back link's whole hit area.
  'applications/interborough/src/styles/foundation.css': 1,
  // A full-width row of the navigation rail, not a compact control.
  'components/chat/src/lib/components/chat-navigation-rail/chat-navigation-rail.css': 1,
  // Full-width disclosure rows, not compact controls.
  'components/chat/src/lib/components/chat/message/entry-frame.svelte': 1,
  'components/chat/src/lib/components/chat/message/message-sources.svelte': 1,
  'components/chat/src/lib/components/chat/message/tool-call-timeline.svelte': 2,
  'components/chat/src/lib/components/chat/message/parts/reasoning-part.svelte': 1,
  // Overridden to 1.5rem inside a message line; the base rule serves the standalone action.
  'components/chat/src/lib/components/chat/message/chat-message.svelte': 2,
  'components/chat/src/lib/components/chat/message/parts/suggestion-part.svelte': 2,
  // Not yet converted: the link popover's close button is painted 44px on a coarse pointer.
  'components/editor/src/lib/components/markdown-editor/editor-toolbar/link-popover.svelte': 4,
};

export type TouchTargetSizing = { line: number; text: string };

/** Every line of `source` that sizes something with the touch-target or button-height tokens. */
export function findTouchTargetSizing(source: string): TouchTargetSizing[] {
  const found: TouchTargetSizing[] = [];
  source.split('\n').forEach((text, index) => {
    if (SIZING_DECLARATION.test(text)) found.push({ line: index + 1, text: text.trim() });
  });
  return found;
}

function collectStyleFiles(directory: string, paths: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      if (relative(root, path) === TOKEN_OWNER) continue;
      collectStyleFiles(path, paths);
    } else if (entry.isFile() && (entry.name.endsWith('.svelte') || entry.name.endsWith('.css'))) {
      paths.push(path);
    }
  }
}

/** The declarations found in each scanned file, keyed by its path from the repository root. */
export async function scanTouchTargetSizing(): Promise<Record<string, TouchTargetSizing[]>> {
  const paths: string[] = [];
  for (const parent of WORKSPACE_PARENTS) collectStyleFiles(join(root, parent), paths);
  const found: Record<string, TouchTargetSizing[]> = {};
  for (const path of paths.toSorted()) {
    const declarations = findTouchTargetSizing(await Bun.file(path).text());
    if (declarations.length > 0) found[relative(root, path)] = declarations;
  }
  return found;
}

/** One line per file whose count differs from its allowance. */
export function compareWithAllowance(
  found: Readonly<Record<string, readonly TouchTargetSizing[]>>,
  allowed: Readonly<Record<string, number>>,
): string[] {
  const problems: string[] = [];
  for (const file of [...new Set([...Object.keys(found), ...Object.keys(allowed)])].toSorted()) {
    const declarations = found[file] ?? [];
    const allowance = Object.hasOwn(allowed, file) ? (allowed[file] ?? 0) : 0;
    if (declarations.length > allowance) {
      const lines = declarations.map((declaration) => declaration.line).join(', ');
      problems.push(
        `${file}: ${declarations.length} sizing declarations (lines ${lines}), ${allowance} allowed`,
      );
    } else if (declarations.length < allowance) {
      problems.push(
        `${file}: ${declarations.length} sizing declarations, ${allowance} allowed; lower its count in ALLOWED_DECLARATIONS`,
      );
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const problems = compareWithAllowance(await scanTouchTargetSizing(), ALLOWED_DECLARATIONS);
  if (problems.length === 0) {
    process.stdout.write(
      'check-touch-target-sizing - OK (no painted size uses the touch-target tokens beyond the allowance).\n',
    );
    return;
  }

  process.stderr.write(
    'check-touch-target-sizing - a style sizes a control with --cinder-touch-target-min or\n' +
      '--cinder-button-height-*, which paints it 44px tall on a touch screen. Paint the control\n' +
      'compact and reach 44px with a hit area that takes no layout: use a Cinder Button, or a\n' +
      'pseudo-element positioned with `inset`.\n\n',
  );
  for (const problem of problems) process.stderr.write(`  ${problem}\n`);
  process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-touch-target-sizing failed:', error);
    process.exitCode = 1;
  });
}
