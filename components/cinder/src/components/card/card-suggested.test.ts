/// <reference lib="dom" />
// COR-2326: a suggested card marks drafted, unconfirmed content with a quiet accent text label on
// its title row (or at the top of its body without a title), and with no tint, border or pill.
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

import { declarationsFor } from '../../test/css.ts';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { createRawSnippet } = await import('svelte');
const { default: Card } = await import('./card.svelte');

const cardCss = await Bun.file(new URL('./card.css', import.meta.url)).text();

const body = createRawSnippet(() => ({ render: () => '<span>Body</span>', setup: () => {} }));
const customHeader = createRawSnippet(() => ({
  render: () => '<span>Header</span>',
  setup: () => {},
}));

afterEach(cleanup);

describe('Card tone="suggested"', () => {
  test('puts a "Suggested" label on the title row and stamps the tone', () => {
    const { container } = render(Card, {
      props: { title: 'Call the landlord', tone: 'suggested', children: body },
    });
    const root = container.querySelector('.cinder-card');
    expect(root?.getAttribute('data-cinder-tone')).toBe('suggested');
    const label = container.querySelector('.cinder-card__title-row .cinder-card__suggested');
    expect(label?.textContent).toBe('Suggested');
    expect(container.querySelector('.cinder-card__title')?.textContent).toBe('Call the landlord');
    expect(container.querySelector('.cinder-card__body .cinder-card__suggested')).toBeNull();
  });

  test('suggestedLabel changes the words', () => {
    const { container } = render(Card, {
      props: {
        title: 'Call the landlord',
        tone: 'suggested',
        suggestedLabel: 'Suggested wording',
        children: body,
      },
    });
    expect(container.querySelector('.cinder-card__suggested')?.textContent).toBe(
      'Suggested wording',
    );
  });

  test('a card with no title carries the label at the top of its body', () => {
    const plain = render(Card, { props: { tone: 'suggested', children: body } });
    const plainBody = plain.container.querySelector('.cinder-card__body');
    expect(plainBody?.firstElementChild?.classList.contains('cinder-card__suggested')).toBe(true);
    plain.unmount();

    const withHeader = render(Card, {
      props: { tone: 'suggested', header: customHeader, children: body },
    });
    const headerBody = withHeader.container.querySelector('.cinder-card__body');
    expect(headerBody?.firstElementChild?.classList.contains('cinder-card__suggested')).toBe(true);
  });

  test('the label reaches link and button cards too', () => {
    const link = render(Card, {
      props: { title: 'Open draft', tone: 'suggested', href: '/drafts/1', children: body },
    });
    expect(link.container.querySelector('a .cinder-card__suggested')?.textContent).toBe(
      'Suggested',
    );
    link.unmount();

    const button = render(Card, {
      props: { tone: 'suggested', onclick: () => {}, children: body },
    });
    expect(
      button.container.querySelector('.cinder-card__body .cinder-card__suggested'),
    ).not.toBeNull();
  });

  test('other tones draw no label', () => {
    for (const tone of ['default', 'danger'] as const) {
      const { container, unmount } = render(Card, {
        props: { title: 'Settings', tone, children: body },
      });
      expect(container.querySelector('.cinder-card__suggested')).toBeNull();
      unmount();
    }
  });

  test('the label is quiet accent text with no tint, border or pill', () => {
    const label = declarationsFor(cardCss, '.cinder-card__suggested');
    expect(label.get('color')).toBe('var(--cinder-accent-text)');
    expect(label.get('font-size')).toBe('var(--cinder-text-sm)');
    for (const property of ['background', 'border', 'border-radius', 'padding', 'outline']) {
      expect(label.has(property)).toBe(false);
    }
    expect(cardCss).not.toContain("[data-cinder-tone='suggested']");
  });
});
