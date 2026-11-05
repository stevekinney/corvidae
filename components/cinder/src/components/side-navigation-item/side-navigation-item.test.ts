/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, waitFor } = await import('@testing-library/svelte');
const { default: SideNavigationItem } = await import('./side-navigation-item.svelte');

function labelSnippet(text = 'Dashboard') {
  return createRawSnippet(() => ({
    render: () => `<span>${text}</span>`,
    setup: () => {},
  }));
}

describe('SideNavigationItem', () => {
  test('renders <li class="cinder-side-navigation__item"> wrapping a NavigationItem', () => {
    const { container } = render(SideNavigationItem, {
      props: { href: '/dashboard', children: labelSnippet() },
    });
    const li = container.querySelector('li.cinder-side-navigation__item');
    expect(li).not.toBeNull();
    expect(li?.querySelector('.cinder-navigation-item')).not.toBeNull();
  });

  test('NavigationItem link arm: renders <a> inside the <li>', () => {
    const { container } = render(SideNavigationItem, {
      props: { href: '/settings', children: labelSnippet('Settings') },
    });
    const anchor = container.querySelector('li > a');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe('/settings');
  });

  test('NavigationItem button arm: renders <button> inside the <li>', () => {
    const { container } = render(SideNavigationItem, {
      props: { onclick: () => {}, children: labelSnippet('Action') },
    });
    const button = container.querySelector('li > button');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('type')).toBe('button');
  });

  test('forwards active prop to NavigationItem', () => {
    const { container } = render(SideNavigationItem, {
      props: { href: '/dashboard', active: true, children: labelSnippet() },
    });
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('aria-current')).toBe('page');
  });

  test('forwards disabled prop to NavigationItem', () => {
    const { container } = render(SideNavigationItem, {
      props: { href: '/admin', disabled: true, children: labelSnippet() },
    });
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('aria-disabled')).toBe('true');
  });

  test('forwards class prop to inner NavigationItem, not the <li>', () => {
    const { container } = render(SideNavigationItem, {
      props: { href: '/dashboard', class: 'custom-item', children: labelSnippet() },
    });
    const navItem = container.querySelector('.cinder-navigation-item');
    expect(navItem?.classList.contains('custom-item')).toBe(true);
    const li = container.querySelector('li');
    expect(li?.classList.contains('custom-item')).toBe(false);
  });

  test('listItemClass merges onto the outer <li>', () => {
    const { container } = render(SideNavigationItem, {
      props: { href: '/dashboard', listItemClass: 'pinned', children: labelSnippet() },
    });
    const li = container.querySelector('li');
    expect(li?.classList.contains('cinder-side-navigation__item')).toBe(true);
    expect(li?.classList.contains('pinned')).toBe(true);
  });

  test('cinder-navigation-item class present on the rendered NavigationItem', () => {
    const { container } = render(SideNavigationItem, {
      props: { href: '/dashboard', children: labelSnippet() },
    });
    expect(container.querySelector('.cinder-navigation-item')).not.toBeNull();
  });

  test('inner NavigationItem (link arm) is always rendered with data-variant="vertical"', () => {
    const { container } = render(SideNavigationItem, {
      props: { href: '/dashboard', children: labelSnippet() },
    });
    const navItem = container.querySelector('.cinder-navigation-item');
    expect(navItem?.getAttribute('data-variant')).toBe('vertical');
  });

  test('inner NavigationItem (button arm) is always rendered with data-variant="vertical"', () => {
    const { container } = render(SideNavigationItem, {
      props: { onclick: () => {}, children: labelSnippet('Action') },
    });
    const navItem = container.querySelector('.cinder-navigation-item');
    expect(navItem?.getAttribute('data-variant')).toBe('vertical');
  });

  test('active vertical item exposes both data-active and data-variant', () => {
    const { container } = render(SideNavigationItem, {
      props: { href: '/projects', active: true, children: labelSnippet('Projects') },
    });
    const navItem = container.querySelector('.cinder-navigation-item');
    expect(navItem?.getAttribute('data-variant')).toBe('vertical');
    expect(navItem?.getAttribute('data-active')).toBe('true');
  });
});

function iconSnippet() {
  return createRawSnippet(() => ({
    render: () => '<svg data-icon viewBox="0 0 16 16" width="16" height="16"></svg>',
    setup: () => {},
  }));
}

