/// <reference lib="dom" />
/**
 * COR-2548: a wrapping CodeBlock breaks a long URL at a slash, a dot, a colon, a hyphen or a quote,
 * never inside a word. A browser offers no break after a slash, so the command and the JSON that
 * Settings › MCP shows were cut wherever the line ended (`…/bureau/m` and `cp`), a place that moved
 * with the port. The reading follows each character of each line: where a character sits on a lower
 * row than the one before it, the one before it must be one of those five, or whitespace sits
 * between them. Plain code and highlighted code, at 320 and 375 pixels, in both themes.
 */

import { loadManifest } from '@lostgradient/testing';
import {
  test,
  type ComponentPageFixture,
} from '@lostgradient/testing/playwright/component-page-fixture';
import { expect, type Page } from '@playwright/test';

const entry = loadManifest().find((candidate) => candidate.slug === 'code-block');
const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'breaks');

const BLOCKS = [
  'plain-short',
  'highlighted-short',
  'plain-port',
  'highlighted-port',
  'plain-long-host',
  'highlighted-long-host',
] as const;

/** The blocks whose endpoint is wider than a row at every width this file reads. */
const WIDER_THAN_A_ROW = ['plain-long-host', 'highlighted-long-host'] as const;

async function open(componentPage: ComponentPageFixture, width: number, theme: 'light' | 'dark') {
  if (entry === undefined || fixture === undefined)
    throw new Error('No code block breaks fixture.');
  return componentPage.open({
    entry,
    theme,
    viewport: { name: 'mobile', width, height: 900 },
    fixtureName: 'breaks',
    fixtureContentHash: fixture.fixtureContentHash,
  });
}

/**
 * Every place a block's text moves to a lower row where the character before it is not a place to
 * break, as `before|after` pairs, with the number of rows the block's lines take in all.
 */
async function read(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((host) => {
    const allowed = new Set(['/', '.', ':', '-', '"']);
    const violations: string[] = [];
    let rows = 0;
    for (const line of host.querySelectorAll<HTMLElement>('.cinder-code-block__line')) {
      // A row is a line height apart; a glyph in a flag's box sits a pixel or two off the rest.
      const rowHeight = Number.parseFloat(getComputedStyle(line).lineHeight) || 20;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let previous: { character: string; top: number } | undefined;
      let spaceBetween = false;
      rows += 1;
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (!(node instanceof Text)) continue;
        // The text is ASCII, so a UTF-16 unit is a character.
        for (let index = 0; index < node.data.length; index += 1) {
          const character = node.data.charAt(index);
          if (/\s/.test(character)) {
            spaceBetween = true;
            continue;
          }
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          const rect = range.getClientRects()[0];
          if (rect === undefined) continue;
          if (previous !== undefined && rect.top - previous.top > rowHeight / 2) {
            rows += 1;
            if (!spaceBetween && !allowed.has(previous.character)) {
              violations.push(`${previous.character}|${character}`);
            }
          }
          previous = { character, top: rect.top };
          spaceBetween = false;
        }
      }
    }
    return { violations, rows };
  });
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [320, 375]) {
    test(`a wrapping block breaks a URL only at a slash, dot, colon, hyphen or quote at ${width} in the ${theme} theme`, async ({
      componentPage,
    }) => {
      const page = await open(componentPage, width, theme);
      for (const testId of BLOCKS) {
        if (testId.startsWith('highlighted-')) {
          await expect(page.getByTestId(testId).locator('.cinder-code-block')).toHaveAttribute(
            'data-cinder-highlight-state',
            'ready',
          );
          await expect(page.getByTestId(testId).locator('wbr').first()).toBeAttached();
        }
        const reading = await read(page, testId);
        expect(reading.violations, testId).toEqual([]);
        if ((WIDER_THAN_A_ROW as readonly string[]).includes(testId)) {
          // The endpoint is wider than a row, so the reading above had a break to judge.
          // The command is one line and the JSON is eight, so a break is one row more than that.
          expect(reading.rows, testId).toBeGreaterThan(testId.startsWith('plain-') ? 1 : 8);
        }
      }
    });
  }
}
