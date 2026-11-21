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

async function open(componentPage: ComponentPageFixture, width: number) {
  if (entry === undefined || fixture === undefined) throw new Error('No code block rail fixture.');
  return componentPage.open({
    entry,
    theme: 'light',
    viewport: { name: width < 768 ? 'mobile' : 'desktop', width, height: 900 },
    fixtureName: 'rail',
    fixtureContentHash: fixture.fixtureContentHash,
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
    expect(Math.max(...reading.rowRights.slice(1))).toBeGreaterThan(reading.railLeft);
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
