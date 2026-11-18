/// <reference lib="dom" />
/**
 * `disabledReason` (COR-2327): a disabled item says why on a second line under its label and names
 * it as its description, so a phone, which never shows a `title`, reads it too. The label alone is
 * the item's name, an enabled item draws no reason, and an item with no reason keeps its markup.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/svelte');
const { default: Fixture } =
  await import('../../test/fixtures/dropdown-item-reason-fixture.svelte');

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

  test('COR-2431: an enabled item with a description draws it as a second line and is described by it', async () => {
    const { items } = await openMenu();
    const pause = items[4]!;
    const line = requiredInstance(
      pause.querySelector('.cinder-dropdown-item__reason'),
      HTMLElement,
    );
    expect(line.textContent?.trim()).toBe(
      'Runs in flight finish. No new runs start until you resume it.',
    );
    expect(pause.hasAttribute('aria-disabled')).toBe(false);
    expect(textOf(pause.getAttribute('aria-labelledby'))).toBe('Pause');
    expect(textOf(pause.getAttribute('aria-describedby'))).toBe(
      'Runs in flight finish. No new runs start until you resume it.',
    );
  });

  test('COR-2431: a disabled item’s reason takes its description’s place', async () => {
    const { items } = await openMenu();
    const stop = items[5]!;
    expect(stop.querySelectorAll('.cinder-dropdown-item__reason')).toHaveLength(1);
    expect(textOf(stop.getAttribute('aria-describedby'))).toBe('Nothing is running.');
  });

  test('COR-2431 (row 63m): the second line is placed by a grid, never by a measured indent', async () => {
    const { items } = await openMenu();
    for (const item of [items[0]!, items[4]!]) {
      const line = requiredInstance(
        item.querySelector('.cinder-dropdown-item__reason'),
        HTMLElement,
      );
      expect(line.getAttribute('style')).toBeNull();
    }
    const css = readFileSync(new URL('../dropdown/dropdown.css', import.meta.url), 'utf8');
    const rule = (selector: string) =>
      new RegExp(`${selector.replaceAll(/[.[\]()>:'-]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(
        css,
      )?.[1] ?? '';
    // An icon column and a text column; the label's parts take their cells, and the line the text
    // column, so it starts where the label's words do.
    expect(rule('.cinder-dropdown-item[data-cinder-reason]')).toContain('display: grid');
    expect(css).toContain('grid-template-columns: [icon] auto [text] minmax(0, 1fr)');
    expect(rule('.cinder-dropdown-item__label')).toContain('display: contents');
    expect(rule('.cinder-dropdown-item__reason')).toContain('grid-column: text');
    expect(css).not.toContain('reason-indent');
  });

  test("a link item keeps the consumer's own description before the reason", async () => {
    const { items } = await openMenu();
    const open = items[2]!;
    expect(open.tagName.toLowerCase()).toBe('a');
    expect(textOf(open.getAttribute('aria-describedby'))).toBe(
      'Also read this. Nothing to open yet.',
    );
  });
});