describe('SideNavigationItem empty label (row 03k)', () => {
  test('a row with no count names its state: "Health, nothing needs attention"', () => {
    const { container } = render(SideNavigationItem, {
      props: {
        href: '/health',
        label: 'Health',
        count: 0,
        countLabel: 'need attention',
        emptyLabel: 'nothing needs attention',
        dot: 'success',
        children: labelSnippet('Health'),
      },
    });
    expect(container.querySelector('a')?.getAttribute('aria-label')).toBe(
      'Health, nothing needs attention',
    );
    expect(
      container.querySelector('.cinder-side-navigation-item__dot')?.getAttribute('aria-hidden'),
    ).toBe('true');
  });

  test('a count wins over the empty label', () => {
    const { container } = render(SideNavigationItem, {
      props: {
        href: '/health',
        label: 'Health',
        count: 3,
        countLabel: 'need attention',
        emptyLabel: 'nothing needs attention',
        dot: 'warning',
        children: labelSnippet('Health'),
      },
    });
    expect(container.querySelector('a')?.getAttribute('aria-label')).toBe(
      'Health, 3 need attention',
    );
  });

  test('without an empty label a row with no count is named by its content alone', () => {
    const { container } = render(SideNavigationItem, {
      props: { href: '/reviews', label: 'Reviews', count: 0, children: labelSnippet('Reviews') },
    });
    expect(container.querySelector('a')?.hasAttribute('aria-label')).toBe(false);
  });
});

describe('SideNavigationItem accessible name (rows 02q and 03b)', () => {
  test('a count names the row: "Health, 3 need attention"', () => {
    const { container } = render(SideNavigationItem, {
      props: {
        href: '/health',
        label: 'Health',
        count: 3,
        countLabel: 'need attention',
        dot: 'warning',
        children: labelSnippet('Health'),
      },
    });
    expect(container.querySelector('a')?.getAttribute('aria-label')).toBe(
      'Health, 3 need attention',
    );
  });

  test('"Reviews, 2 need you" names a counted row', () => {
    const { container } = render(SideNavigationItem, {
      props: {
        href: '/reviews',
        label: 'Reviews',
        count: 2,
        countLabel: 'need you',
        children: labelSnippet('Reviews'),
      },
    });
    expect(container.querySelector('a')?.getAttribute('aria-label')).toBe('Reviews, 2 need you');
  });

  test('a count without words still names the row, and a zero count adds nothing', () => {
    const counted = render(SideNavigationItem, {
      props: { href: '/a', label: 'Runs', count: 5, children: labelSnippet('Runs') },
    });
    expect(counted.container.querySelector('a')?.getAttribute('aria-label')).toBe('Runs, 5');
    const zero = render(SideNavigationItem, {
      props: {
        href: '/b',
        label: 'Reviews',
        count: 0,
        countLabel: 'need you',
        children: labelSnippet('Reviews'),
      },
    });
    expect(zero.container.querySelector('a')?.hasAttribute('aria-label')).toBe(false);
    expect(zero.container.querySelector('.cinder-side-navigation-item__count')).toBeNull();
  });

  test('a consumer aria-label wins over the composed name', () => {
    const { container } = render(SideNavigationItem, {
      props: {
        href: '/reviews',
        label: 'Reviews',
        count: 2,
        'aria-label': 'Open reviews',
        children: labelSnippet('Reviews'),
      },
    });
    expect(container.querySelector('a')?.getAttribute('aria-label')).toBe('Open reviews');
  });

  test('the new props never reach the element as attributes', () => {
    const { container } = render(SideNavigationItem, {
      props: {
        href: '/reviews',
        label: 'Reviews',
        count: 2,
        countLabel: 'need you',
        countTone: 'danger',
        dot: 'warning',
        collapsed: true,
        icon: iconSnippet(),
        children: labelSnippet('Reviews'),
      },
    });
    const anchor = container.querySelector('a');
    for (const name of ['label', 'count', 'countlabel', 'counttone', 'dot', 'collapsed']) {
      expect(anchor?.hasAttribute(name), name).toBe(false);
    }
  });
});

