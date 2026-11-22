/// <reference lib="dom" />
/**
 * COR-2539 (design correction round 3): a floating Copy button reserves its rail without widening
 * the block. A copyable block named by a 40-character label has no horizontal scroll (the closed
 * tooltip panel inside the floating button's transformed row was a `max-content` box that the
 * block's clipped, scrollable box had to reach), and a wrapping block reserves the rail beside its
 * first row only, so every further row keeps the whole width and the rail never breaks a URL that
 * would sit whole without it. Where a URL wider than a row breaks is
 * `code-block-breaks.playwright.ts`'s (COR-2548).
 */

import { loadManifest } from '@lostgradient/testing';
import {
  test,
  type ComponentPageFixture,
} from '@lostgradient/testing/playwright/component-page-fixture';
import { expect, type Page } from '@playwright/test';

const entry = loadManifest().find((candidate) => candidate.slug === 'code-block');
const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'rail');
const ENDPOINT = 'http://127.0.0.1:7439/bureau/mcp';

async function open(
  componentPage: ComponentPageFixture,
  width: number,
  theme: 'light' | 'dark' = 'light',
  metadataRail = false,
) {
  if (entry === undefined || fixture === undefined) throw new Error('No code block rail fixture.');
  const page = await componentPage.open({
    entry,
    theme,
    viewport: { name: width < 768 ? 'mobile' : 'desktop', width, height: 900 },
    fixtureName: 'rail',
    fixtureContentHash: fixture.fixtureContentHash,
  });
  if (metadataRail) {
    const route = new URL(page.url());
    route.searchParams.set('metadata-rail', '1');
    await page.goto(route.toString(), { waitUntil: 'load' });
  }
  return page;
}

async function readFloatingMetadataOverlap(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((host) => {
    const root = host.firstElementChild;
    const metadata = root?.firstElementChild?.querySelector('span');
    const viewport = root?.lastElementChild;
    const code = viewport?.querySelector('code');
    if (!(code instanceof HTMLElement) || !(metadata instanceof HTMLElement)) {
      throw new Error('No code or floating metadata.');
    }
    if (!(viewport instanceof HTMLElement)) throw new Error('No code viewport.');
    const metadataBox = metadata.getBoundingClientRect();
    const viewportBox = viewport.getBoundingClientRect();
    const visibleCode = () => {
      const rects: { top: number; right: number; bottom: number; left: number }[] = [];
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (!(node instanceof Text) || node.data.trim() === '') continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.right > viewportBox.left &&
            rect.left < viewportBox.right &&
            rect.bottom > viewportBox.top &&
            rect.top < viewportBox.bottom
          ) {
            rects.push({
              top: Math.max(rect.top, viewportBox.top),
              right: Math.min(rect.right, viewportBox.right),
              bottom: Math.min(rect.bottom, viewportBox.bottom),
              left: Math.max(rect.left, viewportBox.left),
            });
          }
        }
      }
      return rects;
    };
    const read = () => {
      const rects = visibleCode();
      return {
        visibleCode: rects.length,
        overlap: rects.filter(
          (rect) =>
            rect.right > metadataBox.left &&
            rect.left < metadataBox.right &&
            rect.bottom > metadataBox.top &&
            rect.top < metadataBox.bottom,
        ).length,
      };
    };
    viewport.scrollLeft = 0;
    const start = read();
    viewport.scrollLeft = viewport.scrollWidth;
    const end = read();
    viewport.scrollLeft = 0;
    return {
      measuredMetadataWidth:
        root instanceof HTMLElement
          ? root.style.getPropertyValue('--_cinder-code-block-float-meta-width')
          : '',
      metadataWidth: metadataBox.width,
      scrollable: viewport.scrollWidth > viewport.clientWidth,
      start,
      end,
    };
  });
}

