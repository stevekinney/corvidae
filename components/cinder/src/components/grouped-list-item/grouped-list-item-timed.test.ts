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
    expect(css).toMatch(/__lead-value \{[^}]*font-size: var\(--cinder-text-3xl\)/);
    expect(css).toMatch(/__lead-value \{[^}]*font-weight: 750/);
    expect(css).toMatch(/__lead-value \{[^}]*line-height: 1\.1/);
    expect(css).toMatch(/__lead-value \{[^}]*font-variant-numeric: tabular-nums/);
    expect(css).toMatch(/__lead-unit \{[^}]*font-size: var\(--cinder-text-xs\)/);
    expect(css).toMatch(
      /data-cinder-urgency='urgent'\] \{[^}]*var\(--cinder-status-warning-text\)/,
    );
    expect(css).toMatch(/--timed \.cinder-grouped-list-item__title \{[^}]*font-size: 1\.0625rem/);
    expect(css).toMatch(
      /--timed \.cinder-grouped-list-item__subtitle \{[^}]*var\(--cinder-text-md\)/,
    );
    expect(css).toMatch(/__photo \{[^}]*inline-size: 3\.5rem/);
  });
});
