/// <reference lib="dom" />
/**
 * The docked edge the toast region sits above (COR-2327): the distance from the viewport's bottom,
 * above the keyboard, to the top of the highest bar docked there. Bars that stack (a tab bar with a
 * docked action bar or a chat's composer on it) reach the top of the higher one, and a bar that is
 * not docked to the bottom, or not drawn, does not count.
 */
import { setupHappyDom } from '@lostgradient/testing';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

setupHappyDom();
const { DOCKED_BAR_HEIGHT_PROPERTY, trackDockedBar } = await import('./docked-bar-height.ts');

type Box = { top: number; bottom: number };

const boxes = new Map<Element, Box>();
const originalRect = HTMLElement.prototype.getBoundingClientRect;
const stops: Array<() => void> = [];

beforeAll(() => {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const box = boxes.get(this) ?? { top: 0, bottom: 0 };
    return { ...box, height: box.bottom - box.top } as DOMRect;
  };
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  boxes.clear();
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: null });
  document.documentElement.style.removeProperty(DOCKED_BAR_HEIGHT_PROPERTY);
});

afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = originalRect;
});

/** Tracks a bar whose box runs from `top` to `bottom`, measured from the top of the viewport. */
function bar(top: number, bottom: number): HTMLElement {
  const element = document.createElement('div');
  boxes.set(element, { top, bottom });
  stops.push(trackDockedBar(element));
  return element;
}

function published(): string {
  return document.documentElement.style.getPropertyValue(DOCKED_BAR_HEIGHT_PROPERTY);
}

describe('trackDockedBar', () => {
  test('a bar at the bottom of the viewport publishes its height', () => {
    const viewport = window.innerHeight;
    bar(viewport - 64.4, viewport);
    expect(published()).toBe('65px');
  });

  test('a bar stacked on a tab bar publishes the distance to its own top, not the taller height', () => {
    const viewport = window.innerHeight;
    // A 56px tab bar at the very bottom with a 72px docked bar on it: 128px, not 72px.
    bar(viewport - 56, viewport);
    bar(viewport - 128, viewport - 56);
    expect(published()).toBe('128px');
  });

  test('the stack is found in any order the bars are tracked', () => {
    const viewport = window.innerHeight;
    bar(viewport - 200, viewport - 120);
    bar(viewport - 120, viewport - 56);
    bar(viewport - 56, viewport);
    expect(published()).toBe('200px');
  });

  test('a bar further up the page (a sticky bar on a short page) lifts the toasts by its height only', () => {
    const viewport = window.innerHeight;
    bar(300, 372);
    expect(published()).toBe('72px');
    // It is not docked, so it never stacks on the tab bar: the taller of the two heights wins.
    bar(viewport - 56, viewport);
    expect(published()).toBe('72px');
  });

  test('a bar pushed down to the bottom by content is measured again when the page grows', () => {
    const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
    const observers: Array<{ targets: Element[]; callback: () => void }> = [];
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: class {
        readonly record: { targets: Element[]; callback: () => void };
        constructor(callback: () => void) {
          this.record = { targets: [], callback };
          observers.push(this.record);
        }
        observe(target: Element) {
          this.record.targets.push(target);
        }
        disconnect() {
          this.record.targets.length = 0;
        }
      },
    });
    try {
      const viewport = window.innerHeight;
      bar(viewport - 56, viewport);
      const sticky = bar(300, 372);
      expect(published()).toBe('72px');
      // Content arrives above the sticky bar: the page grows and the bar now sits on the tab bar,
      // with no change to its own size.
      boxes.set(sticky, { top: viewport - 128, bottom: viewport - 56 });
      const page = observers.find((record) => record.targets.includes(document.documentElement));
      expect(page).toBeDefined();
      page?.callback();
      expect(published()).toBe('128px');
    } finally {
      for (const stop of stops.splice(0)) stop();
      if (originalResizeObserver) {
        Object.defineProperty(globalThis, 'ResizeObserver', originalResizeObserver);
      } else {
        Reflect.deleteProperty(globalThis, 'ResizeObserver');
      }
    }
  });

  test('a bar that is not drawn does not count', () => {
    bar(0, 0);
    expect(published()).toBe('');
  });

  test('a bar under the keyboard is measured from the keyboard, which the toast adds itself', () => {
    const viewport = window.innerHeight;
    const visualViewport = new EventTarget() as EventTarget & {
      height: number;
      offsetTop: number;
      scale: number;
    };
    Object.assign(visualViewport, { height: viewport, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visualViewport });
    // A composer that rides above the keyboard.
    const composer = bar(viewport - 120, viewport);
    expect(published()).toBe('120px');

    visualViewport.height = viewport - 300;
    boxes.set(composer, { top: viewport - 420, bottom: viewport - 300 });
    visualViewport.dispatchEvent(new Event('resize'));
    expect(published()).toBe('120px');
  });

  test('measures again when the viewport changes, and takes the property back after the last bar', () => {
    const viewport = window.innerHeight;
    const first = bar(viewport - 64, viewport);
    expect(published()).toBe('64px');
    boxes.set(first, { top: viewport - 90, bottom: viewport });
    window.dispatchEvent(new Event('resize'));
    expect(published()).toBe('90px');
    for (const stop of stops.splice(0)) stop();
    expect(published()).toBe('');
  });
});
