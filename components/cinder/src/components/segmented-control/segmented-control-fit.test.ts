/// <reference lib="dom" />
/**
 * COR-2448 AC3: a SegmentedControl whose options do not fit the room it has falls back to a stacked
 * radio list, one option per row, instead of cutting the last option off mid-word. happy-dom lays
 * nothing out, so the geometry is stubbed on the elements the component reads: the container's
 * `scrollWidth` (what the options need), and its own and its parent's `clientWidth` (what it has).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

// `padding` is the inline padding of the control's parent: the parent's `clientWidth` (`room`)
// includes it, while the control can only be as wide as the parent's content box.
const geometry = { room: 375, need: 300, padding: 0 };

const CONTAINER = 'cinder-segmented-control-container';
const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get(this: HTMLElement) {
    if (this.classList.contains(CONTAINER)) {
      return Math.min(geometry.need, geometry.room - 2 * geometry.padding);
    }
    return this.querySelector(`:scope > .${CONTAINER}`) === null ? 0 : geometry.room;
  },
});
Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList.contains(CONTAINER) ? geometry.need : 0;
  },
});

const resizeCallbacks: Array<() => void> = [];
const originalResizeObserver = globalThis.ResizeObserver;
class StubResizeObserver {
  constructor(callback: () => void) {
    resizeCallbacks.push(callback);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;

afterAll(() => {
  if (originalClientWidth) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
  }
  if (originalScrollWidth) {
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth);
  }
  globalThis.ResizeObserver = originalResizeObserver;
});

const { cleanup, render } = await import('@testing-library/svelte');
const { flushSync } = await import('svelte');
const { default: Fixture } = await import('../../test/fixtures/segmented-control-fixture.svelte');

const css = readFileSync(new URL('./segmented-control.css', import.meta.url), 'utf8');

// The workflow builder's "Starts" options.
const startsOptions = [
  { value: 'manual', label: 'Manual' },
  { value: 'schedule', label: 'Schedule' },
  { value: 'signal', label: 'Signal' },
  { value: 'webhook', label: 'Webhook' },
];

function resizeTo(room: number): void {
  geometry.room = room;
  for (const callback of resizeCallbacks) callback();
  flushSync();
}

afterEach(() => {
  cleanup();
  resizeCallbacks.length = 0;
  geometry.room = 375;
  geometry.need = 300;
  geometry.padding = 0;
  document.body.replaceChildren();
});

function renderStarts() {
  return render(Fixture, {
    props: { id: 'starts', value: 'manual', label: 'Starts', options: startsOptions },
  });
}

function stacked(container: HTMLElement): boolean {
  return (
    container
      .querySelector('.cinder-segmented-control-container')
      ?.hasAttribute('data-cinder-stacked') ?? false
  );
}

describe('SegmentedControl falls back when its options do not fit (COR-2448 AC3)', () => {
  test('options that fit at 375px stay one attached row', () => {
    geometry.room = 375;
    geometry.need = 300;
    const { container } = renderStarts();
    flushSync();

    expect(stacked(container)).toBe(false);
    expect(
      container.querySelector('.cinder-segmented-control')?.getAttribute('data-cinder-orientation'),
    ).toBe('horizontal');
  });

  test('options wider than the room stack as a radio list, with every option still there', () => {
    geometry.room = 375;
    geometry.need = 460;
    const { container } = renderStarts();
    flushSync();

    expect(stacked(container)).toBe(true);
    const group = container.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute('data-cinder-orientation')).toBe('vertical');
    expect(group?.getAttribute('aria-orientation')).toBe('vertical');
    expect(
      [...container.querySelectorAll('[role="radio"]')].map((radio) => radio.textContent?.trim()),
    ).toEqual(['Manual', 'Schedule', 'Signal', 'Webhook']);
  });

  test('a toolbar-density control never stacks, since a toolbar is one row and owns its overflow', () => {
    geometry.room = 375;
    geometry.need = 460;
    const { container } = render(Fixture, {
      props: {
        id: 'diff-mode',
        value: 'manual',
        label: 'Diff view mode',
        density: 'toolbar',
        options: startsOptions,
      },
    });
    flushSync();

    expect(stacked(container)).toBe(false);
    expect(
      container.querySelector('[role="radiogroup"]')?.getAttribute('data-cinder-orientation'),
    ).toBe('horizontal');
  });

  test('it is the attached row again once the room fits the options', () => {
    geometry.room = 375;
    geometry.need = 460;
    const { container } = renderStarts();
    flushSync();
    expect(stacked(container)).toBe(true);

    resizeTo(400);
    expect(stacked(container)).toBe(true);

    resizeTo(480);
    expect(stacked(container)).toBe(false);
    expect(
      container.querySelector('[role="radiogroup"]')?.getAttribute('data-cinder-orientation'),
    ).toBe('horizontal');
  });

  test('a parent with inline padding settles: the control stacks once and stays, with no update loop', () => {
    // The parent measures 400 across, 380 of it content, and the options need 390: they overflow
    // the 380 the control can have, yet 390 is under the parent's 400. Judging the room by the
    // parent's padding box un-stacked it, the next pass stacked it again, and the effect never
    // settled (effect_update_depth_exceeded, which the application's boundary caught).
    geometry.room = 400;
    geometry.padding = 10;
    geometry.need = 390;
    const { container } = renderStarts();
    flushSync();
    expect(stacked(container)).toBe(true);

    resizeTo(400);
    expect(stacked(container)).toBe(true);

    resizeTo(420);
    expect(stacked(container)).toBe(false);
  });

  // COR-2448 review D: a stacked control is a radio list, not a text field with suggestions under
  // it. Each row leads with the radio Radio draws; the chosen row has no face of its own.
  test('stacked rows lead with the radio indicator, filled on the chosen row only', () => {
    geometry.room = 375;
    geometry.need = 460;
    const { container } = renderStarts();
    flushSync();

    const rows = [...container.querySelectorAll('[role="radio"]')];
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const control = row.querySelector(':scope > .cinder-radio-row__control');
      expect(control?.getAttribute('aria-hidden')).toBe('true');
      expect(control?.firstElementChild?.classList.contains('cinder-radio')).toBe(true);
      expect(control?.querySelector('.cinder-radio + .cinder-radio-row__indicator')).not.toBeNull();
    }
    expect(
      rows.map((row) => row.querySelector('.cinder-radio')?.hasAttribute('data-cinder-checked')),
    ).toEqual([true, false, false, false]);
    // The row's accessible state is unchanged: the indicator is decoration.
    expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
  });

  test('a row that fits draws no indicator', () => {
    geometry.room = 375;
    geometry.need = 300;
    const { container } = renderStarts();
    flushSync();
    expect(container.querySelector('.cinder-radio-row__control')).toBeNull();
  });

  test('stacked, the chosen row has no face, border or ring, and no separator applies', () => {
    const flat = css.replace(/\s+/g, ' ');
    const row =
      ".cinder-segmented-control-container[data-cinder-stacked] .cinder-segmented-control .cinder-segmented-control-option[role='radio']:not(:focus-visible) {";
    const rowRule = flat.slice(flat.indexOf(row), flat.indexOf('}', flat.indexOf(row)));
    expect(rowRule).toContain('background: transparent;');
    expect(rowRule).toContain('box-shadow: none;');
    expect(rowRule).toContain('border: 0;');
    expect(flat).toContain(
      '.cinder-segmented-control-container[data-cinder-stacked] .cinder-segmented-control .cinder-segmented-control-option:not(:first-child)::before { content: none; }',
    );
    // The stylesheet takes the radio's own styles rather than drawing a third one.
    expect(css).toContain("@import '../radio-group/radio-group.css';");
  });

  test('stacked, the radio sits on the column edge, focused or not', () => {
    const flat = css.replace(/\s+/g, ' ');
    const row =
      ".cinder-segmented-control-container[data-cinder-stacked] .cinder-segmented-control .cinder-segmented-control-option[role='radio'] {";
    const rowRule = flat.slice(flat.indexOf(row), flat.indexOf('}', flat.indexOf(row)));
    expect(flat).toContain(row);
    expect(rowRule).toContain('padding-inline: 0 var(--cinder-space-1);');
  });

  test('the stylesheet gives the stacked list the full width, one option per row', () => {
    expect(css).toMatch(
      /\.cinder-segmented-control-container\[data-cinder-stacked\]\s*\{[^}]*display:\s*flex/,
    );
    expect(css).toMatch(
      /\.cinder-segmented-control-container\[data-cinder-stacked\] \.cinder-segmented-control\s*\{[^}]*inline-size:\s*100%/,
    );
  });
});
