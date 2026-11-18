/**
 * The root Chromium baselines hold a touch-pointer profile for every component with an
 * `any-pointer: coarse` rule (COR-2440), and the spec draws it.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TOUCH_VIEWPORT, VIEWPORTS } from '@lostgradient/testing';

import {
  BASELINE_ROOT,
  coarsePointerSlugs,
  touchBaselineNames,
  touchBaselinePaths,
} from './touch-profile.ts';

describe('the touch-pointer profile', () => {
  it('is the phone width with a touch screen, apart from the three standard viewports', () => {
    expect(TOUCH_VIEWPORT).toEqual({ name: 'touch', width: 375, height: 900 });
    expect(VIEWPORTS.map((viewport) => viewport.name)).not.toContain('touch');
  });

  it('covers the components whose own styles have a coarse-pointer rule', () => {
    const slugs = coarsePointerSlugs();
    for (const slug of ['button', 'checkbox', 'chat', 'toggle']) expect(slugs).toContain(slug);
    expect(touchBaselineNames()).toEqual(['light-touch-assertion.png', 'dark-touch-assertion.png']);
  });

  it('has a baseline for every one of them, in both themes', () => {
    const missing = touchBaselinePaths().filter((path) => !existsSync(path));
    expect(missing).toEqual([]);
  });

  // The baselines and the profile agree both ways: no touch baseline is left for a component the
  // profile does not draw. A component whose coarse rule only widens an invisible hit area draws
  // the same pixels as at the phone width, so its touch baseline equals its mobile one (CI run
  // 44332908347 drew all 18 and compared nine of them clean against exactly that).
  it('keeps no touch baseline for a component the profile does not draw', () => {
    const drawn = new Set(touchBaselinePaths());
    const stray = readdirSync(BASELINE_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        readdirSync(join(BASELINE_ROOT, entry.name))
          .filter((name) => /-touch-/.test(name))
          .map((name) => join(BASELINE_ROOT, entry.name, name)),
      )
      .filter((path) => !drawn.has(path));
    expect(stray).toEqual([]);
  });

  it('is drawn by the root spec with a touch screen', () => {
    const spec = readFileSync(
      join(import.meta.dir, '..', 'tests', 'components.playwright.ts'),
      'utf8',
    );
    expect(spec).toContain('coarsePointerSlugs()');
    expect(spec).toMatch(/runFixtureSweep\([^)]*TOUCH_VIEWPORT[^)]*hasTouch: true/s);
  });
});
