/**
 * The design-system build's headless-browser stages: capturing static renditions of previews too
 * large to ship as scripts, and the render check every card must pass.
 *
 * Both wait a fixed settle time after load, as the original generator did, because a preview's
 * examples can lay out over several frames (charts measure their container, editors load
 * lazily). The wait affects only how a card is measured; a missed frame changes a height, never
 * whether the check passes, since every failure it looks for is raised during mount.
 */

import { chromium, type Browser, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { cardWidthOf, measuredCardHeight } from './archetypes.ts';
import type { PreviewMeasurement, StaticSnapshot } from './components.ts';

const SNAPSHOT_SETTLE_MILLISECONDS = 800;
const CHECK_SETTLE_MILLISECONDS = 500;
const CHECK_WORKERS = 4;
const VIEWPORT_WIDTH = 760;

async function withBrowser<T>(work: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await chromium.launch();
  try {
    return await work(browser);
  } finally {
    await browser.close();
  }
}

/**
 * Renders each listed preview's `preview.full.js` against `bundle.css` and captures its DOM, with
 * the `<style>` tags the component injected, as a static rendition. Scripts and inline event
 * handlers are stripped from the captured markup.
 */
export async function captureStaticSnapshots(
  previewsDirectory: string,
  bundleCss: string,
  ids: string[],
): Promise<Map<string, StaticSnapshot>> {
  const snapshots = new Map<string, StaticSnapshot>();
  if (ids.length === 0) return snapshots;
  await withBrowser(async (browser) => {
    for (const id of ids) {
      const directory = join(previewsDirectory, id);
      const page = join(directory, 'snapshot.html');
      writeFileSync(
        page,
        `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(bundleCss).href}"></head><body><div id="cinder-preview"></div><script src="./preview.full.js"></script></body></html>`,
      );
      const tab = await browser.newPage({ viewport: { width: VIEWPORT_WIDTH, height: 900 } });
      const errors: string[] = [];
      tab.on('pageerror', (error) => errors.push(String(error)));
      await tab.goto(pathToFileURL(page).href);
      await tab.waitForTimeout(SNAPSHOT_SETTLE_MILLISECONDS);
      const captured = await tab.evaluate(() => {
        const root = document.getElementById('cinder-preview');
        if (!root) throw new Error('the preview has no #cinder-preview');
        return {
          styles: [...document.head.querySelectorAll('style')]
            .map((style) => style.textContent ?? '')
            .join('\n'),
          html: root.outerHTML,
          height: Math.ceil(root.getBoundingClientRect().height),
        };
      });
      await tab.close();
      const html = captured.html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/\son[a-z]+="[^"]*"/gi, '');
      snapshots.set(id, { styles: captured.styles, html, height: captured.height, errors });
    }
  });
  return snapshots;
}

/** One card's rendering in one theme. */
export type RenderResult = PreviewMeasurement & { text: number; failed: number; errors: string[] };

/** The outcome of {@link checkRenders}. */
export type RenderCheck = {
  /** Each card's rendering, keyed `<Export>:<theme>`. */
  results: Map<string, RenderResult>;
  /** One line per card and theme that logged an error, failed an example, or rendered empty. */
  problems: string[];
};

/**
 * Renders every card the way the Design System frame does, with `tokens.css` and `bundle.css`
 * linked and `data-theme` set, in light and dark, and records console errors, examples that could
 * not render, and the card's size.
 */
export async function checkRenders(
  projectDirectory: string,
  checkDirectory: string,
  names: string[],
): Promise<RenderCheck> {
  const tokensCss = pathToFileURL(join(projectDirectory, 'tokens.css')).href;
  const bundleCss = pathToFileURL(join(projectDirectory, 'components/bundle.css')).href;
  const results = new Map<string, RenderResult>();
  const problems: string[] = [];
  const queue = [...names];
  await withBrowser(async (browser) => {
    const worker = async () => {
      for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
        const source = join(projectDirectory, 'components', name);
        const directory = join(checkDirectory, name);
        mkdirSync(directory, { recursive: true });
        const html = readFileSync(join(source, 'preview.html'), 'utf8').replace(
          '<head>',
          `<head><link rel="stylesheet" href="${tokensCss}"><link rel="stylesheet" href="${bundleCss}">`,
        );
        writeFileSync(join(directory, 'index.html'), html);
        if (existsSync(join(source, 'preview.js'))) {
          copyFileSync(join(source, 'preview.js'), join(directory, 'preview.js'));
        }
        for (const theme of ['light', 'dark']) {
          const page = await browser.newPage({ viewport: { width: VIEWPORT_WIDTH, height: 600 } });
          const errors: string[] = [];
          page.on('console', (message) => {
            if (message.type() === 'error') errors.push(message.text().slice(0, 160));
          });
          page.on('pageerror', (error) => errors.push(String(error).slice(0, 160)));
          await page.goto(pathToFileURL(join(directory, 'index.html')).href);
          await page.evaluate(
            (value) => document.documentElement.setAttribute('data-theme', value),
            theme,
          );
          await page.waitForTimeout(CHECK_SETTLE_MILLISECONDS);
          const info = await page.evaluate(() => {
            const root = document.getElementById('cinder-preview') ?? document.body;
            const failed = [...document.querySelectorAll('.example-preview')].filter(
              (stage) => stage.textContent === 'This example could not render here.',
            ).length;
            return {
              height: Math.ceil(root.getBoundingClientRect().height),
              width: document.documentElement.scrollWidth,
              text: root.innerText.trim().length,
              failed,
            };
          });
          await page.close();
          const result = { ...info, errors };
          results.set(`${name}:${theme}`, result);
          if (errors.length > 0 || info.failed > 0 || info.height < 16) {
            problems.push(`${name} ${theme} ${JSON.stringify(result)}`);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: CHECK_WORKERS }, worker));
  });
  return { results, problems };
}

