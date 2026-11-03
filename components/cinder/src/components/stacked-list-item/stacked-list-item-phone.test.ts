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
});
