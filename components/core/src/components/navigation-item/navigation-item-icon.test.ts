/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

// setupHappyDom() MUST run before any `@testing-library/svelte` import. testing-library
// reads `globalThis.document` / `window` at module-init (top-level, not inside test bodies),
// so we register happy-dom's globals first and then dynamic-import testing-library below.
setupHappyDom();

const { createRawSnippet } = await import('svelte');
const { render } = await import('@testing-library/svelte');
const { default: NavigationItem } = await import('./navigation-item.svelte');

const navigationItemCss = await Bun.file(new URL('./navigation-item.css', import.meta.url)).text();

function textSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<span>${text}</span>`,
  }));
}

function iconSnippet() {
  return createRawSnippet(() => ({
    render: () => '<svg data-icon viewBox="0 0 16 16" width="16" height="16"></svg>',
  }));
}

describe('NavigationItem icon (COR-2315)', () => {
  test('draws the icon before the label, hidden from assistive technology', () => {
    const { container } = render(NavigationItem, {
      props: { href: '/home', icon: iconSnippet(), children: textSnippet('Home') },
    });
    const anchor = container.querySelector('a');
    const wrapper = anchor?.querySelector('.cinder-navigation-item__icon');
    expect(wrapper?.getAttribute('aria-hidden')).toBe('true');
    expect(wrapper?.querySelector('svg[data-icon]')).not.toBeNull();
    expect([...(anchor?.children ?? [])].map((child) => child.className)).toEqual([
      'cinder-navigation-item__icon',
      'cinder-navigation-item__label',
    ]);
  });

  test('wraps the label in the element a bottom bar hides with labelsVisible', () => {
    const { container } = render(NavigationItem, {
      props: { href: '/home', icon: iconSnippet(), children: textSnippet('Home') },
    });
    const label = container.querySelector('[data-cinder-navigation-label]');
    expect(label?.textContent?.trim()).toBe('Home');
    expect(label?.classList.contains('cinder-navigation-item__label')).toBe(true);
  });

  test('takes an icon in every placement and as a link or a button', () => {
    for (const variant of ['horizontal', 'mobile', 'vertical'] as const) {
      const link = render(NavigationItem, {
        props: { href: '/home', variant, icon: iconSnippet(), children: textSnippet('Home') },
      });
      expect(link.container.querySelector('a .cinder-navigation-item__icon svg')).not.toBeNull();
      expect(link.container.querySelector('a')?.getAttribute('data-variant')).toBe(variant);
      link.unmount();
      const button = render(NavigationItem, {
        props: { onclick: () => {}, variant, icon: iconSnippet(), children: textSnippet('Home') },
      });
      expect(
        button.container.querySelector('button .cinder-navigation-item__icon svg'),
      ).not.toBeNull();
      button.unmount();
    }
  });

  test('without an icon the children render as they always did', () => {
    const { container } = render(NavigationItem, {
      props: { href: '/home', children: textSnippet('Home') },
    });
    const anchor = container.querySelector('a');
    expect(anchor?.querySelector('.cinder-navigation-item__icon')).toBeNull();
    expect(anchor?.querySelector('[data-cinder-navigation-label]')).toBeNull();
    expect(anchor?.firstElementChild?.tagName).toBe('SPAN');
  });

  test('the icon never reaches the element as an attribute', () => {
    const { container } = render(NavigationItem, {
      props: { href: '/home', icon: iconSnippet(), children: textSnippet('Home') },
    });
    expect(container.querySelector('a')?.hasAttribute('icon')).toBe(false);
  });

  test('the stylesheet sizes the glyph at 16px and lets the label give up room first', () => {
    expect(navigationItemCss).toMatch(
      /\.cinder-navigation-item__icon > svg\s*\{[^}]*inline-size: 1rem;[^}]*block-size: 1rem;/,
    );
    expect(navigationItemCss).toMatch(
      /\.cinder-navigation-item__label\s*\{[^}]*min-inline-size: 0;/,
    );
  });
});
