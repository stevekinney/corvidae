/**
 * The touch-pointer profile of the root Chromium baselines (COR-2440): every component whose own
 * styles have an `any-pointer: coarse` rule is drawn once more at the phone width with a touch
 * screen (`TOUCH_VIEWPORT`), so a change that is compact on touch can be judged from baselines.
 * Only the `assertion` fixture is drawn at it, in both themes: the fixture every component has.
 *
 * Nothing here starts a browser: the spec (`components.playwright.ts`) and the test of this file
 * share it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Theme } from '@lostgradient/testing';

const REPOSITORY = join(import.meta.dir, '..', '..', '..');

/** Where each package keeps its components, one directory per component slug. */
export const COMPONENT_ROOTS: readonly string[] = [
  'components/cinder/src/components',
  'components/chat/src/lib/components',
  'components/editor/src/lib/components',
  'components/terminal/src/lib/components',
];

/** The fixture drawn at the touch profile. */
export const TOUCH_FIXTURE = 'assertion';

/** The themes drawn at the touch profile. */
export const TOUCH_THEMES: readonly Theme[] = ['light', 'dark'];

/** Where the Linux Chromium baselines live, one directory per slug. */
export const BASELINE_ROOT = join(REPOSITORY, 'scripts/browser-fixtures/snapshots/chromium/linux');

const COARSE_RULE = /@media[^{]*any-pointer:\s*coarse/;

/** Whether a file under `directory` (searched recursively) holds a coarse-pointer rule. */
function hasCoarseRule(directory: string): boolean {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (hasCoarseRule(path)) return true;
      continue;
    }
    if (!/\.(?:css|svelte)$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
    if (COARSE_RULE.test(readFileSync(path, 'utf8'))) return true;
  }
  return false;
}

/**
 * The slugs of the components whose own styles have an `any-pointer: coarse` rule and that have a
 * root `assertion` baseline, sorted.
 */
export function coarsePointerSlugs(repository: string = REPOSITORY): string[] {
  const slugs = new Set<string>();
  for (const root of COMPONENT_ROOTS) {
    const directory = join(repository, root);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      if (!existsSync(join(BASELINE_ROOT, entry.name, `light-mobile-${TOUCH_FIXTURE}.png`)))
        continue;
      if (hasCoarseRule(join(directory, entry.name))) slugs.add(entry.name);
    }
  }
  return [...slugs].toSorted();
}

/** The baseline file names a slug holds at the touch profile. */
export function touchBaselineNames(): string[] {
  return TOUCH_THEMES.map((theme) => `${theme}-touch-${TOUCH_FIXTURE}.png`);
}

/** Every touch-profile baseline path the coarse-pointer components need. */
export function touchBaselinePaths(repository: string = REPOSITORY): string[] {
  return coarsePointerSlugs(repository).flatMap((slug) =>
    touchBaselineNames().map((name) => join(BASELINE_ROOT, slug, name)),
  );
}
