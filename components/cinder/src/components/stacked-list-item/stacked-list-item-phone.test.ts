/// <reference lib="dom" />
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

import type { StatusListRow } from '../../test/fixtures/status-list-fixture.svelte';

setupHappyDom();

// A controllable `matchMedia`, installed before the shared phone query is first read, so a test
// can put the viewport in its phone form and back.
type Listener = () => void;
const listeners = new Set<Listener>();
let phone = false;
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string) => ({
    media: query,
    get matches() {
      return phone;
    },
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    addListener: (listener: Listener) => listeners.add(listener),
    removeListener: (listener: Listener) => listeners.delete(listener),
  }),
});

afterAll(() => {
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window, 'matchMedia');
});

const { render, cleanup, fireEvent } = await import('@testing-library/svelte');
const { flushSync } = await import('svelte');
const { default: ExtrasFixture } =
  await import('../../test/fixtures/stacked-list-item-extras-fixture.svelte');
const { default: StatusListFixture } =
  await import('../../test/fixtures/status-list-fixture.svelte');

const stylesheet = readFileSync(new URL('./stacked-list-item.css', import.meta.url), 'utf8');

function setPhone(next: boolean) {
  phone = next;
  for (const listener of listeners) listener();
  flushSync();
}

const rows: StatusListRow[] = [
  {
    id: 'a',
    title: 'Refund order 4471',
    day: 'Today',
    status: 'Waiting on you',
    time: '10:42 AM',
    meta: 'Chat · Tool runner',
  },
];

const actions = [
  { label: 'Memory', href: '/memory' },
  { label: 'New chat', disabled: true, disabledReason: 'Connect a provider to start a chat' },
];

