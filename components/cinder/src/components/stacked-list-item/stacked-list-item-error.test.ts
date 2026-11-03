/// <reference lib="dom" />
/**
 * COR-2010 (B02, row 14q): a row whose own details failed to load keeps its status, title and time
 * on line one, and says so on line two with a warning glyph and its own secondary "Try again"
 * button, so no page rebuilds the affordance by hand.
 */
import { describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent } = await import('@testing-library/svelte');
const { default: StackedListItem } = await import('./stacked-list-item.svelte');

function textSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>`, setup: () => {} }));
}

const row = {
  status: textSnippet('Waiting on you'),
  title: textSnippet('Refund order 4471'),
  time: textSnippet('10:42 AM'),
};

describe('StackedListItem failed row', () => {
  test('line two carries the message, a decorative glyph and the retry button', () => {
    const { container } = render(StackedListItem, {
      props: { ...row, error: 'Couldn’t load this run’s details.', onRetryClick: () => {} },
    });
    const root = container.querySelector('.cinder-stacked-list-item');
    expect(root?.classList.contains('cinder-stacked-list-item--failed')).toBe(true);
    const line = root?.querySelector('.cinder-stacked-list-item__error');
    expect(line?.classList.contains('cinder-stacked-list-item__line-two')).toBe(true);
    expect(line?.querySelector('.cinder-stacked-list-item__error-message')?.textContent).toBe(
      'Couldn’t load this run’s details.',
    );
    expect(
      line?.querySelector('.cinder-stacked-list-item__error-glyph')?.getAttribute('aria-hidden'),
    ).toBe('true');
    const button = line?.querySelector('button');
    expect(button?.textContent?.trim()).toBe('Try again');
    expect(button?.getAttribute('aria-describedby')).toBe(
      line?.querySelector('.cinder-stacked-list-item__error-message')?.id,
    );
    // Status, title and time stay on line one.
    for (const part of ['__status', '__title', '__time']) {
      expect(root?.querySelector(`.cinder-stacked-list-item${part}`)).toBeTruthy();
    }
  });

  test('choosing Try again calls onRetryClick', async () => {
    let attempts = 0;
    const { container } = render(StackedListItem, {
      props: { ...row, error: 'Nope.', onRetryClick: () => (attempts += 1) },
    });
    await fireEvent.click(container.querySelector('.cinder-stacked-list-item__error button')!);
    expect(attempts).toBe(1);
  });

  test('retryLabel renames the button, and no onRetryClick draws no button', () => {
    const named = render(StackedListItem, {
      props: { ...row, error: 'Nope.', onRetryClick: () => {}, retryLabel: 'Reload this row' },
    });
    expect(
      named.container.querySelector('.cinder-stacked-list-item__error button')?.textContent,
    ).toContain('Reload this row');
    named.unmount();
    const bare = render(StackedListItem, { props: { ...row, error: 'Nope.' } });
    expect(bare.container.querySelector('.cinder-stacked-list-item__error button')).toBeNull();
  });

  test('an error replaces meta and the row is not a link', () => {
    const { container } = render(StackedListItem, {
      props: { ...row, href: '/runs/a', error: 'Nope.', meta: textSnippet('Chat · Tool runner') },
    });
    expect(container.querySelector('.cinder-stacked-list-item__meta')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('.cinder-stacked-list-item--linked')).toBeNull();
  });

  test('a row with only a title and an error still takes the two-line layout', () => {
    const { container } = render(StackedListItem, {
      props: { title: textSnippet('Refund order 4471'), error: 'Nope.' },
    });
    expect(
      container
        .querySelector('.cinder-stacked-list-item')
        ?.classList.contains('cinder-stacked-list-item--lines'),
    ).toBe(true);
  });
});
