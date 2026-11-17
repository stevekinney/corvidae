/**
 * The root Chromium baselines hold a touch-pointer profile for every component with an
 * `any-pointer: coarse` rule (COR-2440), and the spec draws it.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TOUCH_VIEWPORT, VIEWPORTS } from '@lostgradient/testing';

import { coarsePointerSlugs, touchBaselineNames, touchBaselinePaths } from './touch-profile.ts';

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

  it('is drawn by the root spec with a touch screen', () => {
    const spec = readFileSync(
      join(import.meta.dir, '..', 'tests', 'components.playwright.ts'),
      'utf8',
    );
    expect(spec).toContain('coarsePointerSlugs()');
    expect(spec).toMatch(/runFixtureSweep\([^)]*TOUCH_VIEWPORT[^)]*hasTouch: true/s);
  });
});
