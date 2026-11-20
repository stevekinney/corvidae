/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: GroupedListItem } = await import('./grouped-list-item.svelte');

const text = (value: string) => createRawSnippet(() => ({ render: () => `<span>${value}</span>` }));

const stylesheet = () => readFileSync(new URL('./grouped-list-item.css', import.meta.url), 'utf8');

describe('GroupedListItem time-led row', () => {
  test('a time window leads the row on one line and marks the row as timed', () => {
    const { container } = render(GroupedListItem, {
      props: { title: text('The Rooftop'), timeWindow: '11 pm–2 am', timeCaption: '45 min left' },
    });
    expect(container.querySelector('.cinder-grouped-list-item__lead-window')?.textContent).toBe(
      '11 pm–2 am',
    );
    expect(
      container.querySelector('li')?.classList.contains('cinder-grouped-list-item--timed'),
    ).toBe(true);
  });

  test('the window never wraps, and the lead column is wide enough for the longest window', () => {
    const css = stylesheet();
    expect(css).toMatch(/__lead-window \{[^}]*white-space: nowrap/);
    // 112px on a wide row and 100px on a narrow one, each wide enough for "11 pm–2 am" at the
    // window's size there (measured in `grouped-list-time-led-fit.playwright.ts`).
    expect(css).toMatch(/__lead--timed \{[^}]*inline-size: 7rem/);
    expect(css).toMatch(
      /--timed \.cinder-grouped-list-item__lead \{[^}]*inline-size: 6\.25rem[^}]*\}/,
    );
    expect(css).toMatch(/__lead--timed \{[^}]*flex: none/);
  });

  test.each(['45 min left', '1 h 45 min left', 'starts in 1 h', 'Sun to Tue'])(
    'the line under the window is free text: %s',
    (caption) => {
      const { container } = render(GroupedListItem, {
        props: { title: text('A'), timeWindow: '3–6 pm', timeCaption: caption },
      });
      expect(container.querySelector('.cinder-grouped-list-item__lead-caption')?.textContent).toBe(
        caption,
      );
    },
  );

  test('without a caption the lead draws no empty line', () => {
    const { container } = render(GroupedListItem, {
      props: { title: text('Pier'), timeWindow: 'All day' },
    });
    expect(container.querySelector('.cinder-grouped-list-item__lead-window')?.textContent).toBe(
      'All day',
    );
    expect(container.querySelector('.cinder-grouped-list-item__lead-caption')).toBeNull();
  });

  test('a lead snippet wins over a time window and the row is not timed', () => {
    const { container } = render(GroupedListItem, {
      props: { title: text('A'), lead: text('9:30'), timeWindow: '3–6 pm', timeCaption: 'x' },
    });
    expect(container.querySelector('.cinder-grouped-list-item__lead')?.textContent).toBe('9:30');
    expect(container.querySelector('.cinder-grouped-list-item__lead-window')).toBeNull();
    expect(
      container.querySelector('li')?.classList.contains('cinder-grouped-list-item--timed'),
    ).toBe(false);
  });

  test('urgency is carried on the lead, and absent when unset', () => {
    const urgent = render(GroupedListItem, {
      props: {
        title: text('A'),
        timeWindow: '3–6 pm',
        timeCaption: '5 min left',
        urgency: 'urgent',
      },
    });
    expect(
      urgent.container
        .querySelector('.cinder-grouped-list-item__lead')
        ?.getAttribute('data-cinder-urgency'),
    ).toBe('urgent');
    const plain = render(GroupedListItem, {
      props: { title: text('A'), timeWindow: '3–6 pm', timeCaption: '5 min left' },
    });
    expect(
      plain.container
        .querySelector('.cinder-grouped-list-item__lead')
        ?.hasAttribute('data-cinder-urgency'),
    ).toBe(false);
  });

  test('urgent colours only the caption in the warning text colour, and soon mutes the window', () => {
    const css = stylesheet();
    expect(css).toMatch(
      /data-cinder-urgency='urgent'\]\s*> \.cinder-grouped-list-item__lead-caption \{[^}]*var\(--cinder-status-warning-text\)/,
    );
    // The lead itself is not recoloured by urgent, so the window keeps the default text colour.
    expect(css).not.toMatch(/data-cinder-urgency='urgent'\] \{[^}]*color/);
    expect(css).toMatch(/__lead-window \{[^}]*color: var\(--cinder-text-default\)/);
    expect(css).toMatch(
      /data-cinder-urgency='soon'\]\s*> \.cinder-grouped-list-item__lead-window \{[^}]*color: var\(--cinder-text-muted\)/,
    );
  });

  test('a stale marker is a clock and the age, and a fresh row draws none', () => {
    const stale = render(GroupedListItem, {
      props: { title: text('A'), timeWindow: 'All day', staleAge: '3d' },
    });
    const marker = stale.container.querySelector('.cinder-grouped-list-item__stale');
    expect(marker?.textContent).toContain('3d');
    expect(marker?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    const fresh = render(GroupedListItem, { props: { title: text('A'), timeWindow: 'All day' } });
    expect(fresh.container.querySelector('.cinder-grouped-list-item__stale')).toBeNull();
  });

  test('stylesheet sets the right-aligned lead, the type scale, and the 56px photo', () => {
    const css = stylesheet();
    expect(css).toMatch(/__lead--timed \{[^}]*align-items: flex-end/);
    expect(css).toMatch(/__lead--timed \{[^}]*text-align: end/);
    // The window is the row's entry point: two steps over the name on a wide row, one on a narrow.
    expect(css).toMatch(
      /\n {2}\.cinder-grouped-list-item__lead-window \{[^}]*font-size: var\(--cinder-text-xl\)/,
    );
    expect(css).toMatch(
      /--timed\s+\.cinder-grouped-list-item__lead-window \{\s*font-size: var\(--cinder-text-lg\)/,
    );
    expect(css).toMatch(/__lead-window \{[^}]*font-weight: var\(--cinder-font-bold/);
    expect(css).toMatch(
      /__lead-window \{[^}]*line-height: var\(--_cinder-grouped-list-item-title-line\)/,
    );
    expect(css).toMatch(/__lead-window \{[^}]*font-variant-numeric: tabular-nums/);
    expect(css).toMatch(
      /\n {2}\.cinder-grouped-list-item__lead-caption \{[^}]*font-size: var\(--cinder-text-sm\)/,
    );
    expect(css).toMatch(
      /--timed\s+\.cinder-grouped-list-item__lead-caption \{\s*font-size: var\(--cinder-text-xs\)/,
    );
    expect(css).toMatch(/__lead-caption \{[^}]*color: var\(--cinder-text-muted\)/);
    expect(css).toMatch(/__photo \{[^}]*inline-size: 3\.5rem/);
  });

  // COR-2503 AC6, COR-2443 AC4: on a narrow row the trailing value sits at the end of the title's
  // line, so the subtitle takes the width under both, and the name keeps its room.
  test('a narrow time-led row puts the trailing value on the title line and the subtitle under both', () => {
    const css = stylesheet();
    // Every time-led row, with a trailing value or without: a row with only a stale marker and a
    // chevron wrapped its chevron onto a line of its own while only trailing rows took the grid.
    expect(css).toMatch(
      /\.cinder-grouped-list-item\.cinder-grouped-list-item--timed\s*> \.cinder-grouped-list-item__content \{[^}]*display: grid/,
    );
    expect(css).toMatch(
      /\.cinder-grouped-list-item\.cinder-grouped-list-item--timed\s+\.cinder-grouped-list-item__subtitle \{[^}]*grid-column: 2 \/ span 6/,
    );
    expect(css).toMatch(
      /\.cinder-grouped-list-item--timed \{\s*container: cinder-grouped-list-item \/ inline-size/,
    );
    expect(css).not.toContain('--timed.cinder-grouped-list-item--trailing');
  });

  test('a wide time-led row wraps its meta to a line of its own before it squeezes the name', () => {
    const css = stylesheet();
    expect(css).toMatch(/--timed \.cinder-grouped-list-item__text \{[^}]*flex: 1 0 10rem/);
  });

  // The owner's review (2026-11-15): a 24px lead at weight 750, a 17px title in the heading weight
  // and a subtitle a size up put the time-led row off the type scale every other row uses.
  test('the title and subtitle are the basic row’s, and every size, weight and leading is a token', () => {
    const css = stylesheet();
    expect(css).not.toMatch(/--timed \.cinder-grouped-list-item__(title|subtitle) \{[^}]*font/);
    expect(css).toMatch(/--timed > \.cinder-grouped-list-item__content \{[^}]*flex-start/);
    const declarations = [...css.matchAll(/(font-size|font-weight|line-height):\s*([^;]+);/g)];
    expect(declarations.length).toBeGreaterThan(0);
    for (const [declaration, , value] of declarations) {
      expect(value!.trim(), declaration).toStartWith('var(--');
    }
  });
});
