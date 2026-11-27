/// <reference lib="dom" />
/**
 * COR-2539 (design correction round 3): an address breaks after its slashes, colons and question
 * marks, and after a dot only when a part is longer than the line. A host and a file extension stay
 * whole (`127.0.0.|1`, `json` alone on a row), the browser's own break after a hyphen does not win
 * (`well-`, `agent-`), and the copy control stays on the address's last row.
 */

import { loadManifest } from '@lostgradient/testing';
import { test } from '@lostgradient/testing/playwright/component-page-fixture';
import { expect, type Page } from '@playwright/test';

const entry = loadManifest().find((candidate) => candidate.slug === 'copyable-value');
const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'addresses');

async function open(page: Page): Promise<void> {
  await page.getByTestId('a2a-value').getByRole('button').waitFor();
}

/** The height of one row of the address, read from `http://`, which is never broken. */
async function measure(page: Page, testId: string, width: number | 'max-content') {
  return page.getByTestId(testId).evaluate((paragraph, size) => {
    paragraph.style.inlineSize = typeof size === 'number' ? `${size}px` : size;
    const root = paragraph.firstElementChild;
    if (!(root instanceof HTMLElement)) throw new Error('No address.');
    const parts = [...root.querySelectorAll<HTMLElement>(':scope > .cinder-copyable-value__part')];
    const boxes = parts.map((part) => {
      const pieces = [
        ...part.querySelectorAll<HTMLElement>(':scope > .cinder-copyable-value__piece'),
      ];
      return { part, pieces: pieces.length > 0 ? pieces : [part] };
    });
    const row = parts[0]!.getBoundingClientRect().height;
    const control = root.querySelector('button')!.getBoundingClientRect();
    const lastBox = boxes.at(-1)!.part.getBoundingClientRect();
    return {
      row,
      partWidths: parts.map((part) => part.getBoundingClientRect().width),
      pieceWidths: boxes.flatMap(({ pieces }) =>
        pieces.map((piece) => piece.getBoundingClientRect().width),
      ),
      partHeights: parts.map((part) => part.getBoundingClientRect().height),
      pieceHeights: boxes.flatMap(({ pieces }) =>
        pieces.map((piece) => piece.getBoundingClientRect().height),
      ),
      // The text of each piece, without the control (whose tooltip is text of its own).
      texts: boxes.map(({ pieces }) =>
        pieces.map((piece) => {
          const copy = piece.cloneNode(true) as HTMLElement;
          for (const control of copy.querySelectorAll('.cinder-copyable-value__control')) {
            control.remove();
          }
          return copy.textContent ?? '';
        }),
      ),
      rowCount: new Set(parts.flatMap((part) => [Math.round(part.getBoundingClientRect().top)]))
        .size,
      controlBottom: control.bottom,
      controlTop: control.top,
      lastTop: lastBox.top,
      lastBottom: lastBox.bottom,
    };
  }, width);
}

for (const testId of ['a2a', 'mcp']) {
  test(`the ${testId} address keeps each part whole while a part fits the line`, async ({
    componentPage,
  }) => {
    if (entry === undefined || fixture === undefined) throw new Error('No addresses fixture.');
    const page = await componentPage.open({
      entry,
      theme: 'light',
      viewport: { name: 'mobile', width: 375, height: 700 },
      fixtureName: 'addresses',
      fixtureContentHash: fixture.fixtureContentHash,
    });
    await open(page);

    const natural = await measure(page, testId, 'max-content');
    const widest = Math.max(...natural.partWidths);
    // A place just wide enough for the widest part, so the address must break between parts and
    // no part may break inside itself.
    const narrow = await measure(page, testId, Math.ceil(widest) + 2);
    // One row, with room for the control (a box taller than a text row) but never for two rows.
    expect(narrow.partHeights.every((height) => height < narrow.row * 1.5)).toBe(true);
    expect(narrow.rowCount).toBeGreaterThan(1);
    // The control is on the address's last row, beside the last part, not alone below it.
    expect(narrow.controlTop).toBeLessThan(narrow.lastBottom);
    expect(narrow.controlBottom).toBeGreaterThan(narrow.lastTop);

    // A place narrower than a part: the part breaks after a dot, never inside a piece, while a
    // piece fits the line.
    const widestPiece = Math.max(...natural.pieceWidths);
    const tight = await measure(page, testId, Math.ceil(widestPiece) + 2);
    expect(tight.pieceHeights.every((height) => height < tight.row * 1.5)).toBe(true);
    expect(tight.controlTop).toBeLessThan(tight.lastBottom);
    expect(tight.controlBottom).toBeGreaterThan(tight.lastTop);
  });
}

