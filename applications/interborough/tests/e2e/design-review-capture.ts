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
import { expect, type Page } from '@playwright/test';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { GEOMETRY_THRESHOLDS } from '@lostgradient/testing/design-review-geometry';
import { measureGeometry } from '@lostgradient/testing/design-review-geometry-probe';
import {
  designReviewCaptureDirectory,
  designReviewColorScheme,
} from '../../scripts/environment-configuration.ts';
import {
  E2E_FIRST_RUN_PORT,
  E2E_PLUGIN_PAGES_PORT,
  E2E_PORT,
  E2E_SHOWCASE_PORT,
} from './e2e-constants.ts';
import { test } from './fixtures.ts';

/** At or below this width a capture is of a phone, and is taken with a coarse pointer. */
const PHONE_WIDTH_MAXIMUM = GEOMETRY_THRESHOLDS.phoneWidthMaximum;

/**
 * Waits until the browser has laid out and painted a frame. It listens with a `ResizeObserver`,
 * whose first callback for an element comes in the next frame's rendering steps, after layout, and
 * never with `requestAnimationFrame`: a specification that stops the page's clock
 * (`page.clock.pauseAt`) stops its animation frames too, because the fake clock owns
 * `requestAnimationFrame`, so a wait on it never ended. Home's loading capture at 1280 timed out
 * that way once the activity bands made the page taller than its viewport and the capture took the
 * whole-page path (COR-2227). Two observations in turn, so the frame the first lands in has been
 * painted when the second lands; each is its own evaluation, so the second is never made inside
 * the first's callback, where the browser would skip it and report a ResizeObserver loop error.
 */
export async function nextFrame(page: Page): Promise<void> {
  for (let frame = 0; frame < 2; frame += 1) {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const observer = new ResizeObserver(() => {
            observer.disconnect();
            resolve();
          });
          observer.observe(document.documentElement);
        }),
    );
  }
}

/**
 * Temporarily enables Chromium's touch emulation for a non-touch page. Keep the existing pointer
 * mode when the test already uses touch. The override lives as long as its CDP session.
 */
async function emulateTouch(page: Page): Promise<() => Promise<void>> {
  if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) {
    return () => Promise.resolve();
  }
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await nextFrame(page);
  return async () => {
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await session.detach();
    await nextFrame(page);
  };
}

/** Runs capture work while preserving both the capture and pointer-cleanup failures. */
export async function withPointerCleanup<T>(
  operation: () => Promise<T>,
  restorePointer: () => Promise<void>,
): Promise<T> {
  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  try {
    await restorePointer();
  } catch (cleanupError) {
    if (operationError !== undefined) {
      const aggregateError = new AggregateError(
        [operationError, cleanupError],
        'Capture and pointer cleanup failed',
        { cause: operationError },
      );
      throw aggregateError;
    }
    throw cleanupError;
  }
  if (operationError !== undefined) throw operationError;
  return result as T;
}

/** The smallest phone the application supports, which every phone-width capture is repeated at. */
const SMALL_PHONE = { width: 320, height: 640 } as const;

/**
 * The wide desktop every 1280-pixel capture is repeated at, because the owner reads the application
 * on a screen this wide and a layout that holds at 1280 can still be wrong here: a column that
 * stretches, an action stranded at the far edge, a measure that runs past ninety characters. No
 * specification has to open this size itself, as none opens 320.
 */
const WIDE_DESKTOP = { width: 1920, height: 1080 } as const;

/** The width a capture is repeated at {@link WIDE_DESKTOP} from. */
const DESKTOP_WIDTH = 1280;

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
  /** Condition to re-prove after every helper viewport/remount change and immediately before pixels. */
  readonly ready?: ((page: Page) => Promise<void>) | undefined;
}

/** One line of `manifest.jsonl`. */
export interface DesignReviewManifestEntry extends DesignReviewCapture {
  readonly address: string;
  /** The content the page showed: `sample-world`, `stress`, `first-run`, `plugin-pages` or `e2e-host`. */
  readonly world: string;
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
  /** Named narrow-viewport profiles proved in this physical frame. */
  readonly witnesses?: readonly string[];
}

interface ViewportWitness {
  readonly row: string;
  readonly specification: string;
  readonly title: string;
  readonly route: string;
  readonly state: string;
  readonly world: string;
  readonly name: string;
  readonly width: number;
  readonly theme: 'light' | 'dark';
  readonly targets: readonly string[];
  readonly scrolling: 'none' | 'outlet';
}

function viewportWitnesses(): readonly ViewportWitness[] {
  const text = process.env['INTERBOROUGH_VIEWPORT_WITNESSES'];
  if (text === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed as ViewportWitness[];
  } catch {
    throw new Error('INTERBOROUGH_VIEWPORT_WITNESSES is not a valid witness manifest.');
  }
}

/** Playwright prefixes its grep title with the project, which TestInfo stores separately. */
export function physicalWitnessTitle(): string {
  const { project, titlePath } = test.info();
  return [project.name, ...titlePath].filter(Boolean).join(' ');
}

