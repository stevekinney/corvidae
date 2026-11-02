/**
 * Renders Claude Design boards (`<Board>.dc.html`) to PNG for the design review
 * (`.agents/skills/design-review`), with no browser session and no sign-in. A board is the HTML the
 * `Artifact` tool's read returns for `project/<Board>.dc.html`; it loads the canvas runtime from
 * `./support.js`, which is the canvas's `artifact-type/dc-runtime.js` saved beside the boards.
 *
 *   bun scripts/design-review-render-boards.ts --boards <dir> [--out <dir>] [<Board>.dc.html …]
 *
 * It serves the boards directory, opens each board in headless Chromium at the board's own
 * `$preview` width, waits until the runtime has mounted the board (it consumes every `x-dc` element
 * it renders, so none remains, and the page holds at least {@link MINIMUM_TEXT_LENGTH} characters of
 * text) and its fonts have loaded, and writes `<Board>.png` of the whole board. A
 * board taller than {@link SLICE_THRESHOLD} pixels also gets `<Board>--part<n>.png` slices of
 * {@link SLICE_HEIGHT} pixels, because a tall board scaled into one image is too small to read.
 * With no board names it renders every `.dc.html` in the directory. `--out` defaults to the boards
 * directory, so each render sits beside its source under the same stem, as the review expects.
 *
 * A board fails when it clips its own content: a container at least {@link CLIP_MINIMUM_HEIGHT}
 * pixels tall that hides content below its bottom edge (a root left at an earlier, shorter height
 * with `overflow: hidden` hides every frame added since), or anything drawn past the board's width.
 * The renders are still written, so the clipping can be seen.
 *
 * Exit 0 when every board rendered, 1 when one logged a page error, never mounted or clipped its
 * content (each named), 2 on bad usage or a missing `support.js`.
 */
