/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { createRawSnippet, flushSync } from 'svelte';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/svelte');
const { default: Fixture } = await import('../../test/fixtures/dropdown-compound-fixture.svelte');
const { default: PolyFixture } =
  await import('../../test/fixtures/dropdown-item-polymorphic-fixture.svelte');
const { default: RadioFixture } =
  await import('../../test/fixtures/dropdown-item-radio-fixture.svelte');
const { default: CheckFixture } =
  await import('../../test/fixtures/dropdown-item-check-fixture.svelte');
const { default: DropdownItem } = await import('./dropdown-item.svelte');

// Unmount renders between tests; shared document.body otherwise leaks activeElement/nodes.
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

async function openMenu() {
  const result = render(Fixture);
  await fireEvent.click(requiredInstance(result.container.querySelector('.trigger'), HTMLElement));
  await waitFor(() => expect(document.body.querySelector('[role="menu"]')).not.toBeNull());
  return { ...result, container: document.body };
}

describe('DropdownItem', () => {
  test('throws when rendered outside a Dropdown', () => {
    expect(() =>
      render(DropdownItem, {
        props: {
          children: createRawSnippet(() => ({ render: () => '<span>x</span>', setup: () => {} })),
        },
      }),
    ).toThrow(/missing_context/);
  });

  test('renders as a button with role="menuitem"', async () => {
    const { container } = await openMenu();
    const item = container.querySelector('[role="menuitem"]');
    expect(item).not.toBeNull();
    expect(item?.tagName.toLowerCase()).toBe('button');
  });

  test('clicking an item invokes its onclick and closes the menu', async () => {
    const { container } = await openMenu();
    await fireEvent.click(
      requiredInstance(container.querySelector('[role="menuitem"]'), HTMLElement),
    );
    expect(container.querySelector('output')?.textContent).toBe('copy');
    flushSync();
    expect(container.querySelector('[role="menu"]')?.outerHTML ?? null).toBeNull();
  });

  test('rows use a roving tabindex: the first enabled row is the tab stop and the rest are -1', async () => {
    const { container } = await openMenu();
    const [first, ...rest] = Array.from(container.querySelectorAll('[role="menuitem"]'));
    expect(first?.getAttribute('tabindex')).toBe('0');
    expect(rest.length).toBeGreaterThan(0);
    for (const item of rest) expect(item.getAttribute('tabindex')).toBe('-1');
  });

  test('menuitemradio rows expose aria-checked state', async () => {
    const result = render(RadioFixture);
    await fireEvent.click(
      requiredInstance(result.container.querySelector('.trigger'), HTMLElement),
    );
    await waitFor(() => expect(document.body.querySelector('[role="menu"]')).not.toBeNull());
    const container = document.body;
    const radioItems = Array.from(container.querySelectorAll('[role="menuitemradio"]'));

    expect(radioItems).toHaveLength(2);
    expect(radioItems[0]?.getAttribute('aria-checked')).toBe('true');
    expect(radioItems[1]?.getAttribute('aria-checked')).toBe('false');
  });

  test('keydown Enter/Space does not synthesize a click (no double-fire)', async () => {
    const { container } = await openMenu();
    const item = requiredInstance(container.querySelector('[role="menuitem"]'), HTMLElement);
    item.focus();

    // Fire multiple keydown events as would happen when a key is held — a
    // Space held down produces repeated keydown events. With the old
    // handleKeydown bridge each repetition dispatched a synthetic click,
    // causing multi-fire.  After the fix, keydown alone must not trigger
    // activation; only a real click event should.
    await fireEvent.keyDown(item, { key: ' ' });
    await fireEvent.keyDown(item, { key: ' ' });
    await fireEvent.keyDown(item, { key: 'Enter' });
    await fireEvent.keyDown(item, { key: 'Enter' });

    // After all those keydowns the output must still be empty — none should
    // have fired the onclick handler via a synthetic MouseEvent('click').
    expect(container.querySelector('output')?.textContent).toBe('');

    // A real click still works.
    await fireEvent.click(item);
    await waitFor(() => expect(container.querySelector('output')?.textContent).toBe('copy'));
  });
});

async function openPolyMenu() {
  const result = render(PolyFixture);
  await fireEvent.click(requiredInstance(result.container.querySelector('.trigger'), HTMLElement));
  await waitFor(() => expect(document.body.querySelector('[role="menu"]')).not.toBeNull());
  return { ...result, container: document.body };
}