/**
 * Which content a page shows, from the host that served it: the sample world (the showcase host,
 * the boards' believable data), a fresh installation (the first-run host), the plugin-pages host,
 * or the main end-to-end host, which the responsive specification fills with the stress seed's
 * 300-character words and every other specification reads as it stands. A name that says only
 * `ready` never said which of them it showed.
 */
export function designReviewWorld(address: string, source: string): string {
  const port = Number(new URL(address).port);
  if (port === E2E_SHOWCASE_PORT) return 'sample-world';
  if (port === E2E_FIRST_RUN_PORT) return 'first-run';
  if (port === E2E_PLUGIN_PAGES_PORT) return 'plugin-pages';
  return port === E2E_PORT && source.startsWith('responsive') ? 'stress' : 'e2e-host';
}

/**
 * A file-name-safe slug of a capture's specification, world, route, tab, state, width and scheme.
 * The specification and the world lead, so two specifications that capture the same route in the
 * same state, or one route in two worlds, never write the same file.
 */
export function designReviewSlug(
  capture: DesignReviewCapture,
  width: number,
  colorScheme: 'light' | 'dark',
  world: string,
): string {
  const parts = [
    capture.source.replace(/\.spec\.ts$/, ''),
    world,
    capture.route,
    capture.tab ?? '',
    capture.state,
    `${width}`,
    colorScheme,
  ];
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

/**
 * Waits until every visible rendered Markdown table and code block has painted its text. Long
 * capture runs twice produced whole-page shots whose table and code frames were empty, a false
 * witness on exactly the screens a Markdown change touches. Each node is scrolled into view, so a
 * browser that defers offscreen paint renders it, given two frames, and then held to visible cell
 * text or settled, non-empty code. The outlet's scroll position is put back afterwards, so the shot
 * is of the page as its specification left it. A page with no Markdown node returns at once.
 */
export async function waitForMarkdownPaint(page: Page): Promise<void> {
  const nodes = page.locator('[data-cinder-markdown-node]:visible');
  const count = await nodes.count();
  if (count === 0) return;
  const outlet = page.locator('main.weft-shell-outlet');
  const scrollTop = await outlet.evaluate((element) => element.scrollTop);
  for (let index = 0; index < count; index += 1) {
    const node = nodes.nth(index);
    await node.scrollIntoViewIfNeeded();
    await nextFrame(page);
    const kind = await node.getAttribute('data-cinder-markdown-node');
    if (kind === 'table') {
      await expect(node.locator('td').filter({ hasText: /\S/ }).first()).toBeVisible();
    } else if (kind === 'code-block') {
      const block = node.locator('.cinder-code-block');
      await expect(block).not.toHaveAttribute('data-cinder-highlight-state', 'pending');
      await expect(block.locator('pre code').first()).toHaveText(/\S/);
      await expect(block.locator('pre code').first()).toBeVisible();
    }
  }
  await outlet.evaluate((element, top) => {
    element.scrollTop = top;
  }, scrollTop);
  await nextFrame(page);
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
    await capture.ready?.(page);
    await captureViewport(page, capture, directory, viewportSize, 'asked');
    if (viewportSize.width === DESKTOP_WIDTH) {
      await page.setViewportSize(WIDE_DESKTOP);
      await nextFrame(page);
      await capture.ready?.(page);
      await captureViewport(page, capture, directory, WIDE_DESKTOP, 'repeated');
      await page.setViewportSize(viewportSize);
      await nextFrame(page);
      await capture.ready?.(page);
    }
    return;
  }
  const restorePointer = await emulateTouch(page);
  await withPointerCleanup(async () => {
    await capture.ready?.(page);
    await captureViewport(page, capture, directory, viewportSize, 'asked');
    if (viewportSize.width !== SMALL_PHONE.width) {
      await page.setViewportSize(SMALL_PHONE);
      await nextFrame(page);
      await capture.ready?.(page);
      await captureViewport(page, capture, directory, SMALL_PHONE, 'repeated');
      await page.setViewportSize(viewportSize);
      await nextFrame(page);
      await capture.ready?.(page);
    }
  }, restorePointer);
}

/** The phone a state held only at a desktop width is captured at as well, with 320 by 640 after it. */
export const DESIGN_REVIEW_PHONE = { width: 375, height: 812 } as const;

/** The review widths for a state whose responsive menu treatment needs an explicit witness. */
const MENU_CAPTURE_VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 768, height: 900 },
  DESIGN_REVIEW_PHONE,
] as const;

/**
 * Captures one already-open menu at the standard desktop, tablet and phone widths. The ordinary
 * suite keeps its one interaction; only a design-review capture changes the viewport, while
 * {@link captureForDesignReview} derives 1920 from 1280 and 320 from the phone width.
 */
export async function captureOpenMenuForDesignReview(
  page: Page,
  capture: DesignReviewCapture,
): Promise<void> {
  if (designReviewCaptureDirectory() === undefined) return;
  const original = page.viewportSize();
  if (original === null) throw new Error('A design-review capture needs a fixed viewport.');
  try {
    for (const viewport of MENU_CAPTURE_VIEWPORTS) {
      await page.setViewportSize(viewport);
      await nextFrame(page);
      await captureForDesignReview(page, capture);
    }
  } finally {
    await page.setViewportSize(original);
    await nextFrame(page);
    await capture.ready?.(page);
  }
}

