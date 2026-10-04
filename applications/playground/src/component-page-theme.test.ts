/// <reference lib="dom" />
/**
 * Unit tests for `component-page-theme.ts`'s pure reads and the DOM/storage
 * write `applyTheme` performs.
 *
 * happy-dom is installed globally by `scripts/preload.ts`, so `document`,
 * `window`, `localStorage`, and `sessionStorage` all exist by default here —
 * the SSR/no-storage cases delete the relevant global for the duration of one
 * test, mirroring `preview-store.test.ts`'s stubbing pattern.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { runInNewContext } from 'node:vm';

import {
  applyTheme,
  readInitialPreviewWidth,
  readInitialTheme,
  readStoredNavFilter,
  synchronizeFocusModeQuery,
  synchronizePreviewWidthQuery,
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
