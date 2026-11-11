/// <reference lib="dom" />
// COR-2326: a suggested row says so in quiet accent words above its title, with no tint, border or
// pill.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

import { declarationsFor } from '../../test/css.ts';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: GroupedListItem } = await import('./grouped-list-item.svelte');

const text = (value: string) => createRawSnippet(() => ({ render: () => `<span>${value}</span>` }));

const css = readFileSync(new URL('./grouped-list-item.css', import.meta.url), 'utf8');

describe('GroupedListItem suggested', () => {
  test('a suggested row draws a "Suggested" label above its title and marks the row', () => {
    const { container } = render(GroupedListItem, {
      props: { title: text('Call the landlord'), suggested: true },
    });
    const row = container.querySelector('.cinder-grouped-list-item');
    expect(row?.hasAttribute('data-cinder-suggested')).toBe(true);
    const textBlock = container.querySelector('.cinder-grouped-list-item__text');
    const label = textBlock?.firstElementChild;
    expect(label?.classList.contains('cinder-grouped-list-item__suggested')).toBe(true);
    expect(label?.textContent).toBe('Suggested');
    expect(container.querySelector('.cinder-grouped-list-item__title')?.textContent).toBe(
      'Call the landlord',
    );
  });

  test('suggestedLabel changes the words, and the link name stays the title', () => {
    const { container } = render(GroupedListItem, {
      props: {
        title: text('Call the landlord'),
        suggested: true,
        suggestedLabel: 'Suggested wording',
        href: '/actions/1',
      },
    });
    expect(container.querySelector('.cinder-grouped-list-item__suggested')?.textContent).toBe(
      'Suggested wording',
    );
    expect(container.querySelector('.cinder-grouped-list-item__link')?.textContent).toBe(
      'Call the landlord',
    );
  });

  test('a row that is not suggested draws no label and no marker', () => {
    const { container } = render(GroupedListItem, { props: { title: text('Home') } });
    expect(container.querySelector('.cinder-grouped-list-item__suggested')).toBeNull();
    expect(
      container.querySelector('.cinder-grouped-list-item')?.hasAttribute('data-cinder-suggested'),
    ).toBe(false);
  });

  test('the label is quiet accent text with no tint, border or pill', () => {
    const label = declarationsFor(css, '.cinder-grouped-list-item__suggested');
    expect(label.get('color')).toBe('var(--cinder-accent-text)');
    expect(label.get('font-size')).toBe('var(--cinder-text-sm)');
    for (const property of ['background', 'border', 'border-radius', 'padding', 'outline']) {
      expect(label.has(property)).toBe(false);
    }
    expect(css).not.toContain('[data-cinder-suggested]');
  });
});
