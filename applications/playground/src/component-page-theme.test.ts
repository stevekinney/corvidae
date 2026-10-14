/// <reference lib="dom" />
/**
 * Unit tests for `component-page-theme.ts`'s pure reads and the DOM/storage
 * write `applyTheme` performs.
 *
 * happy-dom is installed globally by `scripts/preload.ts`, so `document`,
 * `window`, `localStorage`, and `sessionStorage` all exist by default here —
 * the SSR/no-storage cases delete the relevant global for the duration of one
 * test, using the same per-test stubbing pattern as `sidebar-scroll.test.ts`.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { runInNewContext } from 'node:vm';

import {
  applyTheme,
  followSystemTheme,
  readInitialPreviewWidth,
  readInitialTheme,
  readStoredNavFilter,
  synchronizeFocusModeQuery,
  synchronizePreviewWidthQuery,
  synchronizeViewQuery,
} from './component-page-theme.ts';
import { PRE_PAINT_THEME_SCRIPT } from './render-shell.ts';
import { THEME_STORAGE_KEY } from './shell-app/theme-storage.ts';

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalSessionStorage = globalThis.sessionStorage;

afterEach(() => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: originalDocument,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
    writable: true,
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: originalSessionStorage,
    writable: true,
  });
  document.documentElement.style.colorScheme = '';
  delete document.documentElement.dataset['cinderTheme'];
  delete document.documentElement.dataset['theme'];
});

describe('readInitialTheme', () => {
  it('returns "light" when document is undefined (SSR)', () => {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: undefined });
    expect(readInitialTheme()).toBe('light');
  });

  it('reads a concrete color-scheme from documentElement.style', () => {
    document.documentElement.style.colorScheme = 'dark';
    expect(readInitialTheme()).toBe('dark');
  });

  it('falls back to dataset.cinderTheme when color-scheme is not a concrete value', () => {
    document.documentElement.style.colorScheme = '';
    document.documentElement.dataset['cinderTheme'] = 'dark';
    expect(readInitialTheme()).toBe('dark');
  });

  it('defaults to "light" when neither signal indicates dark', () => {
    document.documentElement.style.colorScheme = '';
    delete document.documentElement.dataset['cinderTheme'];
    expect(readInitialTheme()).toBe('light');
  });
});

describe('readInitialPreviewWidth', () => {
  it('returns null when window is undefined', () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });
    expect(readInitialPreviewWidth()).toBeNull();
  });

  it('delegates to readPreviewWidthFromSearch otherwise', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { search: '?w=768' } },
    });
    expect(readInitialPreviewWidth()).toBe(768);
  });

  it('returns null for an out-of-range or missing width param', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { search: '' } },
    });
    expect(readInitialPreviewWidth()).toBeNull();
  });
});

describe('readStoredNavFilter', () => {
  it('returns "" when sessionStorage is unavailable', () => {
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: undefined });
    expect(readStoredNavFilter()).toBe('');
  });

  it('returns the stored value when present', () => {
    sessionStorage.setItem('cinder-playground-nav-filter', 'accordion');
    expect(readStoredNavFilter()).toBe('accordion');
    sessionStorage.removeItem('cinder-playground-nav-filter');
  });

  it('returns "" when sessionStorage.getItem throws', () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(readStoredNavFilter()).toBe('');
  });
});

describe('applyTheme', () => {
  it('sets colorScheme, dataset.cinderTheme, and localStorage for "dark"', () => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    applyTheme('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.documentElement.dataset['cinderTheme']).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    localStorage.removeItem(THEME_STORAGE_KEY);
  });

  it('sets colorScheme, dataset.cinderTheme, and localStorage for "light"', () => {
    applyTheme('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(document.documentElement.dataset['cinderTheme']).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    localStorage.removeItem(THEME_STORAGE_KEY);
  });

  it('still updates the DOM and does not throw when localStorage.setItem throws', () => {
    const originalLocalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        setItem: () => {
          throw new Error('quota exceeded');
        },
      },
    });
    try {
      expect(() => applyTheme('dark')).not.toThrow();
      expect(document.documentElement.style.colorScheme).toBe('dark');
      expect(document.documentElement.dataset['cinderTheme']).toBe('dark');
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: originalLocalStorage,
        writable: true,
      });
    }
  });
});

/**
 * Cinder's built token CSS does not switch on `color-scheme`: Bun lowers `light-dark()` to
 * `--buncss-light`/`--buncss-dark` toggles keyed on `prefers-color-scheme` and `:root[data-theme]`.
 * A theme chosen against the operating system therefore has to set `data-theme`, or the
 * playground's own chrome follows the toggle while every Cinder token follows the system.
 */