async function readOneLineMetadataRail(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((host) => {
    const root = host.firstElementChild;
    const metadata = root?.querySelector(':scope > .cinder-code-block__meta');
    const viewport = root?.querySelector(':scope > .cinder-code-block__viewport');
    const code = viewport?.querySelector('code');
    if (
      !(root instanceof HTMLElement) ||
      !(metadata instanceof HTMLElement) ||
      !(viewport instanceof HTMLElement) ||
      !(code instanceof HTMLElement)
    ) {
      throw new Error('No one-line code block metadata rail.');
    }
    const codeRange = document.createRange();
    codeRange.selectNodeContents(code);
    const lineTops = new Set(
      [...codeRange.getClientRects()]
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => Math.round(rect.top)),
    );
    const rootBox = root.getBoundingClientRect();
    const metadataBox = metadata.getBoundingClientRect();
    const viewportBox = viewport.getBoundingClientRect();
    return {
      lineCount: lineTops.size,
      metadataWidth: metadataBox.width,
      rootHeight: rootBox.height,
      viewportRight: viewportBox.right,
      metadataLeft: metadataBox.left,
    };
  });
}

async function widths(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((host) => {
    const block = host.querySelector('.cinder-code-block');
    if (!(block instanceof HTMLElement)) throw new Error('No code block.');
    return {
      blockScroll: block.scrollWidth,
      blockClient: block.clientWidth,
      pageScroll: document.documentElement.scrollWidth,
      pageClient: document.documentElement.clientWidth,
    };
  });
}

/**
 * The boxes of a block's text, one range per text node (a range over the whole `code` element also
 * returns the border box of each line element, which runs edge to edge), with the copy button's box.
 * `fitToken` first narrows the block so that the first `fitToken` characters fit a full row with a
 * little to spare but not the first row, which gives up the rail.
 */
async function readText(page: Page, testId: string, options: { fitToken?: number } = {}) {
  return page.getByTestId(testId).evaluate(
    (host, { fitToken, endpoint }) => {
      const button = host.querySelector('.cinder-copy-button');
      const code = host.querySelector('.cinder-code-block__code');
      const viewport = host.querySelector('.cinder-code-block__viewport');
      const pre = host.querySelector('.cinder-code-block__pre');
      if (!(button instanceof HTMLElement) || !(code instanceof HTMLElement)) {
        throw new Error('No copy button or code.');
      }
      if (!(viewport instanceof HTMLElement) || !(pre instanceof HTMLElement)) {
        throw new Error('No viewport or pre.');
      }
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node instanceof Text && node.data.trim() !== '') nodes.push(node);
      }
      if (fitToken !== undefined) {
        // The first `fitToken` characters drawn on one row in the code's own font. A range over them
        // would be as wide as the rows they sit on, and the block breaks them at a slash.
        const probe = document.createElement('span');
        probe.style.whiteSpace = 'pre';
        probe.style.position = 'absolute';
        probe.style.visibility = 'hidden';
        probe.textContent = (code.textContent ?? '').slice(0, fitToken);
        code.append(probe);
        const token = probe.getBoundingClientRect().width;
        probe.remove();
        const padding = Number.parseFloat(getComputedStyle(pre).paddingInlineStart);
        (host as HTMLElement).style.inlineSize = `${Math.ceil(token + 2 * padding + 8)}px`;
      }
      const rects: { top: number; left: number; right: number; bottom: number }[] = [];
      for (const node of nodes) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.width > 0) rects.push(rect);
        }
      }
      /**
       * The rows the endpoint occupies: one when it sits whole, more when a row breaks it. The
       * endpoint is a box of its own (a word with slashes in it), so its rows are those of its text.
       */
      const endpointRowCount = () => {
        const word = [...code.querySelectorAll('.cinder-code-block__word')].find(
          (candidate) => candidate.textContent === endpoint,
        );
        if (word === undefined) return 0;
        const endpointRange = document.createRange();
        endpointRange.selectNodeContents(word);
        return new Set(
          [...endpointRange.getClientRects()]
            .filter((rect) => rect.width > 0)
            .map((rect) => Math.round(rect.top)),
        ).size;
      };
      const endpointRows = endpointRowCount();
      // The same block with its rail reserved at no width. A wrapped line hangs by two characters,
      // so a row after the first is narrower than a full row and the endpoint can break at 320
      // whatever the rail does; what the rail must not do is break it where it would sit whole.
      const root = host.querySelector('.cinder-code-block');
      if (!(root instanceof HTMLElement)) throw new Error('No code block.');
      root.style.setProperty('--_cinder-code-block-float-reserve', '0px');
      const endpointRowsWithoutRail = endpointRowCount();
      root.style.removeProperty('--_cinder-code-block-float-reserve');
      const rows = new Map<number, number>();
      for (const rect of rects) {
        const top = Math.round(rect.top);
        rows.set(top, Math.max(rows.get(top) ?? 0, rect.right));
      }
      const ordered = [...rows.entries()].toSorted(([first], [second]) => first - second);
      const box = button.getBoundingClientRect();
      // The rail is the copy button's whole box with its inset: its left edge is where a row
      // reserved down the whole block would have to stop.
      const meta = host.querySelector('.cinder-code-block__meta');
      if (!(meta instanceof HTMLElement)) throw new Error('No copy rail.');
      return {
        buttonLeft: box.left,
        railLeft: meta.getBoundingClientRect().left,
        rowRights: ordered.map(([, right]) => right),
        // Where a row of text may end: the line's own edge less its padding. A later row's glyphs
        // stop short of it wherever a word moves down whole, so the edge is read, not the glyphs.
        textEdge: (() => {
          const line = host.querySelector('.cinder-code-block__line');
          if (!(line instanceof HTMLElement)) throw new Error('No line.');
          return (
            line.getBoundingClientRect().right -
            Number.parseFloat(getComputedStyle(line).paddingInlineEnd)
          );
        })(),
        endpointRows,
        endpointRowsWithoutRail,
        scrolls: viewport.scrollWidth > viewport.clientWidth,
        // Text whose middle is level with the button and that reaches into it. The second row's
        // glyphs may touch the button's transparent lower edge, which is 24px tall against a row
        // of about 21px; their middle is below the button.
        underButton: rects.filter((rect) => {
          const middle = (rect.top + rect.bottom) / 2;
          return (
            rect.right > box.left &&
            rect.left < box.right &&
            middle > box.top &&
            middle < box.bottom
          );
        }).length,
      };
    },
    { fitToken: options.fitToken, endpoint: ENDPOINT },
  );
}

