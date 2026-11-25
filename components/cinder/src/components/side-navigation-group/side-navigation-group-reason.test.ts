/// <reference lib="dom" />
/**
 * COR-2680: a SideNavigation.Group states one reason for its disabled rows, drawn once, and that
 * reason is the description of every disabled row that does not say something different. A row
 * draws its own reason only when it differs from its group's.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, cleanup } = await import('@testing-library/svelte');
const { default: Harness } = await import('./_reason-harness.svelte');
const { default: RailHarness } = await import('./_reason-rail-harness.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** The text of the elements an `aria-describedby` names, in order. */
function textOf(ids: string | null): string {
  return (ids ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    .join(' ');
}

function rowNamed(container: HTMLElement, name: string): HTMLElement {
  const row =
    container.querySelector<HTMLElement>(`[data-cinder-navigation-item][aria-label="${name}"]`) ??
    Array.from(container.querySelectorAll<HTMLElement>('[data-cinder-navigation-item]')).find(
      (candidate) => candidate.textContent?.trim().startsWith(name),
    );
  if (row === undefined || row === null) throw new Error(`No row named ${name}.`);
  return row;
}

describe('SideNavigation.Group disabledReason', () => {
  test('the group draws its reason once, between its header and its list', () => {
    const { container } = render(Harness);
    const group = container.querySelector('.cinder-side-navigation-group')!;
    const reasons = group.querySelectorAll('.cinder-side-navigation-group__reason');
    expect(reasons).toHaveLength(1);
    expect(reasons[0]!.textContent?.trim()).toBe('Choose a connection first');
    const panel = group.querySelector('.cinder-side-navigation-group__panel')!;
    expect(reasons[0]!.nextElementSibling).toBe(panel);
    expect(panel.contains(reasons[0]!)).toBe(false);
  });

  test('a disabled row with no reason, or the same one, draws none and is described by the group', () => {
    const { container } = render(Harness);
    const groupReason = container.querySelector('.cinder-side-navigation-group__reason')!;
    for (const name of ['Workflows', 'Schedules']) {
      const row = rowNamed(container, name);
      expect(row.querySelector('.cinder-side-navigation-item__reason')).toBeNull();
      expect(row.getAttribute('aria-describedby')?.split(' ')).toContain(groupReason.id);
      expect(textOf(row.getAttribute('aria-describedby'))).toBe('Choose a connection first');
    }
  });

  test('a disabled row with a different reason draws its own and is described by it', () => {
    const { container } = render(Harness);
    const row = rowNamed(container, 'Task queue');
    expect(row.querySelector('.cinder-side-navigation-item__reason')?.textContent?.trim()).toBe(
      'Open a task queue first',
    );
    expect(textOf(row.getAttribute('aria-describedby'))).toBe('Open a task queue first');
  });

  test('an enabled row is not described by the group reason', () => {
    const { container } = render(Harness);
    const row = container.querySelector('a[href="/connections"]')!;
    expect(row.hasAttribute('aria-describedby')).toBe(false);
  });

  test('a group with a blank reason draws none and leaves its rows as they were', () => {
    const { container } = render(Harness, { props: { reason: '   ' } });
    expect(container.querySelector('.cinder-side-navigation-group__reason')).toBeNull();
    const schedules = rowNamed(container, 'Schedules');
    expect(
      schedules.querySelector('.cinder-side-navigation-item__reason')?.textContent?.trim(),
    ).toBe('Choose a connection first');
  });

  test('a collapsed group hides its reason with its list', () => {
    const { container } = render(Harness, { props: { expanded: false } });
    const reason = container.querySelector<HTMLElement>('.cinder-side-navigation-group__reason')!;
    expect(reason.hidden).toBe(true);
  });

  test('in a collapsed rail the group reason stays for its rows and is marked collapsed', () => {
    const { container } = render(RailHarness);
    const reason = container.querySelector<HTMLElement>('.cinder-side-navigation-group__reason')!;
    expect(reason.hasAttribute('data-cinder-collapsed')).toBe(true);
    const row = container.querySelector<HTMLElement>('[data-cinder-navigation-item]')!;
    expect(row.getAttribute('aria-describedby')?.split(' ')).toContain(reason.id);
  });
});
