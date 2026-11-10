/// <reference lib="dom" />
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

describe('Card headerTone', () => {
  test('a header is the default tone until a card asks for a muted one', () => {
    const { container } = render(Card, { props: { header: customHeader, children: body } });
    expect(container.querySelector('.cinder-card__header')?.getAttribute('data-cinder-tone')).toBe(
      'default',
    );
  });

  test('stamps the tone on a custom header, a generated title and a link card’s header', () => {
    const rendered = [
      render(Card, {
        props: { header: customHeader, children: body, headerTone: 'muted' },
      }),
      render(Card, { props: { title: 'Title', children: body, headerTone: 'muted' } }),
      render(Card, {
        props: { header: customHeader, children: body, headerTone: 'muted', href: '/somewhere' },
      }),
    ].map(({ container }) =>
      container.querySelector('.cinder-card__header')?.getAttribute('data-cinder-tone'),
    );
    expect(rendered).toEqual(['muted', 'muted', 'muted']);
  });

  test('a muted header is the inset band over the card’s rows', () => {
    const rule = declarationsFor(cardCss, ".cinder-card__header[data-cinder-tone='muted']");
    expect(rule.get('background')).toBe('var(--cinder-surface-inset)');
  });
});