for (const width of [320, 375, 1280]) {
  test(`a copyable floating block named by a 40-character label has no sideways scroll at ${width}`, async ({
    componentPage,
  }) => {
    const page = await open(componentPage, width);
    await page.getByTestId('long-label').locator('.cinder-copy-button').waitFor();
    const reading = await widths(page, 'long-label');
    expect(reading.blockScroll).toBe(reading.blockClient);
    expect(reading.pageScroll).toBeLessThanOrEqual(reading.pageClient);
  });
}

for (const width of [320, 375]) {
  test(`a wrapping floating block reserves the rail beside its first row only at ${width}`, async ({
    componentPage,
  }) => {
    const page = await open(componentPage, width);
    await page.getByTestId('wrapped').locator('.cinder-copy-button').waitFor();
    const reading = await readText(page, 'wrapped');
    expect(reading.rowRights.length).toBeGreaterThan(1);
    // The first row stops before the button, and no text is under it.
    expect(reading.rowRights[0]!).toBeLessThanOrEqual(reading.buttonLeft);
    expect(reading.underButton).toBe(0);
    // A later row runs past the rail's left edge: the rail is not reserved down the whole block.
    // The button's own box sits inside the rail, so it is not the edge a row would stop at.
    expect(reading.textEdge).toBeGreaterThan(reading.railLeft);
    expect(reading.scrolls).toBe(false);
    // The rail never breaks the endpoint inside a word (…/bur | eau/mcp): it sits on as many rows
    // as it would with no rail, which is one wherever a row after the first, indented by the hang,
    // is wide enough for it (375). Where a wider one breaks is `code-block-breaks.playwright.ts`'s.
    expect(reading.endpointRows).toBeGreaterThan(0);
    expect(reading.endpointRows).toBe(reading.endpointRowsWithoutRail);
    if (width === 375) expect(reading.endpointRows).toBe(1);
  });
}

test('a wrapping block whose first word fits a full row but not the first row has no text under the button', async ({
  componentPage,
}) => {
  const page = await open(componentPage, 375);
  await page.getByTestId('long-first-word').locator('.cinder-copy-button').waitFor();
  const reading = await readText(page, 'long-first-word', { fitToken: ENDPOINT.length });
  expect(reading.underButton).toBe(0);
});

