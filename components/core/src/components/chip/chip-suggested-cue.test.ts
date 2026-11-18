/// <reference lib="dom" />
/**
 * COR-2441 (design correction): a suggested Chip tells a sighted person by a glyph, not by colour
 * alone (WCAG 1.4.1), and the word "Suggested" sits on a line above the label on every component
 * that carries it (Card, GroupedListItem, InspectorRow).
 */
import { describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: Chip } = await import('./chip.svelte');

const chipCss = await Bun.file(new URL('./chip.css', import.meta.url)).text();
const cardCss = await Bun.file(
  new URL('../../../../card/src/components/card/card.css', import.meta.url),
).text();
const rowCss = await Bun.file(
  new URL('../grouped-list-item/grouped-list-item.css', import.meta.url),
).text();
const inspectorCss = await Bun.file(
  new URL('../inspector-row/inspector-row.css', import.meta.url),
).text();

describe('suggested Chip visible cue', () => {
  test('a suggested chip draws a decorative glyph before its label, in every mode', () => {
    const static_ = render(Chip, { props: { label: 'Weekly', suggested: true } });
    const toggle = render(Chip, {
      props: { mode: 'toggle', pressed: false, label: 'Weekly', suggested: true },
    });
    const removable = render(Chip, {
      props: { mode: 'removable', label: 'Weekly', suggested: true, onRemove: () => {} },
    });
    for (const { container } of [static_, toggle, removable]) {
      const mark = container.querySelector('.cinder-chip__suggested-mark');
      expect(mark?.getAttribute('aria-hidden')).toBe('true');
      expect(mark?.querySelector('svg')).not.toBeNull();
      const chip = container.querySelector('.cinder-chip');
      // The glyph is inline at the start of the label, not a flex item ahead of it: a flex
      // container takes its baseline from its first item, which moved the chip off its line.
      const label = chip?.querySelector('.cinder-chip__label');
      expect(mark?.parentElement === label).toBe(true);
      expect(label?.firstElementChild === mark).toBe(true);
      expect([...(chip?.children ?? [])].includes(mark as Element)).toBe(false);
      // The screen-reader word stays, so the cue is not announced twice.
      expect(chip?.querySelector('.cinder-sr-only')?.textContent).toBe('Suggested: ');
    }
  });

  test('an unsuggested chip has no glyph', () => {
    const { container } = render(Chip, { props: { label: 'Weekly' } });
    expect(container.querySelector('.cinder-chip__suggested-mark')).toBeNull();
  });

  test('the glyph takes the accent text colour, sits inline and adds no line height', () => {
    expect(chipCss).toMatch(
      /\.cinder-chip__suggested-mark \{[^}]*display: inline-block;[^}]*block-size: 0;[^}]*vertical-align: baseline;[^}]*color: var\(--cinder-accent-text\)/,
    );
    // The glyph hangs from the zero-height box and takes no part in the line box.
    expect(chipCss).toMatch(
      /\.cinder-chip__suggested-mark > svg \{[^}]*position: absolute;[^}]*inset-block-end: -0\.2em/,
    );
  });
});

describe('the word "Suggested" leads the label everywhere', () => {
  test('Card puts it above its title, GroupedListItem above its title, InspectorRow above its label', () => {
    expect(cardCss).toMatch(
      /\.cinder-card__title-group > \.cinder-card__suggested \{[^}]*order: -1;[^}]*flex-basis: 100%/,
    );
    expect(cardCss).toMatch(
      /\.cinder-card__title-group:has\(> \.cinder-card__suggested\) \{[^}]*flex-wrap: wrap/,
    );
    expect(inspectorCss).toMatch(
      /\.cinder-inspector-row__suggested \{[^}]*flex-basis: 100%;[^}]*order: -1/,
    );
    // GroupedListItem already draws it on a line above the title, with no reordering.
    expect(rowCss).toContain('.cinder-grouped-list-item__suggested {');
    expect(rowCss).toMatch(
      /\.cinder-grouped-list-item__suggested \{[^}]*color: var\(--cinder-accent-text\)/,
    );
  });
});