describe('DropdownItem — polymorphism', () => {
  test('link item renders as an <a> element with role="menuitem"', async () => {
    const { container } = await openPolyMenu();
    const items = container.querySelectorAll('[role="menuitem"]');
    const linkItem = items[0];
    expect(linkItem?.tagName.toLowerCase()).toBe('a');
    expect(linkItem?.getAttribute('href')).toBe('https://example.com');
    expect(linkItem?.getAttribute('role')).toBe('menuitem');
    // The first enabled row is the menu's tab stop; a link is no different from a button.
    expect(linkItem?.getAttribute('tabindex')).toBe('0');
    expect(items[1]?.getAttribute('tabindex')).toBe('-1');
  });

  test('submit item renders as a <button type="submit">', async () => {
    const { container } = await openPolyMenu();
    const items = container.querySelectorAll('[role="menuitem"]');
    const submitItem = items[1];
    expect(submitItem?.tagName.toLowerCase()).toBe('button');
    expect(submitItem?.getAttribute('type')).toBe('submit');
    expect(submitItem?.getAttribute('role')).toBe('menuitem');
  });

  test('button item forwards standard <button> attributes (name/value) for form submission', async () => {
    const { container } = await openPolyMenu();
    const items = container.querySelectorAll('[role="menuitem"]');
    const submitItem = items[1];
    // The button branch keeps the full HTMLButtonAttributes surface, so a
    // form-submitting menu item can carry name/value (e.g. <button name="action" value="logout">).
    expect(submitItem?.getAttribute('name')).toBe('action');
    expect(submitItem?.getAttribute('value')).toBe('logout');
  });

  test('clicking a link item invokes onclick and closes the menu', async () => {
    const { container } = await openPolyMenu();
    const items = container.querySelectorAll('[role="menuitem"]');
    const linkItem = requiredInstance(items[0], HTMLElement);
    await fireEvent.click(linkItem);
    expect(container.querySelector('output')?.textContent).toBe('link');
    flushSync();
    expect(container.querySelector('[role="menu"]')?.outerHTML ?? null).toBeNull();
  });

  test('clicking a submit item invokes onclick and closes the menu', async () => {
    const { container } = await openPolyMenu();
    const items = container.querySelectorAll('[role="menuitem"]');
    const submitItem = requiredInstance(items[1], HTMLElement);
    await fireEvent.click(submitItem);
    expect(container.querySelector('output')?.textContent).toBe('submit');
    flushSync();
    expect(container.querySelector('[role="menu"]')?.outerHTML ?? null).toBeNull();
  });

  test('Space activates a link item (matching button-row keyboard behavior)', async () => {
    // A native <a> activates on Enter but not Space; the WAI-ARIA menuitem
    // pattern requires both. The component translates Space into activation.
    const { container } = await openPolyMenu();
    const items = container.querySelectorAll('[role="menuitem"]');
    const linkItem = requiredInstance(items[0], HTMLElement);
    const event = await fireEvent.keyDown(linkItem, { key: ' ' });
    // Space is consumed (no page scroll) and the link is activated.
    expect(event).toBe(false); // fireEvent returns false when preventDefault was called
    expect(container.querySelector('output')?.textContent).toBe('link');
  });

  test('a link item still forwards a consumer onkeydown handler', async () => {
    // The Space-to-activate handler must compose with — not replace — a
    // consumer-provided onkeydown (it is part of the public HTMLAttributes surface).
    const { container } = await openPolyMenu();
    const items = container.querySelectorAll('[role="menuitem"]');
    const linkItem = requiredInstance(items[0], HTMLElement);
    await fireEvent.keyDown(linkItem, { key: 'ArrowRight' });
    const keyOutput = container.querySelector('[data-testid="last-link-key"]');
    expect(keyOutput?.textContent).toBe('ArrowRight');
  });

  test('disabled link item blocks its onclick and does not close the menu', async () => {
    const { container } = await openPolyMenu();
    const items = container.querySelectorAll('[role="menuitem"]');
    const disabledLink = requiredInstance(items[2], HTMLElement);
    expect(disabledLink?.getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(disabledLink);
    // onclick was blocked
    expect(container.querySelector('output')?.textContent).toBe('');
    // menu remains open
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
  });
});

/**
 * COR-2664: a checkable item draws a check mark while checked and keeps the mark's slot while
 * unchecked, so every label in a radio or checkbox group starts at the same edge. The mark is
 * decoration; `aria-checked` carries the state.
 */
describe('DropdownItem check mark', () => {
  async function openCheckMenu(props: { density?: string } = {}) {
    const result = render(CheckFixture, { props });
    await fireEvent.click(
      requiredInstance(result.container.querySelector('.trigger'), HTMLElement),
    );
    await waitFor(() => expect(document.body.querySelector('[role="menu"]')).not.toBeNull());
    const byRole = (role: string) =>
      Array.from(document.body.querySelectorAll<HTMLElement>(`[role="${role}"]`));
    return {
      ...result,
      radios: byRole('menuitemradio'),
      checkboxes: byRole('menuitemcheckbox'),
      plain: byRole('menuitem'),
    };
  }

  test('a checkable item without a reason leads with one hidden check slot', async () => {
    const { radios, checkboxes } = await openCheckMenu();
    for (const item of [radios[0]!, radios[1]!, ...checkboxes]) {
      const slots = item.querySelectorAll('.cinder-dropdown-item__check');
      expect(slots).toHaveLength(1);
      expect(item.firstElementChild).toBe(slots[0]!);
      expect(slots[0]!.getAttribute('aria-hidden')).toBe('true');
    }
  });

  test('the slot holds a mark only while the item is checked', async () => {
    const { radios, checkboxes } = await openCheckMenu();
    const mark = (item: HTMLElement) =>
      item.querySelector('.cinder-dropdown-item__check svg') !== null;
    expect(radios.map(mark)).toEqual([true, false, false]);
    expect(checkboxes.map(mark)).toEqual([true, false]);
    expect(radios.map((item) => item.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ]);
  });

  test('the mark follows checked', async () => {
    const { radios, rerender } = await openCheckMenu();
    await rerender({ density: 'comfortable' });
    const mark = (item: HTMLElement) =>
      item.querySelector('.cinder-dropdown-item__check svg') !== null;
    expect(radios.map(mark)).toEqual([false, true, false]);
  });

  test('a plain menu item draws no check slot', async () => {
    const { plain } = await openCheckMenu();
    expect(plain).toHaveLength(1);
    expect(plain[0]!.querySelector('.cinder-dropdown-item__check')).toBeNull();
  });

  test('the check mark is not part of the item name', async () => {
    const { radios } = await openCheckMenu();
    expect(radios[0]!.textContent?.trim()).toBe('Compact');
  });
});