/**
 * Captures a state at the width the page is at and then at a phone (375, and so 320 as well), for a
 * state a specification holds only at a desktop width (COR-2489: Home's loading, still-loading,
 * one-card-fails, nothing-waiting and something-needs-you states were recorded only at 1280). The
 * viewport is put back after, so the specification's own assertions run at the width they expect.
 * In an ordinary run it does nothing and leaves the viewport alone.
 */
export async function captureForDesignReviewWithPhone(
  page: Page,
  capture: DesignReviewCapture,
): Promise<void> {
  if (designReviewCaptureDirectory() === undefined) return;
  await captureForDesignReview(page, capture);
  const viewportSize = page.viewportSize();
  if (viewportSize === null || viewportSize.width <= PHONE_WIDTH_MAXIMUM) return;
  await page.setViewportSize(DESIGN_REVIEW_PHONE);
  await nextFrame(page);
  try {
    await captureForDesignReview(page, capture);
  } finally {
    await page.setViewportSize(viewportSize);
    await nextFrame(page);
    await capture.ready?.(page);
  }
}

/**
 * The files this process has written, by directory and slug, and whether the specification asked
 * for the size or the helper repeated it (320 and 1920). A repeat of a screen the specification
 * took itself, or the specification taking a screen the helper repeated, is the same screen and
 * writes nothing twice; two screens the specification asked for under one name are an error,
 * because the second would overwrite the first and the review would read one of them as both.
 */
const written = new Map<string, 'asked' | 'repeated'>();

/** Screenshots and measures the page at the size it is at, and appends its line to the manifest. */
async function captureViewport(
  page: Page,
  capture: DesignReviewCapture,
  directory: string,
  viewportSize: { readonly width: number; readonly height: number },
  origin: 'asked' | 'repeated',
): Promise<void> {
  const colorScheme = designReviewColorScheme() ?? 'light';
  const world = designReviewWorld(page.url(), capture.source);
  const slug = designReviewSlug(capture, viewportSize.width, colorScheme, world);
  const key = `${directory}\0${slug}`;
  const earlier = written.get(key);
  if (earlier !== undefined) {
    if (earlier === 'repeated' || origin === 'repeated') return;
    throw new Error(
      `Two design-review captures resolve to ${slug}: give the second a state or a tab of its own.`,
    );
  }
  written.set(key, origin);
  await mkdir(join(directory, 'screens'), { recursive: true });

  await capture.ready?.(page);
  await waitForMarkdownPaint(page);

  const configuredWitnesses = viewportWitnesses();
  const title = configuredWitnesses.length === 0 ? undefined : physicalWitnessTitle();
  const file = configuredWitnesses.length === 0 ? undefined : test.info().file;
  const matchingWitnesses = configuredWitnesses.filter(
    (witness) =>
      file?.endsWith(witness.specification) &&
      witness.specification.endsWith(`/${capture.source}`) &&
      witness.title === title &&
      witness.route === capture.route &&
      witness.state === capture.state &&
      witness.world === world &&
      witness.width === viewportSize.width &&
      witness.theme === colorScheme,
  );
  for (const witness of matchingWitnesses) {
    for (const target of witness.targets) {
      const role = /^role:([a-z-]+):(.+)$/.exec(target);
      const locator =
        role === null
          ? page.getByTestId(target)
          : page.getByRole(role[1] as never, { name: role[2], exact: true });
      if (witness.scrolling === 'outlet') await locator.scrollIntoViewIfNeeded();
      await expect(locator).toHaveCount(1);
      const box = await locator.boundingBox();
      if (
        box === null ||
        box.x < 0 ||
        box.y < 0 ||
        box.x + box.width > viewportSize.width ||
        box.y + box.height > viewportSize.height
      )
        throw new Error(
          `Viewport witness ${witness.name} target ${target} is outside the viewport.`,
        );
    }
  }

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
    await capture.ready?.(page);
    await waitForMarkdownPaint(page);
    await page.screenshot({ path: join(directory, full), animations: 'disabled', caret: 'hide' });
    await page.setViewportSize(viewportSize);
    await nextFrame(page);
    await capture.ready?.(page);
  }

  const entry: DesignReviewManifestEntry = {
    ...capture,
    address: new URL(page.url()).pathname + new URL(page.url()).search,
    world,
    width: viewportSize.width,
    height: viewportSize.height,
    colorScheme,
    viewport,
    ...(matchingWitnesses.length === 0
      ? {}
      : { witnesses: matchingWitnesses.map(({ row, name }) => `${row}:${name}`) }),
    ...(full === undefined ? {} : { full }),
    ...(geometry === undefined ? {} : { geometry }),
    ...(geometryError === undefined ? {} : { geometryError }),
  };
  await appendFile(join(directory, 'manifest.jsonl'), `${JSON.stringify(entry)}\n`);
}