describe('SideNavigationItem indicators', () => {
  test('the dot is hidden from assistive technology so colour is never the only signal', () => {
    const { container } = render(SideNavigationItem, {
      props: {
        href: '/health',
        label: 'Health',
        count: 3,
        countLabel: 'need attention',
        dot: 'warning',
        children: labelSnippet('Health'),
      },
    });
    const dot = container.querySelector('.cinder-side-navigation-item__dot');
    expect(dot?.getAttribute('aria-hidden')).toBe('true');
    expect(dot?.querySelector('[data-cinder-status="warning"]')).not.toBeNull();
    // The dot replaces the pill: the count is in the name, not drawn.
    expect(container.querySelector('.cinder-side-navigation-item__count')).toBeNull();
  });

  test('a count draws a warning pill by default whose own name is the count and its words', () => {
    const { container } = render(SideNavigationItem, {
      props: {
        href: '/reviews',
        label: 'Reviews',
        count: 2,
        countLabel: 'need you',
        children: labelSnippet('Reviews'),
      },
    });
    const pill = container.querySelector('.cinder-side-navigation-item__count');
    expect(pill?.textContent?.trim()).toBe('2');
    expect(pill?.getAttribute('data-cinder-variant')).toBe('warning');
    expect(pill?.getAttribute('role')).toBe('img');
    expect(pill?.getAttribute('aria-label')).toBe('2 need you');
  });

  test('countTone changes the pill tone', () => {
    const { container } = render(SideNavigationItem, {
      props: {
        href: '/health',
        count: 1,
        countTone: 'danger',
        children: labelSnippet('Health'),
      },
    });
    expect(
      container
        .querySelector('.cinder-side-navigation-item__count')
        ?.getAttribute('data-cinder-variant'),
    ).toBe('danger');
  });

  test('a row with neither a count nor a dot draws no indicator', () => {
    const { container } = render(SideNavigationItem, {
      props: { href: '/runs', label: 'Runs', children: labelSnippet('Runs') },
    });
    expect(container.querySelector('.cinder-side-navigation-item__count')).toBeNull();
    expect(container.querySelector('.cinder-side-navigation-item__dot')).toBeNull();
  });
});

