/// <reference lib="dom" />
/**
 * `disabledReason` (COR-2665): a disabled side navigation row says why on a second line under its
 * label and is described by it, so a phone, which never shows a hover tooltip, reads it too. The
 * label alone is the row's name, an enabled row draws no reason, and a row with no reason keeps
 * its markup. Mirrors Dropdown's `disabledReason` (COR-2327).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, waitFor, cleanup } = await import('@testing-library/svelte');
const { default: SideNavigationItem } = await import('./side-navigation-item.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function labelSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>`, setup: () => {} }));
}

function iconSnippet() {
  return createRawSnippet(() => ({
    render: () => '<svg viewBox="0 0 16 16" width="16" height="16"></svg>',
    setup: () => {},
  }));
}

/** The text of the elements an `aria-describedby` names, in order. */
function textOf(ids: string | null): string {
  return (ids ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    .join(' ');
}

const REASON = 'Open a task queue first';

/** The Temporal UI's row: a button-form row with no icon and no handler, named by `label`. */
function renderTemporalRow(props: Record<string, unknown> = {}) {
  return render(SideNavigationItem, {
    props: {
      disabled: true,
      label: 'Workers',
      disabledReason: REASON,
      children: labelSnippet('Workers'),
      ...props,
    },
  });
}

describe('SideNavigationItem disabledReason', () => {
  test('a disabled row draws its reason once, after the label', () => {
    const { container } = renderTemporalRow();
    const row = container.querySelector<HTMLElement>('.cinder-side-navigation-item')!;
    const reasons = row.querySelectorAll('.cinder-side-navigation-item__reason');
    expect(reasons).toHaveLength(1);
    expect(reasons[0]!.textContent?.trim()).toBe(REASON);
    expect(row.lastElementChild).toBe(reasons[0]!);
    expect(row.hasAttribute('data-cinder-reason')).toBe(true);
  });

  test('the row is named by its label and described by its reason', () => {
    const { container } = renderTemporalRow();
    const button = container.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toBe('Workers');
    expect(textOf(button.getAttribute('aria-describedby'))).toBe(REASON);
  });

  test("a consumer's own description comes before the reason", () => {
    const note = document.createElement('p');
    note.id = 'own-note';
    note.textContent = 'Also read this.';
    document.body.append(note);
    const { container } = renderTemporalRow({ 'aria-describedby': 'own-note' });
    const button = container.querySelector('button')!;
    expect(textOf(button.getAttribute('aria-describedby'))).toBe(`Also read this. ${REASON}`);
  });

  test('a row named by its own aria-labelledby is still described by its reason', () => {
    const name = document.createElement('span');
    name.id = 'own-name';
    name.textContent = 'Workers page';
    document.body.append(name);
    const { container } = renderTemporalRow({ label: undefined, 'aria-labelledby': 'own-name' });
    const button = container.querySelector('button')!;
    expect(button.getAttribute('aria-labelledby')).toBe('own-name');
    expect(textOf(button.getAttribute('aria-describedby'))).toBe(REASON);
  });

  test('a row without an icon keeps its children as direct children of the button', () => {
    const { container } = renderTemporalRow();
    const button = container.querySelector('button')!;
    const [label, reason] = Array.from(button.children);
    expect(label?.tagName.toLowerCase()).toBe('span');
    expect(label?.textContent).toBe('Workers');
    expect(reason?.className).toContain('cinder-side-navigation-item__reason');
  });

  test('a row with an icon stacks the reason under the label, past the icon', () => {
    const { container } = render(SideNavigationItem, {
      props: {
        href: '/workers',
        disabled: true,
        label: 'Workers',
        disabledReason: REASON,
        icon: iconSnippet(),
        children: labelSnippet('Workers'),
      },
    });
    const row = container.querySelector<HTMLElement>('.cinder-side-navigation-item')!;
    const [icon, text] = Array.from(row.children);
    expect(icon?.className).toContain('cinder-side-navigation-item__icon');
    expect(text?.className).toContain('cinder-side-navigation-item__text');
    const [label, reason] = Array.from(text!.children);
    expect(label?.className).toContain('cinder-side-navigation-item__label');
    expect(reason?.className).toContain('cinder-side-navigation-item__reason');
  });

  test('an enabled row draws no reason and keeps its markup', () => {
    const { container } = render(SideNavigationItem, {
      props: {
        href: '/workers',
        label: 'Workers',
        disabledReason: REASON,
        children: labelSnippet('Workers'),
      },
    });
    const anchor = container.querySelector('a')!;
    expect(anchor.querySelector('.cinder-side-navigation-item__reason')).toBeNull();
    expect(anchor.hasAttribute('data-cinder-reason')).toBe(false);
    expect(anchor.hasAttribute('aria-describedby')).toBe(false);
    expect(anchor.hasAttribute('aria-label')).toBe(false);
  });

  test('a disabled row with no reason, or a blank one, draws no second line', () => {
    for (const disabledReason of [undefined, '   ']) {
      const { container, unmount } = renderTemporalRow({ disabledReason });
      const button = container.querySelector('button')!;
      expect(button.querySelector('.cinder-side-navigation-item__reason')).toBeNull();
      expect(button.hasAttribute('aria-describedby')).toBe(false);
      expect(button.hasAttribute('aria-label')).toBe(false);
      unmount();
    }
  });

  test('a counted row keeps its composed name and adds the reason as its description', () => {
    const { container } = renderTemporalRow({ count: 2, countLabel: 'stopped' });
    const button = container.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toBe('Workers, 2 stopped');
    expect(textOf(button.getAttribute('aria-describedby'))).toBe(REASON);
  });

  test('a collapsed row keeps the reason for its description and says it in the tooltip', async () => {
    const { container } = render(SideNavigationItem, {
      props: {
        href: '/workers',
        disabled: true,
        label: 'Workers',
        emptyLabel: 'nothing running',
        disabledReason: REASON,
        collapsed: true,
        icon: iconSnippet(),
        children: labelSnippet('Workers'),
      },
    });
    const anchor = container.querySelector('a')!;
    expect(anchor.querySelector('.cinder-side-navigation-item__reason')).not.toBeNull();
    expect(textOf(anchor.getAttribute('aria-describedby'))).toBe(REASON);
    await waitFor(() =>
      expect(document.querySelector('[role="tooltip"]')?.textContent?.trim()).toBe(
        `Workers, ${REASON}`,
      ),
    );
  });

  test('an expanded disabled row that shows its reason draws no tooltip repeating it (COR-2680)', async () => {
    // A counted row is the control: its tooltip appears once anchors resolve, so by then the
    // disabled row has had the same chance to draw one.
    const counted = render(SideNavigationItem, {
      props: { href: '/h', label: 'Health', count: 3, children: labelSnippet('Health') },
    });
    await waitFor(() => expect(counted.container.querySelector('[role="tooltip"]')).not.toBeNull());
    const { container } = renderTemporalRow({ emptyLabel: 'nothing to show' });
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    expect(
      container.querySelector('[data-cinder-navigation-item]')?.hasAttribute('data-cinder-tooltip'),
    ).toBe(false);
  });

  test('a collapsed disabled row keeps its tooltip and marks itself for hover feedback', async () => {
    const { container } = render(SideNavigationItem, {
      props: {
        href: '/workers',
        disabled: true,
        label: 'Workers',
        disabledReason: REASON,
        collapsed: true,
        icon: iconSnippet(),
        children: labelSnippet('Workers'),
      },
    });
    await waitFor(() => expect(document.querySelector('[role="tooltip"]')).not.toBeNull());
    expect(
      container.querySelector('[data-cinder-navigation-item]')?.hasAttribute('data-cinder-tooltip'),
    ).toBe(true);
  });
});
