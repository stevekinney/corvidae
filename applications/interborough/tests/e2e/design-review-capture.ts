/**
 * Screenshots for the design review (`.agents/skills/design-review`). The responsive specification
 * and the view-states specification already open every route, on every tab, and every view in every
 * state, and wait until each page holds its content; when `INTERBOROUGH_DESIGN_REVIEW_CAPTURE` names
 * a directory (`scripts/design-review-capture.ts` sets it), they call `captureForDesignReview` at
 * that moment, before their own assertions, so a page that fails a check is still captured. In an
 * ordinary run the directory is unset and the call does nothing.
 *
 * Each capture writes the viewport as the person first sees it and, when the shell's outlet scrolls,
 * the whole page with the viewport stretched to the outlet's height. Each appends one line to
 * `manifest.jsonl` in the directory, and writes what the page measures (`design-review-geometry-probe.ts`)
 * to `geometry/<slug>.json` for the geometry audit. The suite runs one worker (`playwright.config.ts`), so the
 * appends never interleave.
 *
 * A phone has a finger, not a mouse, and Cinder sizes controls by pointer (`@media (pointer: coarse)`),
 * so a capture at a phone width turns touch emulation on for its screenshots and measurements and
 * off again before the specification's own assertions run. It also captures the page a second time
 * at 320 by 640, the smallest phone the application supports, where fixed chrome crowds the content
 * and overlays cover it first; no specification opens that size itself.
 */
import type { Page } from '@playwright/test';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { GEOMETRY_THRESHOLDS } from '../../scripts/design-review-geometry.ts';
import {
  designReviewCaptureDirectory,
  designReviewColorScheme,
} from '../../scripts/environment-configuration.ts';
import { measureGeometry } from './design-review-geometry-probe.ts';

/** At or below this width a capture is of a phone, and is taken with a coarse pointer. */
const PHONE_WIDTH_MAXIMUM = GEOMETRY_THRESHOLDS.phoneWidthMaximum;

async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/**
 * Turns on Chromium's touch emulation, which is what `(pointer: coarse)` follows, waits for the
 * layout, and answers the function that turns it off again. The override lives as long as its
 * session, so the session stays open until then.
 */
async function emulateTouch(page: Page): Promise<() => Promise<void>> {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await nextFrame(page);
  return async () => {
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await session.detach();
    await nextFrame(page);
  };
}

/** The smallest phone the application supports, which every phone-width capture is repeated at. */
const SMALL_PHONE = { width: 320, height: 640 } as const;

/** The tallest the viewport is stretched to for a whole-page capture, so a runaway list stays readable. */
const MAXIMUM_FULL_HEIGHT = 8000;

/** What a capture shows: the route, the state its frame is in, and the tab that is open, if any. */
export interface DesignReviewCapture {
  /** The route pattern from `src/app/routes.ts`, or a variant name such as `/runs (start picker)`. */
  readonly route: string;
  /** The frame's state: `ready`, `loading`, `empty`, `error`, `forbidden`, or a named case. */
  readonly state: string;
  /** The tab open in the outlet, when the capture is of one tab of the page. */
  readonly tab?: string;
  /** The specification the capture came from, so a reader can find the seed behind it. */
  readonly source: string;
}

/** One line of `manifest.jsonl`. */
export interface DesignReviewManifestEntry extends DesignReviewCapture {
  readonly address: string;
  readonly width: number;
  readonly height: number;
  readonly colorScheme: 'light' | 'dark';
  /** The viewport capture, relative to the capture directory. */
  readonly viewport: string;
  /** The whole-page capture, relative to the capture directory, when the outlet scrolls. */
  readonly full?: string;
  /** What the page measures, relative to the capture directory, for `scripts/design-review-geometry.ts`. */
  readonly geometry?: string;
  /** Why the page could not be measured, when the probe threw; the screenshots are still there. */
  readonly geometryError?: string;
}

