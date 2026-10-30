/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import type { Snippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

import type { CardEdge, CardProps } from './card.types.ts';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { createRawSnippet } = await import('svelte');
const { default: Card } = await import('./card.svelte');
const { default: cardSchema } = await import('./card.schema.ts');

const body = createRawSnippet(() => ({
  render: () => '<span>Body</span>',
  setup: () => {},
}));
const customHeader = createRawSnippet(() => ({
  render: () => '<span>Header</span>',
  setup: () => {},
}));

const children: Snippet = body;

// One edge per surface: the prop surface offers a single `edge` choice, so a card cannot ask for a
// border and a shadow together. These lines fail `typecheck` if that ever stops being true.
const borderEdge: CardProps = { children, edge: 'border' };
const shadowEdge: CardProps = { children, edge: 'shadow' };
// @ts-expect-error there is no edge value that means both a border and a shadow
const bothEdges: CardProps = { children, edge: 'both' };
// @ts-expect-error the elevation range is gone; the shadow is an edge, not an add-on to a border
const elevated: CardProps = { children, elevation: 'md' };
// @ts-expect-error a separate shadow switch would let a card draw both edges
const borderedAndShadowed: CardProps = { children, edge: 'border', shadow: true };
const edgeValues: CardEdge[] = ['border', 'shadow'];

describe('Card draws one edge', () => {
  test('a Card with both border and shadow is impossible: the only edge values are border and shadow', () => {
    expect([borderEdge, shadowEdge].map((props) => props.edge)).toEqual(edgeValues);
    expect([bothEdges, elevated, borderedAndShadowed]).toHaveLength(3);
    expect(cardSchema.properties).toHaveProperty('edge');
    expect(cardSchema.properties).not.toHaveProperty('elevation');
    expect((cardSchema.properties as { edge: { enum: string[] } }).edge.enum).toEqual(edgeValues);
  });

  test('defaults to the border edge', () => {
    const { container } = render(Card, { props: { children: body } });
    expect(container.querySelector('.cinder-card')?.getAttribute('data-cinder-edge')).toBe(
      'border',
    );
  });

  test.each(edgeValues)('stamps edge="%s" on a static, link, and button card', (edge) => {
    const stamped = [
      render(Card, { props: { children: body, edge } }),
      render(Card, { props: { children: body, edge, href: '/somewhere' } }),
      render(Card, { props: { children: body, edge, onclick: () => {} } }),
    ].map(({ container }) =>
      container.querySelector('.cinder-card')?.getAttribute('data-cinder-edge'),
    );
    expect(stamped).toEqual([edge, edge, edge]);
  });
});

describe('Card header divider is opt-in', () => {
  const arms = [
    ['static', {}],
    ['link', { href: '/somewhere' }],
    ['button', { onclick: () => {} }],
  ] as const;

  test.each(arms)('a %s card with a title has no divider by default', (_name, extra) => {
    const { container } = render(Card, { props: { children: body, title: 'Title', ...extra } });
    const header = container.querySelector('.cinder-card__header');
    expect(header).not.toBeNull();
    expect(header?.hasAttribute('data-cinder-divider')).toBe(false);
  });

  test.each(arms)('a %s card with a title draws the divider when requested', (_name, extra) => {
    const { container } = render(Card, {
      props: { children: body, title: 'Title', headerDivider: true, ...extra },
    });
    expect(
      container.querySelector('.cinder-card__header')?.hasAttribute('data-cinder-divider'),
    ).toBe(true);
  });

  test('a custom header snippet follows the same opt-in', () => {
    const plain = render(Card, { props: { children: body, header: customHeader } });
    expect(
      plain.container.querySelector('.cinder-card__header')?.hasAttribute('data-cinder-divider'),
    ).toBe(false);
    const divided = render(Card, {
      props: { children: body, header: customHeader, headerDivider: true },
    });
    expect(
      divided.container.querySelector('.cinder-card__header')?.hasAttribute('data-cinder-divider'),
    ).toBe(true);
  });
});
