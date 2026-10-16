import {
  isScreenshotInComponentScope,
  loadManifest,
  THEMES,
  VIEWPORTS,
} from '@lostgradient/testing';

import { TERMINAL_FIXTURE_NAMES } from '../src/fixtures/terminal/scenarios.ts';
import { expect, test } from './component-page-fixture.ts';
import { runFixtureSweep } from './component-sweep.ts';

/**
 * The resting baselines of the terminal's visual fixtures (`documentation/terminal/experience.md`),
 * in both themes at the harness's three viewports. They run through the same sweep as every other
 * component, with the same screenshot tolerance and the same accessibility gate, and belong to
 * Chromium alone; `components.playwright.ts` leaves this entry to this file so each baseline has
 * one owner.
 */
const entry = loadManifest().find((candidate) => candidate.slug === 'terminal');
expect(entry, 'the terminal fixture group must be in the fixture manifest').toBeDefined();
const fixtures = entry?.fixtures ?? [];

test('the screenshot scope includes the terminal, so every cell captures an image', () => {
  // A leftover CINDER_TEST_COMPONENTS that leaves the terminal out makes the capture helper skip
  // every image while every cell still passes.
  expect(isScreenshotInComponentScope('terminal')).toBe(true);
});

test('every required terminal visual fixture is in the manifest', () => {
  expect(fixtures.map((fixture) => fixture.name).toSorted()).toEqual(
    [...TERMINAL_FIXTURE_NAMES].toSorted(),
  );
  expect(TERMINAL_FIXTURE_NAMES.length).toBeGreaterThanOrEqual(13);
});

test.describe('terminal', () => {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      for (const fixture of fixtures) {
        test(`${theme}-${viewport.name}-${fixture.name}`, async ({ componentPage }) => {
          await runFixtureSweep(componentPage, entry!, theme, viewport, fixture);
        });
      }
    }
  }
});