describe('StackedListItem on a phone', () => {
  test('the status moves to line two beside the kind and agent, and the word and dot are unchanged', () => {
    setPhone(true);
    const { container } = render(StatusListFixture, { props: { rows } });
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.hasAttribute('data-cinder-phone')).toBe(true);
    // One status element in both forms: the word is the same, only its place in the grid changes.
    expect(row?.querySelector('.cinder-stacked-list-item__status')?.textContent).toContain(
      'Waiting on you',
    );
    expect(stylesheet).toContain("'leading status line line trailing'");
    expect(stylesheet).toMatch(/\[data-cinder-phone\][^{]*__status::after\s*\{\s*content:\s*'·'/);
    cleanup();
    setPhone(false);
  });

  test('a line-two status gives up its fixed column on a phone and reads word, dot, then the preview', () => {
    setPhone(true);
    const { container } = render(StatusListFixture, { props: { rows, placement: 'line-two' } });
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.classList.contains('cinder-stacked-list-item--status-line-two')).toBe(true);
    expect(row?.hasAttribute('data-cinder-phone')).toBe(true);
    // The phone rules name the line-two placement as well as the leading one: an auto status track
    // in place of the fixed column, no end padding, and the dot separator after the word.
    expect(stylesheet).toMatch(
      /\[data-cinder-phone\]\.cinder-stacked-list-item--status-line-two\s*>\s*\.cinder-stacked-list-item__layout\s*\{\s*--_cinder-status-track:\s*auto;/,
    );
    expect(stylesheet).toMatch(
      /\[data-cinder-phone\]\.cinder-stacked-list-item--status-line-two\s*\.cinder-stacked-list-item__status::after\s*\{\s*content:\s*'·'/,
    );
    cleanup();
    setPhone(false);
  });

  test('a row on a tablet or desktop has no phone attribute', () => {
    setPhone(false);
    const { container } = render(StatusListFixture, { props: { rows } });
    expect(
      container.querySelector('.cinder-stacked-list-item')?.hasAttribute('data-cinder-phone'),
    ).toBe(false);
  });

  test('below 640px the trailing actions collapse into one menu button with the same actions', async () => {
    setPhone(true);
    const { container, getByRole } = render(ExtrasFixture, { props: { mode: 'actions', actions } });
    expect(container.querySelector('.cinder-stacked-list-item__actions')).toBeNull();
    const trigger = getByRole('button', { name: 'More actions' });
    expect(trigger.classList.contains('cinder-stacked-list-item__actions-trigger')).toBe(true);
    expect(stylesheet).toMatch(
      /__actions-trigger\s*\{[^}]*inline-size:\s*var\(--cinder-control-height-md\)/,
    );

    await fireEvent.click(trigger);
    const menuItems = [...document.querySelectorAll('.cinder-dropdown-item')];
    expect(menuItems.map((item) => item.textContent?.trim())).toEqual([
      expect.stringContaining('Memory'),
      expect.stringContaining('New chat'),
    ]);
    const newChat = menuItems[1];
    expect(newChat?.getAttribute('aria-disabled')).toBe('true');
    const reasonId = newChat?.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(reasonId)?.textContent).toContain('Connect a provider');
    cleanup();
    setPhone(false);
  });

  test('phoneActions="buttons" keeps each action a button, stacked full width under the text', () => {
    setPhone(true);
    const { container, getByRole, queryByRole } = render(ExtrasFixture, {
      props: {
        mode: 'actions',
        phoneActions: 'buttons',
        actions: [
          { label: 'Answer', href: '/reviews/one' },
          { label: 'Review', href: '/reviews/two' },
        ],
      },
    });
    expect(queryByRole('button', { name: 'More actions' })).toBeNull();
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.classList.contains('cinder-stacked-list-item--phone-buttons')).toBe(true);
    // Not the collapsed form, so the narrow container query puts the actions under the body.
    expect(row?.classList.contains('cinder-stacked-list-item--collapsed-actions')).toBe(false);
    expect(getByRole('link', { name: 'Answer' }).getAttribute('href')).toBe('/reviews/one');
    expect(getByRole('link', { name: 'Review' }).getAttribute('href')).toBe('/reviews/two');
    expect(stylesheet).toMatch(
      /--phone-buttons \.cinder-stacked-list-item__actions\s*\{[^}]*flex-direction:\s*column/,
    );
    expect(stylesheet).toMatch(
      /--phone-buttons \.cinder-stacked-list-item__actions > \.cinder-button\s*\{[^}]*inline-size:\s*100%/,
    );
    // A two-line row gives the actions a row of their own under both lines.
    expect(stylesheet).toMatch(
      /--phone-buttons\s*>\s*\.cinder-stacked-list-item__layout\s*\{[^}]*'trailing trailing trailing trailing'/,
    );
    cleanup();
    setPhone(false);
  });

  test('phoneActions="buttons" changes nothing on a tablet or desktop', () => {
    setPhone(false);
    const { container } = render(ExtrasFixture, {
      props: {
        mode: 'actions',
        phoneActions: 'buttons',
        actions: [{ label: 'Answer', href: '/a' }],
      },
    });
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.classList.contains('cinder-stacked-list-item--phone-buttons')).toBe(false);
    expect(container.querySelector('.cinder-stacked-list-item__actions')).not.toBeNull();
    cleanup();
  });

  test('an action marked `changes` carries data-changes as a button, a link and a menu item', async () => {
    setPhone(false);
    const wide = render(ExtrasFixture, {
      props: {
        mode: 'actions',
        actions: [
          { label: 'Answer', href: '/a', changes: true },
          { label: 'Plain', href: '/b' },
          { label: 'Press', onclick: () => undefined, changes: true },
        ],
      },
    });
    expect(wide.getByRole('link', { name: 'Answer' }).hasAttribute('data-changes')).toBe(true);
    expect(wide.getByRole('link', { name: 'Plain' }).hasAttribute('data-changes')).toBe(false);
    expect(wide.getByRole('button', { name: 'Press' }).hasAttribute('data-changes')).toBe(true);
    cleanup();

    setPhone(true);
    const narrow = render(ExtrasFixture, {
      props: { mode: 'actions', actions: [{ label: 'Answer', href: '/a', changes: true }] },
    });
    await fireEvent.click(narrow.getByRole('button', { name: 'More actions' }));
    const item = [...document.querySelectorAll('.cinder-dropdown-item')].find((element) =>
      element.textContent?.includes('Answer'),
    );
    expect(item?.hasAttribute('data-changes')).toBe(true);
    cleanup();
    setPhone(false);
  });

  test('a third line wraps under line two, starts at the left edge on a phone and is never cut', () => {
    setPhone(true);
    const { container, getByTestId } = render(ExtrasFixture, { props: { mode: 'detail' } });
    const row = container.querySelector('.cinder-stacked-list-item');
    const line = getByTestId('detail').closest('.cinder-stacked-list-item__detail');
    expect(line).not.toBeNull();
    // It is a sibling of line two inside the row, so it follows line two in reading order.
    expect(
      row?.querySelector('.cinder-stacked-list-item__line-two + .cinder-stacked-list-item__detail'),
    ).toBe(line);
    expect(stylesheet).toMatch(
      /__detail\s*\{[^}]*grid-row:\s*details;[^}]*overflow-wrap:\s*anywhere/,
    );
    expect(stylesheet).toMatch(
      /\[data-cinder-phone\]\s+\.cinder-stacked-list-item__detail\s*\{[^}]*grid-column:\s*2 \/ 5/,
    );
    // Wrapping, not truncating: the third line carries no ellipsis or nowrap rule.
    const rule = /\.cinder-stacked-list-item__detail\s*\{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(rule).not.toContain('nowrap');
    expect(rule).not.toContain('text-overflow');
    cleanup();
    setPhone(false);
  });
});
