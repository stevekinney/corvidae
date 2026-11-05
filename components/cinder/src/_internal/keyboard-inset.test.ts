/// <reference lib="dom" />
import { setupHappyDom } from '@lostgradient/testing';
import { afterEach, describe, expect, test } from 'bun:test';

setupHappyDom();
const { KEYBOARD_INSET_PROPERTY, trackKeyboardInset } = await import('./keyboard-inset.ts');

type FakeVisualViewport = EventTarget & { height: number; offsetTop: number; scale: number };

function installVisualViewport(height: number, offsetTop = 0, scale = 1): FakeVisualViewport {
  const target = new EventTarget() as FakeVisualViewport;
  target.height = height;
  target.offsetTop = offsetTop;
  target.scale = scale;
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: target });
  return target;
}

function readInset(): string {
  return document.documentElement.style.getPropertyValue(KEYBOARD_INSET_PROPERTY);
}

afterEach(() => {
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: null });
  document.documentElement.style.removeProperty(KEYBOARD_INSET_PROPERTY);
});

describe('trackKeyboardInset', () => {
  test('publishes how much of the layout viewport the visual viewport leaves uncovered', () => {
    const visualViewport = installVisualViewport(window.innerHeight);
    const stop = trackKeyboardInset();
    expect(readInset()).toBe('0px');
    visualViewport.height = window.innerHeight - 300;
    visualViewport.dispatchEvent(new Event('resize'));
    expect(readInset()).toBe('300px');
    stop();
  });

  test('subtracts the visual viewport offset, so a scrolled keyboard is not counted twice', () => {
    const visualViewport = installVisualViewport(window.innerHeight - 320, 20);
    const stop = trackKeyboardInset();
    expect(readInset()).toBe('300px');
    visualViewport.offsetTop = 0;
    visualViewport.dispatchEvent(new Event('scroll'));
    expect(readInset()).toBe('320px');
    stop();
  });

  test('treats a pinch zoom as no keyboard', () => {
    installVisualViewport(window.innerHeight / 2, 0, 2);
    const stop = trackKeyboardInset();
    expect(readInset()).toBe('0px');
    stop();
  });

  test('shares one listener and removes the property after the last stop', () => {
    installVisualViewport(window.innerHeight);
    const stopFirst = trackKeyboardInset();
    const stopSecond = trackKeyboardInset();
    stopFirst();
    stopFirst();
    expect(readInset()).toBe('0px');
    stopSecond();
    expect(readInset()).toBe('');
  });

  test('is a harmless 0px where visualViewport is missing', () => {
    const stop = trackKeyboardInset();
    expect(readInset()).toBe('0px');
    stop();
  });

  test('returns a harmless cleanup when window is unavailable', () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });

    try {
      const stop = trackKeyboardInset();
      expect(() => stop()).not.toThrow();
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
});
