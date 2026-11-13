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

  // COR-2329: Home's review and problem rows end in the button that is their point.
  test('draws each text action as a secondary small button, a link when it has href', () => {
    const { container } = render(GroupedListItem, {
      props: {
        title: text('Refund order 4471?'),
        actions: [
          { label: 'Review', href: '/reviews/1', changes: true },
          { label: 'Dismiss', onclick: () => {} },
        ],
      },
    });
    const row = container.querySelector('li');
    expect(row?.classList.contains('cinder-grouped-list-item--actions')).toBe(true);
    const buttons = [...container.querySelectorAll('.cinder-grouped-list-item__actions > *')];
    expect(buttons.map((button) => button.tagName)).toEqual(['A', 'BUTTON']);
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Review', 'Dismiss']);
    expect(buttons[0]?.getAttribute('href')).toBe('/reviews/1');
    expect(buttons[0]?.hasAttribute('data-changes')).toBe(true);
    expect(buttons[1]?.hasAttribute('data-changes')).toBe(false);
    for (const button of buttons) {
      expect(button.getAttribute('data-cinder-variant')).toBe('secondary');
    }
  });

  test('a row with no actions draws no actions part and no actions modifier', () => {
    const { container } = render(GroupedListItem, { props: { title: text('A'), actions: [] } });
    expect(container.querySelector('.cinder-grouped-list-item__actions')).toBeNull();
    expect(
      container.querySelector('li')?.classList.contains('cinder-grouped-list-item--actions'),
    ).toBe(false);
  });

  test('a disabled action keeps focus, says why, and does nothing when chosen', () => {
    let chosen = 0;
    const { container } = render(GroupedListItem, {
      props: {
        title: text('A'),
        actions: [
          {
            label: 'Review',
            onclick: () => {
              chosen += 1;
            },
            disabled: true,
            disabledReason: 'Off until it’s back',
          },
        ],
      },
    });
    const button = container.querySelector<HTMLButtonElement>(
      '.cinder-grouped-list-item__actions button',
    );
    expect(button?.getAttribute('aria-disabled')).toBe('true');
    expect(button?.hasAttribute('disabled')).toBe(false);
    const reasonId = button?.getAttribute('aria-describedby') ?? '';
    expect(container.querySelector(`[id="${reasonId}"]`)?.textContent).toBe('Off until it’s back');
    button?.click();
    expect(chosen).toBe(0);
  });

  test('stylesheet lifts the actions over the row link and stacks them full width on a phone', () => {
    const css = readFileSync(new URL('./grouped-list-item.css', import.meta.url), 'utf8')
      .replace(/\s+/g, ' ')
      .replace(/\/\*.*?\*\//g, '');
    expect(css).toMatch(/\.cinder-grouped-list-item__actions \{[^}]*z-index: 1/);
    const phone = /@media \(width < 640px\) \{(.*?)\} \}/.exec(css)?.[1] ?? '';
    expect(phone).toContain('flex-wrap: wrap');
    expect(phone).toMatch(/__actions \{[^}]*flex: 1 0 100%[^}]*flex-direction: column/);
    expect(phone).toMatch(/__actions > \.cinder-button \{ inline-size: 100%;/);
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
