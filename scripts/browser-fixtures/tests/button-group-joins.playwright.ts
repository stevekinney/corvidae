/// <reference lib="dom" />
/**
 * A ButtonGroup is one continuous shape: only its outer corners are rounded, every inner join is
 * square with one hairline seam, a vertical group's outer corners are capped at the control
 * radius (never a pill's), a member wrapped in a Tooltip or a Dropdown fills its place like a bare
 * Button, and a split button's two halves are the same variant and height. Read in a browser on
 * the `joins` fixture in both themes, for two to four members in three variants.
 */

import { loadManifest } from '@lostgradient/testing';
import { expect, type Page } from '@playwright/test';
import { test } from './component-page-fixture.ts';

const entry = loadManifest().find((candidate) => candidate.slug === 'button-group');
const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'joins');

type Member = {
  /** Top-left, top-right, bottom-right, bottom-left radius in pixels. */
  radii: number[];
  /** Top, right, bottom, left border colour. */
  borders: string[];
  background: string;
  variant: string | null;
  box: { left: number; top: number; right: number; bottom: number };
};

const TRANSPARENT = 'rgba(0, 0, 0, 0)';
const CONTROL_RADIUS = 8;

async function members(page: Page, testId: string): Promise<Member[]> {
  return page.getByTestId(testId).evaluate((host) =>
    [...host.querySelectorAll('.cinder-button-group > *')].map((item) => {
      const control = item.matches('button') ? item : item.querySelector('button');
      if (control === null) throw new Error('A member has no button.');
      const style = getComputedStyle(control);
      const box = control.getBoundingClientRect();
      return {
        radii: [
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomRightRadius,
          style.borderBottomLeftRadius,
        ].map((value) => Number.parseFloat(value)),
        borders: [
          style.borderTopColor,
          style.borderRightColor,
          style.borderBottomColor,
          style.borderLeftColor,
        ],
        background: style.backgroundColor,
        variant: control.getAttribute('data-cinder-variant'),
        box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      };
    }),
  );
}

function expectVertical(list: Member[], id: string): void {
  list.forEach((member, index) => {
    const first = index === 0;
    const last = index === list.length - 1;
    const [topLeft, topRight, bottomRight, bottomLeft] = member.radii;
    expect([topLeft, topRight], `${id} #${index} top corners`).toEqual(
      first ? [CONTROL_RADIUS, CONTROL_RADIUS] : [0, 0],
    );
    expect([bottomRight, bottomLeft], `${id} #${index} bottom corners`).toEqual(
      last ? [CONTROL_RADIUS, CONTROL_RADIUS] : [0, 0],
    );
    // One straight column: every member as wide as the first, each starting where the last ends.
    expect(Math.round(member.box.left), `${id} #${index} left`).toBe(Math.round(list[0]!.box.left));
    expect(Math.round(member.box.right), `${id} #${index} right`).toBe(
      Math.round(list[0]!.box.right),
    );
    if (!first) {
      expect(Math.abs(member.box.top - list[index - 1]!.box.bottom)).toBeLessThanOrEqual(0.5);
      // The seam is the group's 1px line, never a doubled border: the facing edges are clear.
      expect(member.borders[0], `${id} #${index} top border`).toBe(TRANSPARENT);
      expect(list[index - 1]!.borders[2], `${id} #${index - 1} bottom border`).toBe(TRANSPARENT);
    }
  });
}

function expectHorizontal(list: Member[], id: string, rightToLeft = false): void {
  list.forEach((member, index) => {
    const first = index === 0;
    const last = index === list.length - 1;
    const [topLeft, topRight, bottomRight, bottomLeft] = member.radii;
    const leading = rightToLeft ? [topRight, bottomRight] : [topLeft, bottomLeft];
    const trailing = rightToLeft ? [topLeft, bottomLeft] : [topRight, bottomRight];
    for (const corner of leading) {
      if (first) expect(corner, `${id} #${index} outer start`).toBeGreaterThan(0);
      else expect(corner, `${id} #${index} inner start`).toBe(0);
    }
    for (const corner of trailing) {
      if (last) expect(corner, `${id} #${index} outer end`).toBeGreaterThan(0);
      else expect(corner, `${id} #${index} inner end`).toBe(0);
    }
    expect(Math.round(member.box.top), `${id} #${index} top`).toBe(Math.round(list[0]!.box.top));
    expect(Math.round(member.box.bottom), `${id} #${index} bottom`).toBe(
      Math.round(list[0]!.box.bottom),
    );
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`button group joins (${theme})`, async ({ componentPage }) => {
    if (entry === undefined || fixture === undefined) throw new Error('No button group fixture.');
    const page = await componentPage.open({
      entry,
      theme,
      viewport: { name: 'desktop', width: 1280, height: 1400 },
      fixtureName: 'joins',
      fixtureContentHash: fixture.fixtureContentHash,
    });
    await page.getByTestId('split-vertical').locator('.cinder-dropdown-trigger').waitFor();

    for (const variant of ['secondary', 'primary', 'soft']) {
      for (const count of [2, 3, 4]) {
        const vertical = await members(page, `vertical-${variant}-${count}`);
        expect(vertical).toHaveLength(count);
        expectVertical(vertical, `vertical-${variant}-${count}`);
        expectHorizontal(
          await members(page, `horizontal-${variant}-${count}`),
          `horizontal-${variant}-${count}`,
        );
      }
    }
    expectVertical(await members(page, 'vertical-wrapped'), 'vertical-wrapped');
    expectHorizontal(await members(page, 'horizontal-wrapped'), 'horizontal-wrapped', true);

    // A split button's halves are one control: the same variant, fill, edges and height.
    for (const id of ['split-default', 'split-primary']) {
      const [action, trigger] = await members(page, id);
      expect(trigger!.variant, id).toBe(action!.variant);
      expect(trigger!.background, id).toBe(action!.background);
      expect(trigger!.borders[0], id).toBe(action!.borders[0]);
      expect(Math.round(trigger!.box.bottom - trigger!.box.top), id).toBe(
        Math.round(action!.box.bottom - action!.box.top),
      );
      expectHorizontal([action!, trigger!], id);
    }
    const split = await members(page, 'split-vertical');
    expect(split[1]!.variant).toBe('secondary');
    expectVertical(split, 'split-vertical');
  });
}
