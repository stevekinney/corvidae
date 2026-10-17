/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, cleanup } = await import('@testing-library/svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

beforeEach(() => {
  document.body.replaceChildren();
});

const { default: Text } = await import('./text.svelte');
const { createRawSnippet } = await import('svelte');

const textCss = await Bun.file(new URL('./text.css', import.meta.url)).text();

function textSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));
}

describe('Text', () => {
  test.each([
    ['h1', 'H1'],
    ['h2', 'H2'],
    ['h3', 'H3'],
    ['h4', 'H4'],
    ['h5', 'H5'],
    ['caption', 'P'],
    ['body', 'P'],
  ] as const)('variant %p renders a %p element', (variant, tagName) => {
    const { container } = render(Text, { variant, children: textSnippet('hello') });
    const root = container.querySelector('.cinder-text');

    expect(root?.tagName).toBe(tagName);
    expect(root?.getAttribute('data-cinder-variant')).toBe(variant);
    expect(root?.textContent).toContain('hello');
  });

  test('defaults to the body variant rendered as a paragraph', () => {
    const { container } = render(Text, { children: textSnippet('hello') });
    const root = container.querySelector('.cinder-text');

    expect(root?.tagName).toBe('P');
    expect(root?.getAttribute('data-cinder-variant')).toBe('body');
  });

  test('as overrides the element without changing the variant', () => {
    const { container } = render(Text, {
      variant: 'h1',
      as: 'span',
      children: textSnippet('hello'),
    });
    const root = container.querySelector('.cinder-text');

    expect(root?.tagName).toBe('SPAN');
    expect(root?.getAttribute('data-cinder-variant')).toBe('h1');
  });

  test('merges class and spreads rest props', () => {
    const { container } = render(Text, {
      class: 'custom',
      'data-testid': 'text',
      children: textSnippet('hello'),
    });
    const root = container.querySelector('[data-testid="text"]');

    expect(root?.classList.contains('cinder-text')).toBe(true);
    expect(root?.classList.contains('custom')).toBe(true);
  });

  test('takes its color from the container rather than a color token', () => {
    expect(textCss).toContain('color: currentColor;');
    expect(textCss).not.toMatch(/color:\s*var\(--cinder-text-(default|muted|subtle)/);
  });

  test('resets wrapping and tracking on the base so `as` cannot change a variant look', () => {
    const base = textCss.match(/\.cinder-text \{[^}]*\}/)?.[0] ?? '';
    expect(base).toContain('letter-spacing: normal;');
    expect(base).toContain('text-wrap: wrap;');
    expect(base).toContain('overflow-wrap: break-word;');
    for (const heading of ['h1', 'h2', 'h3', 'h4', 'h5']) {
      const rule = textCss.match(
        new RegExp(`data-cinder-variant='${heading}'\\] \\{[^}]*\\}`),
      )?.[0];
      expect(rule).toContain('letter-spacing: var(--cinder-tracking-tight);');
      expect(rule).toContain('text-wrap: balance;');
    }
  });
});