describe('SideNavigationItem tooltip', () => {
  function tooltipOf(container: HTMLElement): HTMLElement | null {
    return container.ownerDocument.querySelector('[role="tooltip"]');
  }

  test('a collapsed row carries "Reviews · 2 need you"', async () => {
    const { container } = render(SideNavigationItem, {
      props: {
        href: '/reviews',
        label: 'Reviews',
        count: 2,
        countLabel: 'need you',
        collapsed: true,
        icon: iconSnippet(),
        children: labelSnippet('Reviews'),
      },
    });
    await waitFor(() =>
      expect(tooltipOf(container)?.textContent?.trim()).toBe('Reviews · 2 need you'),
    );
    expect(container.querySelector('a')?.getAttribute('aria-label')).toBe('Reviews, 2 need you');
  });

  test('a collapsed row without a count carries the label alone', async () => {
    const { container } = render(SideNavigationItem, {
      props: {
        href: '/runs',
        label: 'Runs',
        collapsed: true,
        icon: iconSnippet(),
        children: labelSnippet('Runs'),
      },
    });
    await waitFor(() => expect(tooltipOf(container)?.textContent?.trim()).toBe('Runs'));
  });

  test('an expanded row with a count carries its accessible name, "Health, 3 need attention"', async () => {
    const { container } = render(SideNavigationItem, {
      props: {
        href: '/health',
        label: 'Health',
        count: 3,
        countLabel: 'need attention',
        dot: 'warning',
        children: labelSnippet('Health'),
      },
    });
    await waitFor(() =>
      expect(tooltipOf(container)?.textContent?.trim()).toBe('Health, 3 need attention'),
    );
  });

  test('an expanded row with nothing to add draws no tooltip, and the tooltip never describes the row', async () => {
    const { container } = render(SideNavigationItem, {
      props: { href: '/runs', label: 'Runs', children: labelSnippet('Runs') },
    });
    // The tooltip appears once the row's anchor resolves, so a counted row is the control: wait for
    // its panel, and by then an uncounted row has had the same chance to draw one.
    const counted = render(SideNavigationItem, {
      props: { href: '/h', label: 'Health', count: 3, children: labelSnippet('Health') },
    });
    await waitFor(() => expect(tooltipOf(counted.container)).not.toBeNull());
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    // The name already carries the words, so the tooltip is not also its description.
    expect(counted.container.querySelector('a')?.hasAttribute('aria-describedby')).toBe(false);
  });

  test('hovering or focusing the link shows the tooltip', async () => {
    const { container } = render(SideNavigationItem, {
      props: {
        href: '/health',
        label: 'Health',
        count: 3,
        countLabel: 'need attention',
        children: labelSnippet('Health'),
      },
    });
    const anchor = container.querySelector('a');
    await waitFor(() => expect(tooltipOf(container)).not.toBeNull());
    expect(tooltipOf(container)?.hasAttribute('data-cinder-visible')).toBe(false);
    anchor?.dispatchEvent(new Event('mouseenter'));
    await waitFor(() =>
      expect(tooltipOf(container)?.hasAttribute('data-cinder-visible')).toBe(true),
    );
  });

  test('the tooltip panel is a sibling of the link, never part of its text or name', async () => {
    const { container } = render(SideNavigationItem, {
      props: {
        href: '/reviews',
        label: 'Reviews',
        count: 2,
        collapsed: true,
        icon: iconSnippet(),
        children: labelSnippet('Reviews'),
      },
    });
    await waitFor(() => expect(tooltipOf(container)).not.toBeNull());
    expect(container.querySelector('a [role="tooltip"]')).toBeNull();
    expect(container.querySelector('a')?.textContent).not.toContain('need you');
    expect(tooltipOf(container)?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('SideNavigationItem collapsed rail', () => {
  test('stamps data-cinder-collapsed and data-cinder-has-icon, and keeps the label in the DOM', () => {
    const { container } = render(SideNavigationItem, {
      props: {
        href: '/reviews',
        label: 'Reviews',
        collapsed: true,
        icon: iconSnippet(),
        children: labelSnippet('Reviews'),
      },
    });
    const anchor = container.querySelector('a');
    expect(anchor?.hasAttribute('data-cinder-collapsed')).toBe(true);
    expect(anchor?.hasAttribute('data-cinder-has-icon')).toBe(true);
    expect(
      anchor?.querySelector('.cinder-side-navigation-item__icon')?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(anchor?.querySelector('.cinder-side-navigation-item__label')?.textContent).toContain(
      'Reviews',
    );
  });

  test('an expanded row has neither attribute', () => {
    const { container } = render(SideNavigationItem, {
      props: { href: '/reviews', children: labelSnippet('Reviews') },
    });
    const anchor = container.querySelector('a');
    expect(anchor?.hasAttribute('data-cinder-collapsed')).toBe(false);
    expect(anchor?.hasAttribute('data-cinder-has-icon')).toBe(false);
  });

  test('a row follows its enclosing Sidebar without being told', async () => {
    const { default: Harness } = await import('./side-navigation-item-rail.test.svelte');
    const expanded = render(Harness, { props: { collapsed: false } });
    expect(expanded.container.querySelector('a')?.hasAttribute('data-cinder-collapsed')).toBe(
      false,
    );
    expanded.unmount();
    const collapsed = render(Harness, { props: { collapsed: true } });
    expect(collapsed.container.querySelector('a')?.hasAttribute('data-cinder-collapsed')).toBe(
      true,
    );
  });

  test('a legacy row keeps its own icon and label as direct children of the link when collapsed', async () => {
    // A shell that styles the link's direct children (the Interborough rail hides every child that
    // is not an svg, an img or aria-hidden) must keep finding the consumer's icon where it always
    // was, so a row without an `icon` snippet gets no wrapper around its children.
    const { default: Harness } = await import('./side-navigation-item-legacy-rail.test.svelte');
    for (const collapsed of [false, true]) {
      const { container, unmount } = render(Harness, { props: { collapsed } });
      const anchor = container.querySelector('a');
      expect(anchor?.hasAttribute('data-cinder-collapsed')).toBe(collapsed);
      expect(anchor?.querySelector('.cinder-side-navigation-item__label')).toBeNull();
      const children = [...(anchor?.children ?? [])];
      expect(children.map((child) => child.tagName.toLowerCase())).toEqual(['svg', 'span']);
      expect(children[0]?.parentElement).toBe(anchor);
      unmount();
    }
  });
});
