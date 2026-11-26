/// <reference lib="dom" />
/**
 * COR-2770: the server HTML of Breadcrumbs holds both forms, the whole trail and the phone form's
 * back link, so CSS can choose one on the first paint with no script. Rendered with the real Svelte
 * server runtime, then parsed (happy-dom) only to query the markup.
 */
import { describe, expect, test } from 'bun:test';

import { renderSvelteOnServer, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const source = new URL('./breadcrumbs.svelte', import.meta.url).pathname;
const items = [
  { label: 'Home', href: '/' },
  { label: 'Projects', href: '/projects' },
  { label: 'Cinder', href: '/projects/cinder' },
  { label: 'Settings' },
];

// Server rendering spawns Bun processes, so it runs once at module scope, off bun's per-test clock.
const [defaultHtml, customHtml, offHtml] = await Promise.all([
  renderSvelteOnServer(source, { items }),
  renderSvelteOnServer(source, { items, collapseBelow: '48rem' }),
  renderSvelteOnServer(source, { items, collapseBelow: false }),
]);

function parse(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('Breadcrumbs server HTML', () => {
  test('holds every ancestor link, one back link to the parent and one current page', () => {
    const root = parse(defaultHtml);

    expect(
      [...root.querySelectorAll('a.cinder-breadcrumbs__link')].map((link) => [
        link.textContent,
        link.getAttribute('href'),
      ]),
    ).toEqual([
      ['Home', '/'],
      ['Projects', '/projects'],
      ['Cinder', '/projects/cinder'],
    ]);
    const back = root.querySelectorAll('a.cinder-breadcrumbs__back');
    expect(back).toHaveLength(1);
    expect(back[0]?.getAttribute('href')).toBe('/projects/cinder');
    expect(root.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(root.querySelector('[aria-current="page"]')?.textContent).toBe('Settings');
  });

  test('marks the trail with its phone length, which breadcrumbs.css reads, and adds no style', () => {
    const root = parse(defaultHtml);

    expect(root.querySelector('nav')?.getAttribute('data-cinder-phone-below')).toBe('640px');
    expect(root.querySelector('nav')?.hasAttribute('data-cinder-collapsed')).toBe(false);
    expect(root.querySelector('style')).toBeNull();
  });

  test('another collapseBelow keeps both forms and brings the CSS for its own length', () => {
    const root = parse(customHtml);

    expect(root.querySelectorAll('a.cinder-breadcrumbs__link')).toHaveLength(3);
    expect(root.querySelectorAll('a.cinder-breadcrumbs__back')).toHaveLength(1);
    expect(root.querySelector('nav')?.getAttribute('data-cinder-phone-below')).toBe('48rem');
    const style = root.querySelector('nav > style')?.textContent ?? '';
    expect(style).toContain('@media not all and (min-width: 48rem)');
    expect(style).toContain('.cinder-breadcrumbs[data-cinder-phone-below="48rem"]');
    // Server rendering escapes `<` in text; the query is written without one.
    expect(style).not.toContain('&lt;');
  });

  test('collapseBelow={false} renders only the whole trail', () => {
    const root = parse(offHtml);

    expect(root.querySelectorAll('a.cinder-breadcrumbs__link')).toHaveLength(3);
    expect(root.querySelector('a.cinder-breadcrumbs__back')).toBeNull();
    expect(root.querySelector('nav')?.hasAttribute('data-cinder-phone-below')).toBe(false);
    expect(root.querySelector('style')).toBeNull();
  });
});
