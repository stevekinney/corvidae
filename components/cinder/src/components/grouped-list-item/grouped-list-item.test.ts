/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: GroupedListItem } = await import('./grouped-list-item.svelte');

const text = (value: string) => createRawSnippet(() => ({ render: () => `<span>${value}</span>` }));

describe('GroupedListItem', () => {
  test('renders the title and subtitle, and no optional slot that is absent', () => {
    const { container } = render(GroupedListItem, {
      props: { title: text('Home'), subtitle: text('On') },
    });
    expect(container.querySelector('.cinder-grouped-list-item__title')?.textContent).toBe('Home');
    expect(container.querySelector('.cinder-grouped-list-item__subtitle')?.textContent).toBe('On');
    for (const part of ['leading', 'lead', 'photo', 'trailing', 'action', 'chevron']) {
      expect(container.querySelector(`.cinder-grouped-list-item__${part}`)).toBeNull();
    }
  });

  test('a trailing photo reserves no space when absent and renders when given', () => {
    const absent = render(GroupedListItem, { props: { title: text('A') } });
    expect(absent.container.querySelector('.cinder-grouped-list-item__photo')).toBeNull();
    const present = render(GroupedListItem, { props: { title: text('A'), photo: text('P') } });
    expect(present.container.querySelector('.cinder-grouped-list-item__photo')).not.toBeNull();
  });

  test('renders the leading kind, the lead column, the trailing value and the action', () => {
    const { container } = render(GroupedListItem, {
      props: {
        title: text('A'),
        leading: text('L'),
        leadingKind: 'control',
        lead: text('45 min left'),
        trailing: text('12'),
        action: text('Menu'),
      },
    });
    expect(
      container
        .querySelector('.cinder-grouped-list-item__leading')
        ?.getAttribute('data-cinder-leading'),
    ).toBe('control');
    expect(container.querySelector('.cinder-grouped-list-item__lead')?.textContent).toBe(
      '45 min left',
    );
    expect(container.querySelector('.cinder-grouped-list-item__trailing')?.textContent).toBe('12');
    expect(container.querySelector('.cinder-grouped-list-item__action')?.textContent).toBe('Menu');
  });

  test('defaults the leading kind to icon', () => {
    const { container } = render(GroupedListItem, {
      props: { title: text('A'), leading: text('L') },
    });
    expect(
      container
        .querySelector('.cinder-grouped-list-item__leading')
        ?.getAttribute('data-cinder-leading'),
    ).toBe('icon');
  });

  test('with href the title is the one link and a chevron is drawn', () => {
    const { container } = render(GroupedListItem, {
      props: { title: text('Home'), href: '/home' },
    });
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('/home');
    expect(container.querySelector('.cinder-grouped-list-item__chevron')).not.toBeNull();
    expect(
      container.querySelector('li')?.classList.contains('cinder-grouped-list-item--linked'),
    ).toBe(true);
  });

  test('chevron false hides the chevron on a link', () => {
    const { container } = render(GroupedListItem, {
      props: {
        title: text('Home'),
        href: '/home',
        chevron: false,
      },
    });
    expect(container.querySelector('.cinder-grouped-list-item__chevron')).toBeNull();
  });

  test('a _blank link carries noopener and noreferrer', () => {
    const { container } = render(GroupedListItem, {
      props: {
        title: text('Home'),
        href: '/home',
        target: '_blank',
        rel: 'external',
      },
    });
    const rel = container.querySelector('a')?.getAttribute('rel') ?? '';
    expect(rel.split(' ').toSorted()).toEqual(['external', 'noopener', 'noreferrer']);
  });

  test('a selected row without a link is the current item', () => {
    const { container } = render(GroupedListItem, {
      props: { title: text('Home'), selected: true },
    });
    expect(container.querySelector('li')?.getAttribute('aria-current')).toBe('true');
  });

  test('stylesheet insets the separator, fixes the action column, and styles by class only', () => {
    const css = readFileSync(new URL('./grouped-list-item.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.cinder-grouped-list-item__content \{[^}]*border-block-end/);
    expect(css).not.toMatch(/\.cinder-grouped-list-item \{[^}]*border/);
    expect(css).toMatch(/\.cinder-grouped-list-item__action \{[^}]*inline-size: 2\.75rem/);
    expect(css).toMatch(/\.cinder-grouped-list-item__lead \{[^}]*inline-size: 5rem/);
    expect(css).not.toMatch(/\.cinder-grouped-list-item[\w-]*\s+(span|p|div|a|li)\b/);
  });
});