test('a scrolling floating block still keeps the rail on every row', async ({ componentPage }) => {
  const page = await open(componentPage, 375);
  const copy = page.getByTestId('scrolling').locator('.cinder-copy-button');
  await copy.waitFor();
  const reading = await page.getByTestId('scrolling').evaluate((host) => {
    const button = host.querySelector('.cinder-copy-button');
    const viewport = host.querySelector('.cinder-code-block__viewport');
    if (!(button instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
      throw new Error('No copy button or viewport.');
    }
    return {
      buttonLeft: button.getBoundingClientRect().left,
      viewportRight: viewport.getBoundingClientRect().right,
    };
  });
  // The scrollport ends before the button, so a scrolled line never runs under it.
  expect(reading.viewportRight).toBeLessThanOrEqual(reading.buttonLeft);
});

for (const theme of ['light', 'dark'] as const) {
  for (const width of [320, 1280]) {
    test(`floating language metadata reserves the visible code rail at ${width} in ${theme}`, async ({
      componentPage,
    }, testInfo) => {
      const page = await open(componentPage, width, theme, true);
      const reading = await readFloatingMetadataOverlap(page, 'floating-language');
      expect(reading.measuredMetadataWidth).not.toBe('');
      expect(reading.metadataWidth).toBeGreaterThan(0);
      expect(reading.start.visibleCode).toBeGreaterThan(0);
      expect(reading.start.overlap).toBe(0);
      if (reading.scrollable) {
        expect(reading.end.visibleCode).toBeGreaterThan(0);
        expect(reading.end.overlap).toBe(0);
      }
      for (const state of ['floating-language', 'wrapped']) {
        await testInfo.attach(`code-block-${state}-${width}-${theme}`, {
          body: await page.getByTestId(state).screenshot(),
          contentType: 'image/png',
        });
      }
    });

    test(`floating streaming status reserves the visible code rail at ${width} in ${theme}`, async ({
      componentPage,
    }, testInfo) => {
      const page = await open(componentPage, width, theme, true);
      const reading = await readFloatingMetadataOverlap(page, 'floating-streaming-status');
      expect(reading.measuredMetadataWidth).not.toBe('');
      expect(reading.metadataWidth).toBeGreaterThan(0);
      expect(reading.start.visibleCode).toBeGreaterThan(0);
      expect(reading.start.overlap).toBe(0);
      if (reading.scrollable) {
        expect(reading.end.visibleCode).toBeGreaterThan(0);
        expect(reading.end.overlap).toBe(0);
      }
      await testInfo.attach(`code-block-floating-streaming-status-${width}-${theme}`, {
        body: await page.getByTestId('floating-streaming-status').screenshot(),
        contentType: 'image/png',
      });
    });
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`one-line code keeps a long metadata rail inline at 1280 in ${theme}`, async ({
    componentPage,
  }) => {
    const page = await open(componentPage, 1280, theme, true);
    for (const testId of ['floating-language-one-line', 'floating-streaming-one-line']) {
      const reading = await readOneLineMetadataRail(page, testId);
      expect(reading.lineCount).toBe(1);
      expect(reading.metadataWidth).toBeGreaterThan(100);
      expect(reading.rootHeight).toBeLessThan(reading.metadataWidth);
      expect(reading.viewportRight).toBeLessThanOrEqual(reading.metadataLeft);
    }
  });
}

test('a wrapped floating language block gives later rows the full width', async ({
  componentPage,
}) => {
  const page = await open(componentPage, 320, 'light', true);
  const reading = await page.getByTestId('floating-language-wrapped').evaluate((host) => {
    const root = host.firstElementChild;
    const metadata = root?.firstElementChild;
    const code = root?.lastElementChild?.querySelector('code');
    if (!(code instanceof HTMLElement) || !(metadata instanceof HTMLElement)) {
      throw new Error('No wrapped code or metadata.');
    }
    const range = document.createRange();
    range.selectNodeContents(code);
    const rowRights = [...range.getClientRects()].map((rect) => rect.right);
    return { metadataLeft: metadata.getBoundingClientRect().left, rowRights };
  });
  expect(reading.rowRights.length).toBeGreaterThan(1);
  expect(Math.max(...reading.rowRights.slice(1))).toBeGreaterThan(reading.metadataLeft);
});
