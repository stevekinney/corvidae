/// <reference lib="dom" />
/**
 * `dockedToBottom()` (COR-2327): a surface that is not one of Cinder's bars, such as a chat's
 * composer, counts towards the toast region's offset while it is docked to the bottom, stacked on
 * a tab bar or not, and stops counting when it is removed.
 */
import { setupHappyDom } from '@lostgradient/testing';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

setupHappyDom();
const { dockedToBottom } = await import('./attachments.ts');
const { DOCKED_BAR_HEIGHT_PROPERTY, trackDockedBar } =
  await import('../_internal/docked-bar-height.ts');

const boxes = new Map<Element, { top: number; bottom: number }>();
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
  document.documentElement.style.removeProperty(DOCKED_BAR_HEIGHT_PROPERTY);
});

afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = originalRect;
});

function published(): string {
  return document.documentElement.style.getPropertyValue(DOCKED_BAR_HEIGHT_PROPERTY);
}

/** Attaches `dockedToBottom()` to a surface whose box runs from `top` to `bottom`. */
function surface(top: number, bottom: number): () => void {
  const element = document.createElement('div');
  boxes.set(element, { top, bottom });
  const stop = dockedToBottom()(element);
  if (typeof stop !== 'function') throw new Error('dockedToBottom() returned no cleanup.');
  stops.push(stop);
  return stop;
}

describe('dockedToBottom', () => {
  test('a composer docked at the bottom lifts the toasts above its top, and stops on cleanup', () => {
    const viewport = window.innerHeight;
    const stop = surface(viewport - 140.5, viewport);
    expect(published()).toBe('141px');
    stop();
    expect(published()).toBe('');
  });

  test('a composer stacked on a tab bar lifts the toasts above the composer', () => {
    const viewport = window.innerHeight;
    const tabBar = document.createElement('div');
    boxes.set(tabBar, { top: viewport - 56, bottom: viewport });
    stops.push(trackDockedBar(tabBar));
    surface(viewport - 196, viewport - 56);
    expect(published()).toBe('196px');
  });

  test('a composer above its page padding still lifts the toasts above its top (COR-2327)', () => {
    const viewport = window.innerHeight;
    // 24px of page padding under a 78px composer area, as on the chat page at 1280.
    surface(viewport - 102, viewport - 24);
    expect(published()).toBe('102px');
  });

  test('a composer above its page padding and a tab bar lifts the toasts above its top', () => {
    const viewport = window.innerHeight;
    const tabBar = document.createElement('div');
    boxes.set(tabBar, { top: viewport - 65, bottom: viewport });
    stops.push(trackDockedBar(tabBar));
    surface(viewport - 187, viewport - 89);
    expect(published()).toBe('187px');
  });

  test('a composer inside a card further up the page lifts the toasts by its height only', () => {
    surface(200, 320);
    expect(published()).toBe('120px');
  });

  test('a composer that is not drawn does not lift the toasts', () => {
    surface(0, 0);
    expect(published()).toBe('');
  });
});
