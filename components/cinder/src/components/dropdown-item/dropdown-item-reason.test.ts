/// <reference lib="dom" />
/**
 * `disabledReason` (COR-2327): a disabled item says why on a second line under its label and names
 * it as its description, so a phone, which never shows a `title`, reads it too. The label alone is
 * the item's name, an enabled item draws no reason, and an item with no reason keeps its markup.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/svelte');
const { default: Fixture } =
  await import('../../test/fixtures/dropdown-item-reason-fixture.svelte');
const { default: CheckFixture } =
  await import('../../test/fixtures/dropdown-item-check-fixture.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

async function openMenu(props: { archiveOff?: boolean } = {}) {
  const result = render(Fixture, { props });
  await fireEvent.click(requiredInstance(result.container.querySelector('.trigger'), HTMLElement));
  await waitFor(() => expect(document.body.querySelector('[role="menu"]')).not.toBeNull());
  const items = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  return { ...result, items };
}

/** The text of the elements an `aria-labelledby` or `aria-describedby` names, in order. */
function textOf(ids: string | null): string {
  return (ids ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    .join(' ');
}

describe('DropdownItem disabledReason', () => {
  test('a disabled item draws its reason as a second line and is described by it', async () => {
    const { items } = await openMenu();
    const archive = items[0]!;
    const reason = requiredInstance(
      archive.querySelector('.cinder-dropdown-item__reason'),
      HTMLElement,
    );
    expect(reason.textContent?.trim()).toBe('Wait for the run to finish, then archive the chat.');
    expect(archive.hasAttribute('data-cinder-reason')).toBe(true);
    expect(archive.getAttribute('aria-disabled')).toBe('true');
    expect(textOf(archive.getAttribute('aria-describedby'))).toBe(
      'Wait for the run to finish, then archive the chat.',
    );
    // The name is the label alone, not the label and the reason.
    expect(textOf(archive.getAttribute('aria-labelledby'))).toBe('Archive');
    expect(archive.hasAttribute('title')).toBe(false);
  });

  test('the reason is drawn after the label, which keeps the icon and the text', async () => {
    const { items } = await openMenu();
    const archive = items[0]!;
    const [label, reason] = Array.from(archive.children);
    expect(label?.className).toContain('cinder-dropdown-item__label');
    expect(label?.querySelector('svg')).not.toBeNull();
    expect(reason?.className).toContain('cinder-dropdown-item__reason');
  });

  test('an enabled item draws no reason and keeps its single-line markup', async () => {
    const { items } = await openMenu({ archiveOff: false });
    const archive = items[0]!;
    expect(archive.querySelector('.cinder-dropdown-item__reason')).toBeNull();
    expect(archive.querySelector('.cinder-dropdown-item__label')).toBeNull();
    expect(archive.hasAttribute('data-cinder-reason')).toBe(false);
    expect(archive.hasAttribute('aria-describedby')).toBe(false);
    expect(archive.hasAttribute('aria-labelledby')).toBe(false);
  });

  test('a disabled item with no reason, or a blank one, draws no second line', async () => {
    const { items } = await openMenu();
    for (const item of [items[1]!, items[3]!]) {
      expect(item.querySelector('.cinder-dropdown-item__reason')).toBeNull();
      expect(item.hasAttribute('aria-describedby')).toBe(false);
    }
  });

  test("a link item keeps the consumer's own description before the reason", async () => {
    const { items } = await openMenu();
    const open = items[2]!;
    expect(open.tagName.toLowerCase()).toBe('a');
    expect(textOf(open.getAttribute('aria-describedby'))).toBe(
      'Also read this. Nothing to open yet.',
    );
  });

  test('a checkable item with a reason keeps its check slot on the label line (COR-2664)', async () => {
    const result = render(CheckFixture, { props: { density: 'spacious' } });
    await fireEvent.click(
      requiredInstance(result.container.querySelector('.trigger'), HTMLElement),
    );
    await waitFor(() => expect(document.body.querySelector('[role="menu"]')).not.toBeNull());
    const spacious = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    )[2]!;
    const [label, reason] = Array.from(spacious.children);
    expect(label?.className).toContain('cinder-dropdown-item__label');
    expect(label?.firstElementChild?.className).toContain('cinder-dropdown-item__check');
    expect(label?.querySelector('.cinder-dropdown-item__check svg')).not.toBeNull();
    expect(reason?.className).toContain('cinder-dropdown-item__reason');
    expect(spacious.querySelectorAll('.cinder-dropdown-item__check')).toHaveLength(1);
    expect(textOf(spacious.getAttribute('aria-labelledby'))).toBe('Spacious');
  });
});