/** The outcome of {@link checkArchetypeRenders}. */
export type ArchetypeCheck = {
  /** One line per rendering that went wrong. */
  problems: string[];
  /** Each card's measured `@dsCard` height, by its folder name. */
  heights: Map<string, number>;
};

/** The widths an archetype card is rendered at: a phone and a desktop. */
const ARCHETYPE_VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 900 },
];

/**
 * Renders every archetype card with `tokens.css` and `bundle.css` linked, in light and dark, at a
 * phone and a desktop width, and returns one line per rendering that logged an error, rendered
 * empty, scrolled sideways, or drew a native select with its browser caret.
 */
export async function checkArchetypeRenders(
  projectDirectory: string,
  checkDirectory: string,
  names: string[],
): Promise<ArchetypeCheck> {
  const tokensCss = pathToFileURL(join(projectDirectory, 'tokens.css')).href;
  const bundleCss = pathToFileURL(join(projectDirectory, 'components/bundle.css')).href;
  const bundleScript = pathToFileURL(join(projectDirectory, 'components/bundle.js')).href;
  const problems: string[] = [];
  const heights = new Map<string, number>();
  if (names.length === 0) return { problems, heights };
  await withBrowser(async (browser) => {
    for (const name of names) {
      const directory = join(checkDirectory, name);
      mkdirSync(directory, { recursive: true });
      const source = readFileSync(
        join(projectDirectory, 'components', name, 'preview.html'),
        'utf8',
      );
      // A page that mounts a component from the bundle loads it from beside the cards; the check
      // page sits elsewhere, so the script is read from where the project keeps it.
      const html = source
        .replace('src="../bundle.js"', `src="${bundleScript}"`)
        .replace(
          '<head>',
          `<head><link rel="stylesheet" href="${tokensCss}"><link rel="stylesheet" href="${bundleCss}">`,
        );
      const mounts = source.includes('data-cinder-composer');
      writeFileSync(join(directory, 'index.html'), html);
      const settle = async (page: Page) => {
        if (!mounts) return;
        // The composer loads lazily after the bundle runs: wait for it to draw, then let it lay out.
        await page.waitForFunction(
          () => (document.querySelector('[data-cinder-composer]')?.childElementCount ?? 0) > 0,
          undefined,
          { timeout: 15_000 },
        );
        await page.waitForTimeout(CHECK_SETTLE_MILLISECONDS);
      };
      // The card's own height is measured at the card's width, in light, as a live preview's is.
      {
        const page = await browser.newPage({
          viewport: { width: cardWidthOf(source), height: 900 },
        });
        await page.goto(pathToFileURL(join(directory, 'index.html')).href);
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
        await settle(page).catch((error: unknown) =>
          problems.push(`${name} card did not draw its composer: ${String(error).slice(0, 160)}`),
        );
        heights.set(
          name,
          measuredCardHeight(
            await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height)),
          ),
        );
        await page.close();
      }
      for (const viewport of ARCHETYPE_VIEWPORTS) {
        for (const theme of ['light', 'dark']) {
          const page = await browser.newPage({
            viewport: { width: viewport.width, height: viewport.height },
          });
          const errors: string[] = [];
          page.on('console', (message) => {
            if (message.type() === 'error') errors.push(message.text().slice(0, 160));
          });
          page.on('pageerror', (error) => errors.push(String(error).slice(0, 160)));
          await page.goto(pathToFileURL(join(directory, 'index.html')).href);
          await page.evaluate(
            (value) => document.documentElement.setAttribute('data-theme', value),
            theme,
          );
          // The pages are static markup, so the load event is the whole render; only a page that
          // mounts its composer from the bundle waits for it.
          await settle(page).catch((error: unknown) =>
            errors.push(`composer did not draw: ${String(error).slice(0, 120)}`),
          );
          const info = await page.evaluate(() => ({
            height: Math.ceil(document.body.getBoundingClientRect().height),
            overflow: document.documentElement.scrollWidth > window.innerWidth,
            text: document.body.innerText.trim().length,
            caret: [...document.querySelectorAll('select')].filter(
              (select) => getComputedStyle(select).appearance !== 'none',
            ).length,
          }));
          await page.close();
          const where = `${name} ${viewport.name} ${theme}`;
          if (errors.length > 0) problems.push(`${where} logged ${JSON.stringify(errors)}`);
          if (info.height < 16 || info.text === 0) problems.push(`${where} rendered empty`);
          if (info.overflow) problems.push(`${where} scrolls sideways`);
          if (info.caret > 0) problems.push(`${where} shows the browser's select caret`);
        }
      }
    }
  });
  return { problems, heights };
}