test('the A2A address keeps its host and its file extension whole, and breaks at no hyphen', async ({
  componentPage,
}) => {
  if (entry === undefined || fixture === undefined) throw new Error('No addresses fixture.');
  const page = await componentPage.open({
    entry,
    theme: 'light',
    viewport: { name: 'mobile', width: 375, height: 700 },
    fixtureName: 'addresses',
    fixtureContentHash: fixture.fixtureContentHash,
  });
  await open(page);
  const natural = await measure(page, 'a2a', 'max-content');
  const narrow = await measure(page, 'a2a', Math.ceil(Math.max(...natural.partWidths)) + 2);
  // The host is one part and the file name is one part: no part is cut at a dot or a hyphen, so
  // `127.0.0.1:` and `agent-card.json` each sit on one row.
  expect(narrow.texts.map((pieces) => pieces.join(''))).toContain('127.0.0.1:');
  const hostIndex = narrow.texts.findIndex((pieces) => pieces.join('') === '127.0.0.1:');
  const fileIndex = narrow.texts.findIndex((pieces) => pieces.join('').startsWith('agent-card.'));
  expect(hostIndex).toBeGreaterThanOrEqual(0);
  expect(fileIndex).toBeGreaterThanOrEqual(0);
  expect(narrow.partHeights[hostIndex]).toBeLessThan(narrow.row * 1.5);
  expect(narrow.partHeights[fileIndex]).toBeLessThan(narrow.row * 1.5);
});

// COR-2548: after "The API is at" the address broke between two of its parts ("127.0.0.1:" and
// "7399/api") at 320 pixels although it fits a row of its own. The whole value is one box now, so it
// moves below the words whole.
test('an address that fits a row moves below the words before it whole, never ending the row between its parts', async ({
  componentPage,
}) => {
  if (entry === undefined || fixture === undefined) throw new Error('No addresses fixture.');
  const page = await componentPage.open({
    entry,
    theme: 'light',
    viewport: { name: 'mobile', width: 320, height: 700 },
    fixtureName: 'addresses',
    fixtureContentHash: fixture.fixtureContentHash,
  });
  await open(page);
  const reading = await page.getByTestId('lead').evaluate((paragraph) => {
    const root = paragraph.querySelector<HTMLElement>('.cinder-copyable-value');
    const lead = paragraph.firstChild;
    if (root === null || lead === null) throw new Error('No address or lead.');
    // A place wider than the address alone but narrower than the words and the address together.
    const alone = root.getBoundingClientRect().width;
    paragraph.style.inlineSize = `${Math.ceil(alone) + 4}px`;
    const words = document.createRange();
    words.selectNodeContents(lead);
    const wordsBottom = Math.max(...[...words.getClientRects()].map((rect) => rect.bottom));
    const parts = [...root.querySelectorAll<HTMLElement>(':scope > .cinder-copyable-value__part')];
    return {
      // The parts that start on a lower row than the first. The part that holds the control is
      // taller than a text row, so its top sits a pixel or two above the rest of its row: a row is
      // a line height apart, not a pixel.
      partsOnLaterRows: parts.filter(
        (part) =>
          part.getBoundingClientRect().top >
          parts[0]!.getBoundingClientRect().top + parts[0]!.getBoundingClientRect().height / 2,
      ).length,
      belowTheWords: root.getBoundingClientRect().top >= wordsBottom - 1,
      fits: root.getBoundingClientRect().right <= paragraph.getBoundingClientRect().right + 1,
    };
  });
  expect(reading.partsOnLaterRows).toBe(0);
  expect(reading.belowTheWords).toBe(true);
  expect(reading.fits).toBe(true);
});

for (const width of [320, 375]) {
  test(`a long storage location and its Copy target fit a ${width}px touch viewport`, async ({
    componentPage,
  }) => {
    if (entry === undefined || fixture === undefined) throw new Error('No addresses fixture.');
    const page = await componentPage.open({
      entry,
      theme: 'light',
      viewport: { name: 'mobile', width, height: 700 },
      fixtureName: 'addresses',
      fixtureContentHash: fixture.fixtureContentHash,
      hasTouch: true,
    });
    await open(page);
    const location = page.getByTestId('storage-location');
    const control = location.getByRole('button', { name: 'Copy storage location', exact: true });
    const fit = await location.evaluate((paragraph) => {
      const root = paragraph.querySelector<HTMLElement>('.cinder-copyable-value');
      const end = paragraph.querySelector<HTMLElement>('.cinder-copyable-value__end');
      const button = paragraph.querySelector<HTMLElement>('button');
      if (root === null || end === null || button === null)
        throw new Error('No storage copy control.');
      const range = document.createRange();
      range.selectNodeContents(root);
      const text = [...range.getClientRects()].filter((rect) => rect.width > 0);
      const frame = paragraph.getBoundingClientRect();
      const control = button.getBoundingClientRect();
      const finalCharacter = end.getBoundingClientRect();
      return {
        left: Math.min(...text.map((rect) => rect.left)),
        right: Math.max(...text.map((rect) => rect.right)),
        frameLeft: frame.left,
        frameRight: frame.right,
        controlLeft: control.left,
        controlRight: control.right,
        controlTop: control.top,
        controlBottom: control.bottom,
        finalTop: finalCharacter.top,
        finalBottom: finalCharacter.bottom,
      };
    });
    expect(fit.left).toBeGreaterThanOrEqual(Math.floor(fit.frameLeft));
    expect(fit.right).toBeLessThanOrEqual(Math.ceil(fit.frameRight));
    expect(fit.controlLeft).toBeGreaterThanOrEqual(Math.floor(fit.frameLeft));
    expect(fit.controlRight).toBeLessThanOrEqual(Math.ceil(fit.frameRight));
    expect(fit.controlTop).toBeLessThan(fit.finalBottom);
    expect(fit.controlBottom).toBeGreaterThan(fit.finalTop);
    await control.tap();
  });
}
