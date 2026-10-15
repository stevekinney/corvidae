import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  watchDevicePixelRatio,
  watchElementSize,
  watchFontLoading,
  watchMediaQuery,
  watchThemeAttribute,
  watchWindowResize,
} from './terminal-observers.ts';

class FakeMediaQueryList extends EventTarget {
  matches: boolean;
  constructor(
    readonly media: string,
    matches: boolean,
  ) {
    super();
    this.matches = matches;
  }
  change(matches: boolean): void {
    this.matches = matches;
    this.dispatchEvent(new Event('change'));
  }
}

const originalMatchMedia = globalThis.matchMedia;
const originalPixelRatio = globalThis.devicePixelRatio;
const lists: FakeMediaQueryList[] = [];

beforeEach(() => {
  lists.length = 0;
  globalThis.matchMedia = ((query: string) => {
    const list = new FakeMediaQueryList(query, false);
    lists.push(list);
    return list;
  }) as unknown as typeof matchMedia;
});

afterEach(() => {
  globalThis.matchMedia = originalMatchMedia;
  globalThis.devicePixelRatio = originalPixelRatio;
});

describe('watchMediaQuery', () => {
  test('reports the current match and every change, until disposed', () => {
    let changes = 0;
    const watch = watchMediaQuery('(prefers-reduced-motion: reduce)', () => {
      changes += 1;
    });
    expect(watch.matches()).toBe(false);
    lists[0]!.change(true);
    expect(watch.matches()).toBe(true);
    expect(changes).toBe(1);
    watch.dispose();
    lists[0]!.change(false);
    expect(changes).toBe(1);
  });

  test('is inert where the runtime has no media queries', () => {
    // @ts-expect-error -- simulate a runtime without matchMedia
    globalThis.matchMedia = undefined;
    const watch = watchMediaQuery('(prefers-reduced-motion: reduce)', () => {
      throw new Error('must not be called');
    });
    expect(watch.matches()).toBe(false);
    watch.dispose();
  });
});

describe('watchDevicePixelRatio', () => {
  test('re-arms the resolution query for the new ratio after each change', () => {
    globalThis.devicePixelRatio = 1;
    let changes = 0;
    const stop = watchDevicePixelRatio(() => {
      changes += 1;
    });
    expect(lists.map((list) => list.media)).toEqual(['(resolution: 1dppx)']);
    globalThis.devicePixelRatio = 2;
    lists[0]!.change(false);
    expect(changes).toBe(1);
    expect(lists.map((list) => list.media)).toEqual(['(resolution: 1dppx)', '(resolution: 2dppx)']);
    globalThis.devicePixelRatio = 1.5;
    lists[1]!.change(false);
    expect(changes).toBe(2);
    expect(lists).toHaveLength(3);
    stop();
  });

  test('stops reporting once disposed, even for an in-flight change', () => {
    let changes = 0;
    const stop = watchDevicePixelRatio(() => {
      changes += 1;
    });
    stop();
    lists[0]!.change(false);
    expect(changes).toBe(0);
    expect(lists).toHaveLength(1);
  });

  test('assumes a ratio of one where the runtime does not report one', () => {
    // @ts-expect-error -- simulate a runtime without a pixel ratio
    globalThis.devicePixelRatio = undefined;
    const stop = watchDevicePixelRatio(() => {});
    expect(lists[0]!.media).toBe('(resolution: 1dppx)');
    stop();
  });
});

describe('watchElementSize', () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
  });

  test('observes the element and disconnects on dispose', () => {
    const events: string[] = [];
    let notify: () => void = () => {};
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        notify = () => callback([], this);
      }
      observe(): void {
        events.push('observe');
      }
      unobserve(): void {}
      disconnect(): void {
        events.push('disconnect');
      }
    };
    let changes = 0;
    const stop = watchElementSize(document.createElement('div'), () => {
      changes += 1;
    });
    notify();
    expect(changes).toBe(1);
    stop();
    expect(events).toEqual(['observe', 'disconnect']);
  });

  test('is inert without ResizeObserver', () => {
    // @ts-expect-error -- simulate a runtime without ResizeObserver
    globalThis.ResizeObserver = undefined;
    watchElementSize(document.createElement('div'), () => {})();
  });
});

describe('watchFontLoading', () => {
  test('reports loading done and the initial ready promise, and stops on dispose', async () => {
    const fonts = Object.assign(new EventTarget(), { ready: Promise.resolve() });
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
    try {
      let changes = 0;
      const stop = watchFontLoading(() => {
        changes += 1;
      });
      await fonts.ready;
      await Promise.resolve();
      expect(changes).toBe(1);
      fonts.dispatchEvent(new Event('loadingdone'));
      expect(changes).toBe(2);
      stop();
      fonts.dispatchEvent(new Event('loadingdone'));
      expect(changes).toBe(2);
    } finally {
      Reflect.deleteProperty(document, 'fonts');
    }
  });

  test('a ready promise that settles after dispose reports nothing', async () => {
    let settle: () => void = () => {};
    const fonts = Object.assign(new EventTarget(), {
      ready: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    });
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
    try {
      let changes = 0;
      const stop = watchFontLoading(() => {
        changes += 1;
      });
      stop();
      settle();
      await fonts.ready;
      await Promise.resolve();
      expect(changes).toBe(0);
    } finally {
      Reflect.deleteProperty(document, 'fonts');
    }
  });

  test('is inert where the runtime has no font set', () => {
    watchFontLoading(() => {
      throw new Error('must not be called');
    })();
  });
});

describe('watchWindowResize', () => {
  test('is inert where the runtime has no window', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { value: undefined, configurable: true });
    try {
      watchWindowResize(() => {
        throw new Error('must not be called');
      })();
    } finally {
      if (original) Object.defineProperty(globalThis, 'window', original);
    }
  });

  test('reports window resizes until disposed', () => {
    let changes = 0;
    const stop = watchWindowResize(() => {
      changes += 1;
    });
    window.dispatchEvent(new Event('resize'));
    expect(changes).toBe(1);
    stop();
    window.dispatchEvent(new Event('resize'));
    expect(changes).toBe(1);
  });
});

describe('watchThemeAttribute', () => {
  test('reports a data-theme change anywhere in the document, until disposed', async () => {
    const section = document.createElement('section');
    document.body.append(section);
    let changes = 0;
    const stop = watchThemeAttribute(() => {
      changes += 1;
    });
    section.setAttribute('data-theme', 'dark');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changes).toBeGreaterThan(0);
    const seen = changes;
    stop();
    section.setAttribute('data-theme', 'light');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changes).toBe(seen);
    section.remove();
  });

  test('ignores unrelated attributes', async () => {
    let changes = 0;
    const stop = watchThemeAttribute(() => {
      changes += 1;
    });
    document.body.setAttribute('data-other', 'x');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changes).toBe(0);
    stop();
    document.body.removeAttribute('data-other');
  });

  test('is inert without MutationObserver', () => {
    const original = globalThis.MutationObserver;
    // @ts-expect-error -- simulate a runtime without MutationObserver
    globalThis.MutationObserver = undefined;
    try {
      watchThemeAttribute(() => {})();
    } finally {
      globalThis.MutationObserver = original;
    }
  });
});