/** A file-name-safe slug of a capture's route, state, tab, width and scheme. */
export function designReviewSlug(
  capture: DesignReviewCapture,
  width: number,
  colorScheme: 'light' | 'dark',
): string {
  const parts = [capture.route, capture.tab ?? '', capture.state, `${width}`, colorScheme];
  return parts
    .filter((part) => part !== '')
    .map((part) =>
      part
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, '-')
        .replaceAll(/^-|-$/g, ''),
    )
    .map((part) => (part === '' ? 'root' : part))
    .join('--');
}

/** Screenshots the page for the design review when a capture directory is set; otherwise nothing. */
export async function captureForDesignReview(
  page: Page,
  capture: DesignReviewCapture,
): Promise<void> {
  const directory = designReviewCaptureDirectory();
  if (directory === undefined) return;
  const viewportSize = page.viewportSize();
  if (viewportSize === null) throw new Error('A design-review capture needs a fixed viewport.');
  if (viewportSize.width > PHONE_WIDTH_MAXIMUM) {
    await captureViewport(page, capture, directory, viewportSize);
    return;
  }
  const restorePointer = await emulateTouch(page);
  try {
    await captureViewport(page, capture, directory, viewportSize);
    if (viewportSize.width !== SMALL_PHONE.width) {
      await page.setViewportSize(SMALL_PHONE);
      await nextFrame(page);
      await captureViewport(page, capture, directory, SMALL_PHONE);
      await page.setViewportSize(viewportSize);
    }
  } finally {
    await restorePointer();
  }
}

/** Screenshots and measures the page at the size it is at, and appends its line to the manifest. */
async function captureViewport(
  page: Page,
  capture: DesignReviewCapture,
  directory: string,
  viewportSize: { readonly width: number; readonly height: number },
): Promise<void> {
  const colorScheme = designReviewColorScheme() ?? 'light';
  const slug = designReviewSlug(capture, viewportSize.width, colorScheme);
  await mkdir(join(directory, 'screens'), { recursive: true });

  const viewport = `screens/${slug}.png`;
  await page.screenshot({
    path: join(directory, viewport),
    animations: 'disabled',
    caret: 'hide',
  });

  // Measured after the screenshot, so a probe that throws costs the measurement and not the capture.
  let geometry: string | undefined;
  let geometryError: string | undefined;
  try {
    const facts = await measureGeometry(page);
    await mkdir(join(directory, 'geometry'), { recursive: true });
    geometry = `geometry/${slug}.json`;
    await writeFile(join(directory, geometry), `${JSON.stringify(facts)}\n`);
  } catch (error) {
    geometry = undefined;
    geometryError = error instanceof Error ? error.message : String(error);
  }

  // The shell clips the document, so the outlet is what scrolls: stretch the viewport to hold it.
  const overflow = await page
    .locator('main.weft-shell-outlet')
    .evaluate((outlet) => outlet.scrollHeight - outlet.clientHeight);
  let full: string | undefined;
  if (overflow > 0) {
    full = `screens/${slug}.full.png`;
    const height = Math.min(viewportSize.height + overflow, MAXIMUM_FULL_HEIGHT);
    await page.setViewportSize({ width: viewportSize.width, height });
    await page.screenshot({ path: join(directory, full), animations: 'disabled', caret: 'hide' });
    await page.setViewportSize(viewportSize);
  }

  const entry: DesignReviewManifestEntry = {
    ...capture,
    address: new URL(page.url()).pathname + new URL(page.url()).search,
    width: viewportSize.width,
    height: viewportSize.height,
    colorScheme,
    viewport,
    ...(full === undefined ? {} : { full }),
    ...(geometry === undefined ? {} : { geometry }),
    ...(geometryError === undefined ? {} : { geometryError }),
  };
  await appendFile(join(directory, 'manifest.jsonl'), `${JSON.stringify(entry)}\n`);
}
