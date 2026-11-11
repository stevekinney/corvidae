/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: Card } = await import('./card.svelte');

function textSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<span>${text}</span>`,
    setup: () => {},
  }));
}

const imageSnippet = createRawSnippet(() => ({
  render: () => `<img src="/rooftop.jpg" alt="The rooftop" />`,
  setup: () => {},
}));

const ratioOf = (container: HTMLElement) =>
  container
    .querySelector<HTMLElement>('.cinder-card__media')
    ?.style.getPropertyValue('aspect-ratio');

describe('Card media', () => {
  test('a card without media draws no media element, placeholder or media attribute', () => {
    const { container } = render(Card, { props: { children: textSnippet('body') } });
    expect(container.querySelector('.cinder-card__media')).toBeNull();
    expect(container.querySelector('.cinder-card')?.hasAttribute('data-cinder-media')).toBe(false);
  });

  test('media renders before the header and body at the top by default', () => {
    const { container } = render(Card, {
      props: { title: 'Rooftop', media: imageSnippet, children: textSnippet('body') },
    });
    const card = container.querySelector('.cinder-card');
    expect(card?.getAttribute('data-cinder-media')).toBe('top');
    const children = [...(card?.children ?? [])];
    expect(children[0]?.classList.contains('cinder-card__media')).toBe(true);
    expect(children[1]?.classList.contains('cinder-card__header')).toBe(true);
    expect(container.querySelector('.cinder-card__media img')?.getAttribute('alt')).toBe(
      'The rooftop',
    );
  });

  test('the media box takes the default 16 / 9 aspect ratio and a given one', () => {
    const fallback = render(Card, { props: { media: imageSnippet, children: textSnippet('a') } });
    expect(ratioOf(fallback.container)).toBe('16 / 9');
    const given = render(Card, {
      props: { media: imageSnippet, mediaAspectRatio: '3 / 2', children: textSnippet('b') },
    });
    expect(ratioOf(given.container)).toBe('3 / 2');
    const numeric = render(Card, {
      props: { media: imageSnippet, mediaAspectRatio: 1, children: textSnippet('c') },
    });
    expect(ratioOf(numeric.container)).toBe('1 / 1');
  });

  test('a non-positive numeric ratio falls back to the default', () => {
    const { container } = render(Card, {
      props: { media: imageSnippet, mediaAspectRatio: 0, children: textSnippet('a') },
    });
    expect(ratioOf(container)).toBe('16 / 9');
  });

  test('leading media is carried on the card for the column layout', () => {
    const { container } = render(Card, {
      props: { media: imageSnippet, mediaPosition: 'leading', children: textSnippet('body') },
    });
    expect(container.querySelector('.cinder-card')?.getAttribute('data-cinder-media')).toBe(
      'leading',
    );
  });

  test('media renders in a link card and a button card', () => {
    const link = render(Card, {
      props: { href: '/rooftop', media: imageSnippet, children: textSnippet('body') },
    });
    expect(link.container.querySelector('a.cinder-card > .cinder-card__media')).not.toBeNull();
    const button = render(Card, {
      props: { onclick: () => {}, media: imageSnippet, children: textSnippet('body') },
    });
    expect(button.container.querySelector('.cinder-card > .cinder-card__media')).not.toBeNull();
  });

  test('stylesheet fills the media box, lays a leading column in a grid, and draws no placeholder', async () => {
    const css = await Bun.file(new URL('./card.css', import.meta.url)).text();
    expect(css).toMatch(
      /\.cinder-card__media > :where\(img, picture, video, svg\) \{[^}]*object-fit: cover/s,
    );
    expect(css).toMatch(/\.cinder-card\[data-cinder-media='leading'\] \{[^}]*display: grid/s);
    expect(css).not.toMatch(/\.cinder-card__media[^{]*\{[^}]*background:/s);
  });
});