describe('the data-theme attribute Cinder tokens switch on', () => {
  afterEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
  });

  it('applyTheme pins data-theme to the chosen theme', () => {
    applyTheme('light');
    expect(document.documentElement.dataset['theme']).toBe('light');
    applyTheme('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('the pre-paint script pins data-theme to a stored choice', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    runInNewContext(PRE_PAINT_THEME_SCRIPT, { window, document, localStorage, URLSearchParams });
    expect(document.documentElement.dataset['theme']).toBe('light');
  });

  it('the pre-paint script pins data-theme to a linked choice over a stored one', () => {
    const happyWindow = window as unknown as { happyDOM: { setURL(url: string): void } };
    happyWindow.happyDOM.setURL('http://localhost/page/button?theme=dark');
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    try {
      runInNewContext(PRE_PAINT_THEME_SCRIPT, { window, document, localStorage, URLSearchParams });
      expect(document.documentElement.dataset['theme']).toBe('dark');
    } finally {
      happyWindow.happyDOM.setURL('http://localhost/');
    }
  });

  it('the pre-paint script leaves data-theme unset with no choice, so the system governs', () => {
    document.documentElement.dataset['theme'] = 'dark';
    runInNewContext(PRE_PAINT_THEME_SCRIPT, { window, document, localStorage, URLSearchParams });
    expect(document.documentElement.dataset['theme']).toBeUndefined();
  });
});

