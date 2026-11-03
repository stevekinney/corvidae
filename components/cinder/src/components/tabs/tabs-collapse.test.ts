/// <reference lib="dom" />
/**
 * COR-2011 (B03, row 39z): below 640px a horizontal tab bar collapses to one full-width select
 * reading "Tab: <name>". The tabs stay mounted, hidden, so they still register and name panels.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

// A controllable `matchMedia`, installed before the first query is read.
type Listener = (event: Event) => void;
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

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { flushSync } = await import('svelte');
const { default: CountFixture } = await import('../../test/fixtures/tabs-count-fixture.svelte');
const { default: TabsHarness } = await import('./tabs-collapse-harness.test.svelte');

const tabsCss = readFileSync(new URL('./tabs.css', import.meta.url), 'utf8');

function setPhone(next: boolean) {
  phone = next;
  for (const listener of listeners) listener(new Event('change'));
  flushSync();
}

afterEach(() => {
  cleanup();
  setPhone(false);
  document.body.replaceChildren();
});

function trigger(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('.cinder-select[data-cinder-presentation]');
  if (!element) throw new Error('no select');
  return element;
}

describe('Tabs narrow collapse', () => {
  test('shows the tab bar on a wide viewport and no select', () => {
    const { container } = render(TabsHarness);

    expect(container.querySelector('.cinder-select')).toBeNull();
    expect(container.querySelector('[role="tablist"]')?.hasAttribute('hidden')).toBe(false);
    expect(container.querySelector('.cinder-tabs')?.hasAttribute('data-cinder-collapsed')).toBe(
      false,
    );
  });

  test('below the breakpoint the bar becomes one "Tab: <name>" select', async () => {
    setPhone(true);
    const { container } = render(TabsHarness, { props: { active: 'access' } });
    flushSync();

    const select = trigger(container);
    expect(select.getAttribute('aria-label') ?? select.textContent).toContain('Access');
    expect(container.querySelector('.cinder-select__prefix')?.textContent?.trim()).toBe('Tab:');
    expect(container.querySelector('.cinder-select__value')?.textContent?.trim()).toBe('Access');
    expect(container.querySelector('.cinder-tabs')?.hasAttribute('data-cinder-collapsed')).toBe(
      true,
    );
  });

  test('keeps the tabs mounted but hidden, so panels still name themselves', () => {
    setPhone(true);
    const { container } = render(TabsHarness, { props: { active: 'access' } });
    flushSync();

    const list = container.querySelector('[role="tablist"]');
    expect(list?.hasAttribute('hidden')).toBe(true);
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(4);
    const panel = container.querySelector('[role="tabpanel"]');
    const labelledBy = panel?.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(container.ownerDocument.getElementById(labelledBy ?? '')?.textContent?.trim()).toBe(
      'Access',
    );
  });

  test('lists every tab as an option and picking one selects its tab', async () => {
    setPhone(true);
    const changes: string[] = [];
    const { container } = render(TabsHarness, {
      props: { active: 'access', onChange: (next: string) => changes.push(next) },
    });
    flushSync();

    await fireEvent.click(trigger(container));
    flushSync();
    const options = [...document.querySelectorAll('[role="option"]')].map((option) =>
      option.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(options.map((option) => option?.split(' ')[0])).toEqual([
      'Overview',
      'Access',
      'Memory',
      'Settings',
    ]);

    const settings = [...document.querySelectorAll('[role="option"]')].find((option) =>
      option.textContent?.includes('Settings'),
    );
    if (!settings) throw new Error('no option');
    await fireEvent.click(settings);
    flushSync();

    expect(changes).toEqual(['settings']);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
      'Settings',
    );
  });

  test('a disabled tab is a disabled option', async () => {
    setPhone(true);
    const { container } = render(TabsHarness, { props: { active: 'access' } });
    flushSync();

    await fireEvent.click(trigger(container));
    flushSync();
    const memory = [...document.querySelectorAll('[role="option"]')].find((option) =>
      option.textContent?.includes('Memory'),
    );
    expect(memory?.getAttribute('aria-disabled')).toBe('true');
  });

  test('a count reads as the option note, and never leaks into the label', async () => {
    setPhone(true);
    const { container } = render(CountFixture, {});
    flushSync();

    expect(container.querySelector('.cinder-select__value')?.textContent?.trim()).toBe('Overview');
    await fireEvent.click(trigger(container));
    flushSync();
    const workers = [...document.querySelectorAll('[role="option"]')].find((option) =>
      option.textContent?.includes('Workers'),
    );
    expect(workers?.textContent).toContain('1 needs attention');
    expect(workers?.textContent?.replace('1 needs attention', '').trim()).toBe('Workers');
  });

  test('an explicit label wins over the tab text', () => {
    setPhone(true);
    const { container } = render(TabsHarness, { props: { active: 'overview', labelled: true } });
    flushSync();

    expect(container.querySelector('.cinder-select__value')?.textContent?.trim()).toBe(
      'Project overview',
    );
  });

  test('collapseLabel names the select and prefixes its value', () => {
    setPhone(true);
    const { container } = render(TabsHarness, {
      props: { active: 'access', collapseLabel: 'Section' },
    });
    flushSync();

    expect(container.querySelector('.cinder-select__prefix')?.textContent?.trim()).toBe('Section:');
  });

  test('collapseBelow={false} always shows the tab bar', () => {
    setPhone(true);
    const { container } = render(TabsHarness, { props: { collapseBelow: false } });
    flushSync();

    expect(container.querySelector('.cinder-select')).toBeNull();
    expect(container.querySelector('[role="tablist"]')?.hasAttribute('hidden')).toBe(false);
  });

  test('vertical tabs never collapse', () => {
    setPhone(true);
    const { container } = render(TabsHarness, { props: { orientation: 'vertical' } });
    flushSync();

    expect(container.querySelector('.cinder-select')).toBeNull();
  });

  test('follows the viewport as it crosses the breakpoint', () => {
    const { container } = render(TabsHarness, { props: { active: 'access' } });
    expect(container.querySelector('.cinder-select')).toBeNull();

    setPhone(true);
    expect(container.querySelector('.cinder-select')).not.toBeNull();

    setPhone(false);
    expect(container.querySelector('.cinder-select')).toBeNull();
    expect(container.querySelector('[role="tablist"]')?.hasAttribute('hidden')).toBe(false);
  });

  test('rejects a breakpoint that is not a CSS length', () => {
    expect(() => render(TabsHarness, { props: { collapseBelow: 'phone' } })).toThrow(
      /collapseBelow/,
    );
  });

  test('the stylesheet keeps the select full width above the panels', () => {
    expect(tabsCss).toMatch(/\.cinder-tabs__collapse\s*\{[^}]*inline-size:\s*100%/);
    expect(tabsCss).toMatch(
      /\.cinder-tabs__collapse \.cinder-select\s*\{[^}]*min-block-size:\s*var\(--cinder-touch-target-min\)/,
    );
  });
});
