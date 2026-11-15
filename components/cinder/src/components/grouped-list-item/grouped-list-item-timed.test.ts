/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: GroupedListItem } = await import('./grouped-list-item.svelte');

const text = (value: string) => createRawSnippet(() => ({ render: () => `<span>${value}</span>` }));

describe('GroupedListItem time-led row', () => {
  test('a lead value and unit render a structured lead and mark the row as timed', () => {
    const { container } = render(GroupedListItem, {
      props: { title: text('The Rooftop'), leadValue: 45, leadUnit: 'min left' },
    });
    expect(container.querySelector('.cinder-grouped-list-item__lead-value')?.textContent).toBe(
      '45',
    );
    expect(container.querySelector('.cinder-grouped-list-item__lead-unit')?.textContent).toBe(
      'min left',
    );
    expect(
      container.querySelector('li')?.classList.contains('cinder-grouped-list-item--timed'),
    ).toBe(true);
  });

  test('a lead value without a unit draws only the value', () => {
    const { container } = render(GroupedListItem, {
      props: { title: text('Pier'), leadValue: 'Fri' },
    });
    expect(container.querySelector('.cinder-grouped-list-item__lead-value')?.textContent).toBe(
      'Fri',
    );
    expect(container.querySelector('.cinder-grouped-list-item__lead-unit')).toBeNull();
  });

  test('a lead snippet wins over a lead value and the row is not timed', () => {
    const { container } = render(GroupedListItem, {
      props: { title: text('A'), lead: text('9:30'), leadValue: 45, leadUnit: 'min left' },
    });
    expect(container.querySelector('.cinder-grouped-list-item__lead')?.textContent).toBe('9:30');
    expect(container.querySelector('.cinder-grouped-list-item__lead-value')).toBeNull();
    expect(
      container.querySelector('li')?.classList.contains('cinder-grouped-list-item--timed'),
    ).toBe(false);
  });

  test('urgency is carried on the lead, and absent when unset', () => {
    const urgent = render(GroupedListItem, {
      props: { title: text('A'), leadValue: 5, leadUnit: 'min left', urgency: 'urgent' },
    });
    expect(
      urgent.container
        .querySelector('.cinder-grouped-list-item__lead')
        ?.getAttribute('data-cinder-urgency'),
    ).toBe('urgent');
    const plain = render(GroupedListItem, {
      props: { title: text('A'), leadValue: 5, leadUnit: 'min left' },
    });
    expect(
      plain.container
        .querySelector('.cinder-grouped-list-item__lead')
        ?.hasAttribute('data-cinder-urgency'),
    ).toBe(false);
  });

  test('a stale marker is a clock and the age, and a fresh row draws none', () => {
    const stale = render(GroupedListItem, {
      props: { title: text('A'), leadValue: 'Fri', staleAge: '3d' },
    });
    const marker = stale.container.querySelector('.cinder-grouped-list-item__stale');
    expect(marker?.textContent).toContain('3d');
    expect(marker?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    const fresh = render(GroupedListItem, { props: { title: text('A'), leadValue: 'Fri' } });
    expect(fresh.container.querySelector('.cinder-grouped-list-item__stale')).toBeNull();
  });

  test('stylesheet sets the 72px right-aligned lead, the type scale, and the 56px photo', () => {
    const css = readFileSync(new URL('./grouped-list-item.css', import.meta.url), 'utf8');
    expect(css).toMatch(/__lead--timed \{[^}]*inline-size: 4\.5rem/);
    expect(css).toMatch(/__lead--timed \{[^}]*align-items: flex-end/);
    expect(css).toMatch(/__lead--timed \{[^}]*text-align: end/);
    expect(css).toMatch(/__lead-value \{[^}]*font-size: var\(--cinder-text-md\)/);
    expect(css).toMatch(/__lead-value \{[^}]*font-weight: var\(--cinder-font-semibold\)/);
    expect(css).toMatch(
      /__lead-value \{[^}]*line-height: var\(--_cinder-grouped-list-item-title-line\)/,
    );
    expect(css).toMatch(/__lead-value \{[^}]*font-variant-numeric: tabular-nums/);
    expect(css).toMatch(/__lead-unit \{[^}]*font-size: var\(--cinder-text-xs\)/);
    expect(css).toMatch(/__lead-unit \{[^}]*color: var\(--cinder-text-muted\)/);
    expect(css).toMatch(
      /data-cinder-urgency='urgent'\] \{[^}]*var\(--cinder-status-warning-text\)/,
    );
    expect(css).toMatch(/__photo \{[^}]*inline-size: 3\.5rem/);
  });

  // The owner's review (2026-11-15): a 24px lead at weight 750, a 17px title in the heading weight
  // and a subtitle a size up put the time-led row off the type scale every other row uses.
  test('the title and subtitle are the basic row’s, and every size, weight and leading is a token', () => {
    const css = readFileSync(new URL('./grouped-list-item.css', import.meta.url), 'utf8');
    expect(css).not.toMatch(/--timed \.cinder-grouped-list-item__(title|subtitle)/);
    expect(css).toMatch(/--timed > \.cinder-grouped-list-item__content \{[^}]*flex-start/);
    const declarations = [...css.matchAll(/(font-size|font-weight|line-height):\s*([^;]+);/g)];
    expect(declarations.length).toBeGreaterThan(0);
    for (const [declaration, , value] of declarations) {
      expect(value!.trim(), declaration).toStartWith('var(--');
    }
  });
});
