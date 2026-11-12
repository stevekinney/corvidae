/// <reference lib="dom" />
/**
 * The attachment name is shortened in the middle by script to fit its box. The fit is measured in
 * the font and at the width of the moment, so it must be redone when either changes: a web font
 * that finishes loading widens the same text without resizing the box, and a box that resizes
 * needs a new fit. A name never wraps, so a late change cannot add a second line.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mount, tick, unmount } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { default: ChatAttachmentPreview } = await import('./chat-attachment-preview.svelte');

const fileName = 'quarterly-financial-statement-final-revision.pdf';

type ObserverCallback = (entries: ResizeObserverEntry[]) => void;
const observers: ObserverCallback[] = [];
class FakeResizeObserver {
  readonly #callback: ObserverCallback;
  constructor(callback: ObserverCallback) {
    this.#callback = callback;
  }
  observe(): void {
    observers.push(this.#callback);
  }
  unobserve(): void {}
  disconnect(): void {}
}

const fontListeners = new Set<() => void>();
let resolveFontsReady: () => void = () => {};
let fontsReady: Promise<void>;
let characterWidth = 6;
let boxWidth = 240;

const originalResizeObserver = globalThis.ResizeObserver;
const originalRectangle = HTMLElement.prototype.getBoundingClientRect;
const originalCreateElement = document.createElement.bind(document);
const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');

beforeEach(() => {
  observers.length = 0;
  fontListeners.clear();
  characterWidth = 6;
  boxWidth = 240;
  fontsReady = new Promise<void>((resolve) => {
    resolveFontsReady = resolve;
  });
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    return { width: boxWidth + 0.7, height: 0 } as DOMRect;
  };
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      ready: fontsReady,
      addEventListener: (_type: string, listener: () => void) => fontListeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => fontListeners.delete(listener),
    },
  });
  document.createElement = ((tag: string, ...rest: unknown[]) => {
    if (tag !== 'canvas')
      return (originalCreateElement as (...a: unknown[]) => unknown)(tag, ...rest);
    return {
      getContext: () => ({
        font: '',
        measureText: (value: string) => ({ width: value.length * characterWidth }),
      }),
    };
  }) as typeof document.createElement;
});

afterEach(() => {
  document.body.replaceChildren();
  globalThis.ResizeObserver = originalResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = originalRectangle;
  document.createElement = originalCreateElement;
  if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
  else Reflect.deleteProperty(document, 'fonts');
});

function mountPreview() {
  const target = document.createElement('div');
  document.body.append(target);
  const instance = mount(ChatAttachmentPreview, {
    target,
    props: {
      attachment: {
        id: 'a',
        file: new File([new Uint8Array(10)], fileName, { type: 'application/pdf' }),
        kind: 'document',
        status: 'ready',
        progress: 0,
      } as never,
    },
  });
  const name = () => target.querySelector('.chat-attachment-preview-name')!.textContent ?? '';
  return { instance, name };
}

const widthOf = (value: string) => value.length * characterWidth;

describe('attachment name fit', () => {
  test('is redone when a web font finishes loading and widens the text', async () => {
    const { instance, name } = mountPreview();
    await tick();
    const fallbackFit = name();
    expect(widthOf(fallbackFit)).toBeLessThanOrEqual(boxWidth);

    characterWidth = 9;
    expect(widthOf(fallbackFit)).toBeGreaterThan(boxWidth);
    for (const listener of fontListeners) listener();
    await tick();
    expect(widthOf(name())).toBeLessThanOrEqual(boxWidth);
    expect(name().length).toBeLessThan(fallbackFit.length);
    expect(name()).toEndWith('.pdf');

    characterWidth = 12;
    resolveFontsReady();
    await fontsReady;
    await tick();
    expect(widthOf(name())).toBeLessThanOrEqual(boxWidth);
    unmount(instance);
  });

  test('is redone when the box changes width', async () => {
    const { instance, name } = mountPreview();
    await tick();
    const wide = name();
    boxWidth = 120;
    for (const callback of observers) callback([]);
    await tick();
    expect(widthOf(name())).toBeLessThanOrEqual(120);
    expect(name().length).toBeLessThan(wide.length);
    unmount(instance);
  });

  test('stops listening for fonts once unmounted', async () => {
    const { instance } = mountPreview();
    await tick();
    expect(fontListeners.size).toBe(1);
    unmount(instance);
    expect(fontListeners.size).toBe(0);
  });

  test('a name is one line: the name box never wraps', async () => {
    const preview = await Bun.file(
      new URL('./chat-attachment-preview.svelte', import.meta.url),
    ).text();
    const rule = preview.match(/\.chat-attachment-preview-name\s*\{[^}]*\}/)?.[0];
    expect(rule).toMatch(/white-space: nowrap;/);
    expect(rule).toMatch(/overflow: hidden;/);
  });
});