import { chromium, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { HANG_GUARD_MILLISECONDS } from '../../../testing/testing/src/hang-guard.ts';

/** A board renders as mounted once it holds at least this much text. */
export const MINIMUM_TEXT_LENGTH = 40;
/** A board taller than this also gets readable slices. */
export const SLICE_THRESHOLD = 1400;
/** The height of each slice. */
export const SLICE_HEIGHT = 1200;

const DEFAULT_PREVIEW = { width: 1440, height: 1000 } as const;

/** A container this tall or taller that hides content is a clipped board, not a clamped line of text. */
export const CLIP_MINIMUM_HEIGHT = 200;

/** What the browser measured about a board's layout. */
export interface BoardLayout {
  /** Containers at least {@link CLIP_MINIMUM_HEIGHT} tall that hide content below their bottom edge. */
  readonly clipped: readonly { readonly clientHeight: number; readonly scrollHeight: number }[];
  /** The rightmost edge of anything drawn on the board. */
  readonly rightmostEdge: number;
  /** The board's width. */
  readonly width: number;
}

/** The layout problem a board has, or `undefined` when it draws inside its own bounds. */
export function layoutProblem(layout: BoardLayout): string | undefined {
  const [first] = layout.clipped;
  if (first !== undefined) {
    return `clips its content: a container ${first.clientHeight}px tall holds ${first.scrollHeight}px`;
  }
  if (layout.rightmostEdge > layout.width + 1) {
    return `draws past its width: content reaches ${Math.round(layout.rightmostEdge)}px of ${layout.width}px`;
  }
  return undefined;
}

/** The size a board asks to be previewed at, from its `$preview` declaration. */
export function previewSize(source: string): { width: number; height: number } {
  const match = /"\$preview"\s*:\s*\{\s*"width"\s*:\s*(\d+)\s*,\s*"height"\s*:\s*(\d+)/.exec(
    source,
  );
  if (match === null) return { ...DEFAULT_PREVIEW };
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** The top offset and height of each slice of a board `height` pixels tall, or none when it fits. */
export function sliceOffsets(height: number): { top: number; height: number }[] {
  if (height <= SLICE_THRESHOLD) return [];
  const slices: { top: number; height: number }[] = [];
  for (let top = 0; top < height; top += SLICE_HEIGHT) {
    slices.push({ top, height: Math.min(SLICE_HEIGHT, height - top) });
  }
  return slices;
}

/** The parsed command line. */
interface Options {
  readonly boards: string;
  readonly out: string;
  readonly names: readonly string[];
}

/** Reads the command line, or answers the usage error to print. */
export function parseArguments(argv: readonly string[]): Options | string {
  let boards: string | undefined;
  let out: string | undefined;
  const names: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--boards' || argument === '--out') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) return `${argument} needs a value`;
      index += 1;
      if (argument === '--boards') boards = resolve(value);
      else out = resolve(value);
    } else if (argument.startsWith('--')) {
      return `unknown flag ${argument}`;
    } else if (argument.endsWith('.dc.html')) {
      names.push(argument);
    } else {
      return `${argument} is not a .dc.html board`;
    }
  }
  if (boards === undefined) return '--boards is required';
  return { boards, out: out ?? boards, names };
}

/** Renders one board and answers the problem, if any. */
async function renderBoard(page: Page, origin: string, name: string, out: string) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`${origin}/${encodeURIComponent(name)}`);
  const mounted = await page
    .waitForFunction(
      (minimum) =>
        document.querySelector('x-dc') === null && document.body.innerText.length >= minimum,
      MINIMUM_TEXT_LENGTH,
      { timeout: HANG_GUARD_MILLISECONDS },
    )
    .then(() => true)
    .catch(() => false);
  await page.evaluate(() => document.fonts.ready);
  const stem = name.replace(/\.dc\.html$/, '');
  await page.screenshot({ path: join(out, `${stem}.png`), fullPage: true });
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const width = page.viewportSize()?.width ?? DEFAULT_PREVIEW.width;
  const slices = sliceOffsets(height);
  for (const [index, slice] of slices.entries()) {
    await page.screenshot({
      path: join(out, `${stem}--part${index + 1}.png`),
      fullPage: true,
      clip: { x: 0, y: slice.top, width, height: slice.height },
    });
  }
  const layout = await page.evaluate(
    ({ minimum, boardWidth }) => {
      const elements = [...document.body.querySelectorAll<HTMLElement>('*')];
      const clipped = elements
        .filter((element) => {
          const overflow = getComputedStyle(element).overflowY;
          return (
            (overflow === 'hidden' || overflow === 'clip') &&
            element.clientHeight >= minimum &&
            element.scrollHeight > element.clientHeight + 4
          );
        })
        .map((element) => ({
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
        }));
      const rightmostEdge = Math.max(
        0,
        ...elements.map((element) => element.getBoundingClientRect().right),
      );
      return { clipped, rightmostEdge, width: boardWidth };
    },
    { minimum: CLIP_MINIMUM_HEIGHT, boardWidth: width },
  );
  const problem = !mounted
    ? 'never mounted (an x-dc element remained, or the board held no text)'
    : errors.length > 0
      ? `logged ${errors.length} error(s): ${errors[0]?.slice(0, 160) ?? ''}`
      : layoutProblem(layout);
  return { stem, height, slices: slices.length, problem };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (typeof options === 'string') {
    process.stderr.write(`${options}\n`);
    process.exitCode = 2;
    return;
  }
  if (!existsSync(join(options.boards, 'support.js'))) {
    process.stderr.write(
      `${options.boards} has no support.js: save the canvas's artifact-type/dc-runtime.js there under that name.\n`,
    );
    process.exitCode = 2;
    return;
  }
  const files = await readdir(options.boards);
  const names =
    options.names.length > 0
      ? options.names
      : files.filter((file) => file.endsWith('.dc.html')).toSorted();
  await mkdir(options.out, { recursive: true });
  const root = options.boards;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = resolve(root, `.${decodeURIComponent(new URL(request.url).pathname)}`);
      if (relative(root, path).startsWith('..')) return new Response('Not found', { status: 404 });
      return new Response(Bun.file(path));
    },
  });
  const browser = await chromium.launch();
  let failures = 0;
  try {
    for (const name of names) {
      const source = await readFile(join(root, name), 'utf8');
      const page = await browser.newPage({ viewport: previewSize(source), deviceScaleFactor: 1 });
      const result = await renderBoard(page, `http://127.0.0.1:${server.port}`, name, options.out);
      await page.close();
      if (result.problem !== undefined) failures += 1;
      process.stdout.write(
        `${result.stem}: ${result.height}px${result.slices > 0 ? `, ${result.slices} slices` : ''}${result.problem === undefined ? '' : `; ${result.problem}`}\n`,
      );
    }
  } finally {
    await browser.close();
    await server.stop(true);
  }
  process.exitCode = failures > 0 ? 1 : 0;
}

if (import.meta.main) await main();