describe('applyTheme and the shareable theme query', () => {
  const happyWindow = window as unknown as { happyDOM: { setURL(url: string): void } };

  afterEach(() => {
    happyWindow.happyDOM.setURL('http://localhost/');
    localStorage.removeItem(THEME_STORAGE_KEY);
  });

  it('rewrites an existing theme parameter to the toggled theme and keeps the rest of the URL', () => {
    happyWindow.happyDOM.setURL(
      'http://localhost/page/button?w=768&theme=dark&view=playground#usage',
    );

    applyTheme('light');

    expect(window.location.pathname).toBe('/page/button');
    expect(new URLSearchParams(window.location.search).get('theme')).toBe('light');
    expect(new URLSearchParams(window.location.search).get('w')).toBe('768');
    expect(new URLSearchParams(window.location.search).get('view')).toBe('playground');
    expect(window.location.hash).toBe('#usage');
  });

  it('leaves a URL without a theme parameter exactly as it was', () => {
    happyWindow.happyDOM.setURL('http://localhost/page/button?w=768#usage');

    applyTheme('dark');

    expect(window.location.href).toBe('http://localhost/page/button?w=768#usage');
  });

  it('keeps the toggled theme across a reload of a URL that carried the other one', () => {
    happyWindow.happyDOM.setURL('http://localhost/page/button?theme=dark');
    applyTheme('light');
    document.documentElement.style.colorScheme = '';
    delete document.documentElement.dataset['cinderTheme'];

    // A reload runs the pre-paint script against whatever URL and storage the toggle left.
    runInNewContext(PRE_PAINT_THEME_SCRIPT, { window, document, localStorage, URLSearchParams });

    expect(document.documentElement.dataset['cinderTheme']).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('still applies the theme when the document refuses to rewrite its URL', () => {
    happyWindow.happyDOM.setURL('http://localhost/page/button?theme=dark');
    const originalReplaceState = window.history.replaceState.bind(window.history);
    window.history.replaceState = () => {
      throw new DOMException('sandboxed frame', 'SecurityError');
    };
    try {
      expect(() => applyTheme('light')).not.toThrow();
      expect(document.documentElement.dataset['cinderTheme']).toBe('light');
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    } finally {
      window.history.replaceState = originalReplaceState;
    }
  });
});

describe('the stage controls and the shareable URL', () => {
  const happyWindow = window as unknown as { happyDOM: { setURL(url: string): void } };

  afterEach(() => {
    happyWindow.happyDOM.setURL('http://localhost/');
  });

  it('replaces a width the reader arrived with by the one they chose, keeping the rest of the URL', () => {
    happyWindow.happyDOM.setURL(
      'http://localhost/page/button?w=768&theme=dark&view=playground#usage',
    );

    synchronizePreviewWidthQuery(375);

    expect(window.location.pathname).toBe('/page/button');
    const search = new URLSearchParams(window.location.search);
    expect(search.get('w')).toBe('375');
    expect(search.get('theme')).toBe('dark');
    expect(search.get('view')).toBe('playground');
    expect(window.location.hash).toBe('#usage');
  });

  it('drops the width when the reader chooses the full width, so a reload does not restore the old one', () => {
    happyWindow.happyDOM.setURL('http://localhost/page/button?w=768');

    synchronizePreviewWidthQuery(null);

    expect(window.location.href).toBe('http://localhost/page/button');
    expect(readInitialPreviewWidth()).toBeNull();
  });

  it('records a width chosen on a URL that carried none, so the link restores the selection', () => {
    happyWindow.happyDOM.setURL('http://localhost/page/button');

    synchronizePreviewWidthQuery(1280);

    expect(window.location.search).toBe('?w=1280');
    expect(readInitialPreviewWidth()).toBe(1280);
  });

  it('records focus mode turning on and drops it when it turns off', () => {
    happyWindow.happyDOM.setURL('http://localhost/page/button?w=768');

    synchronizeFocusModeQuery(true);
    expect(new URLSearchParams(window.location.search).get('focus')).toBe('1');
    expect(new URLSearchParams(window.location.search).get('w')).toBe('768');

    synchronizeFocusModeQuery(false);
    expect(window.location.search).toBe('?w=768');
  });

  it('still lets the controls work when the document refuses to rewrite its URL', () => {
    happyWindow.happyDOM.setURL('http://localhost/page/button?w=768&focus=1');
    const originalReplaceState = window.history.replaceState.bind(window.history);
    window.history.replaceState = () => {
      throw new DOMException('sandboxed frame', 'SecurityError');
    };
    try {
      expect(() => synchronizePreviewWidthQuery(375)).not.toThrow();
      expect(() => synchronizeFocusModeQuery(false)).not.toThrow();
    } finally {
      window.history.replaceState = originalReplaceState;
    }
  });
});

describe('the view switch and the shareable URL', () => {
  const happyWindow = window as unknown as { happyDOM: { setURL(url: string): void } };

  afterEach(() => {
    happyWindow.happyDOM.setURL('http://localhost/');
  });

  it("keeps the reader's anchor and the rest of the URL when switching to the playground and back", () => {
    happyWindow.happyDOM.setURL('http://localhost/page/button?w=768#props');

    synchronizeViewQuery('playground');
    expect(window.location.pathname).toBe('/page/button');
    expect(new URLSearchParams(window.location.search).get('view')).toBe('playground');
    expect(new URLSearchParams(window.location.search).get('w')).toBe('768');
    expect(window.location.hash).toBe('#props');

    synchronizeViewQuery('documentation');
    expect(window.location.search).toBe('?w=768');
    expect(window.location.hash).toBe('#props');
  });

  it('keeps the history state the page already carried', () => {
    happyWindow.happyDOM.setURL('http://localhost/page/button');
    window.history.replaceState({ scrollTop: 120 }, '', window.location.href);

    synchronizeViewQuery('playground');

    expect(window.history.state).toEqual({ scrollTop: 120 });
  });

  it('still lets the view switch when the document refuses to rewrite its URL', () => {
    happyWindow.happyDOM.setURL('http://localhost/page/button');
    const originalReplaceState = window.history.replaceState.bind(window.history);
    window.history.replaceState = () => {
      throw new DOMException('sandboxed frame', 'SecurityError');
    };
    try {
      expect(() => synchronizeViewQuery('playground')).not.toThrow();
    } finally {
      window.history.replaceState = originalReplaceState;
    }
  });
});

describe('followSystemTheme', () => {
  type ChangeListener = (event: { matches: boolean }) => void;

  /** A `matchMedia` the test drives: it records the listeners and lets the OS theme flip. */
  function installFakeMatchMedia(initiallyDark = false) {
    const listeners = new Set<ChangeListener>();
    const original = window.matchMedia;
    let dark = initiallyDark;
    window.matchMedia = ((query: string) => ({
      get matches() {
        return query.includes('dark') && dark;
      },
      media: query,
      addEventListener: (_type: string, listener: ChangeListener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: ChangeListener) => listeners.delete(listener),
    })) as unknown as typeof window.matchMedia;
    return {
      listeners,
      flipTo(theme: 'light' | 'dark') {
        dark = theme === 'dark';
        for (const listener of listeners) listener({ matches: dark });
      },
      restore() {
        window.matchMedia = original;
      },
    };
  }

  afterEach(() => {
    delete document.documentElement.dataset['cinderTheme'];
    document.documentElement.style.colorScheme = '';
  });

  it('adopts a theme the operating system switches to while the reader has chosen none', () => {
    const media = installFakeMatchMedia();
    try {
      document.documentElement.dataset['cinderTheme'] = 'light';
      const seen: string[] = [];
      followSystemTheme((theme) => seen.push(theme));

      media.flipTo('dark');
      expect(seen).toEqual(['dark']);
      expect(document.documentElement.dataset['cinderTheme']).toBe('dark');

      media.flipTo('light');
      expect(seen).toEqual(['dark', 'light']);
      expect(document.documentElement.dataset['cinderTheme']).toBe('light');
    } finally {
      media.restore();
    }
  });

  it('ignores the operating system once the reader has chosen a theme', () => {
    const media = installFakeMatchMedia();
    try {
      document.documentElement.style.colorScheme = 'light';
      document.documentElement.dataset['cinderTheme'] = 'light';
      const seen: string[] = [];
      followSystemTheme((theme) => seen.push(theme));

      media.flipTo('dark');

      expect(seen).toEqual([]);
      expect(document.documentElement.dataset['cinderTheme']).toBe('light');
    } finally {
      media.restore();
    }
  });

  it('stops following when asked to', () => {
    const media = installFakeMatchMedia();
    try {
      const seen: string[] = [];
      const stop = followSystemTheme((theme) => seen.push(theme));
      expect(media.listeners.size).toBe(1);

      stop();
      media.flipTo('dark');

      expect(media.listeners.size).toBe(0);
      expect(seen).toEqual([]);
    } finally {
      media.restore();
    }
  });

  it('does nothing where the browser has no matchMedia', () => {
    const original = window.matchMedia;
    Reflect.deleteProperty(window, 'matchMedia');
    try {
      const stop = followSystemTheme(() => {});
      expect(() => stop()).not.toThrow();
    } finally {
      window.matchMedia = original;
    }
  });
});
