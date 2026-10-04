/**
 * Unit tests for the shell-app routing helpers.
 *
 * These helpers are pure functions extracted from the Svelte SPA shell
 * specifically so they can be unit-tested without a DOM. They are the only
 * pieces of the SPA shell with deterministic input/output contracts; the
 * Svelte components themselves are integration-tested via the manual checks
 * documented in the implementation plan.
 */

import { describe, expect, it } from 'bun:test';

import {
  buildComponentHref,
  parseComponentFromPath,
  readFocusModeFromSearch,
  readPreviewWidthFromSearch,
  readViewFromSearch,
  searchForFocusMode,
  searchForPreviewWidth,
  searchForTheme,
  searchForView,
  TOOLBAR_PARAMS,
} from './routing.ts';

describe('parseComponentFromPath', () => {
  it('returns the component name for a valid /c/:name path', () => {
    expect(parseComponentFromPath('/c/avatar')).toBe('avatar');
  });

  it('accepts kebab-case names with hyphens', () => {
    expect(parseComponentFromPath('/c/markdown-editor')).toBe('markdown-editor');
  });

  it('accepts names with digits', () => {
    expect(parseComponentFromPath('/c/h1-heading')).toBe('h1-heading');
  });

  it('parses the canonical /page/ route', () => {
    expect(parseComponentFromPath('/page/avatar')).toBe('avatar');
    expect(parseComponentFromPath('/page/markdown-editor')).toBe('markdown-editor');
  });

  it('returns null for paths that are not a component route', () => {
    expect(parseComponentFromPath('/styles.css')).toBeNull();
    expect(parseComponentFromPath('/')).toBeNull();
    expect(parseComponentFromPath('/page/avatar/extra')).toBeNull();
  });

  it('returns null for an empty segment', () => {
    expect(parseComponentFromPath('/c/')).toBeNull();
  });

  it('returns null for an encoded path with whitespace', () => {
    expect(parseComponentFromPath('/c/foo%20bar')).toBeNull();
  });

  it('returns null for path-traversal attempts', () => {
    expect(parseComponentFromPath('/c/..')).toBeNull();
    expect(parseComponentFromPath('/c/../etc/passwd')).toBeNull();
  });

  it('returns null for uppercase names (kebab invariant)', () => {
    expect(parseComponentFromPath('/c/Avatar')).toBeNull();
  });

  it('returns null for names starting with a hyphen', () => {
    expect(parseComponentFromPath('/c/-bad')).toBeNull();
  });

  it('ignores trailing path segments after the component', () => {
    expect(parseComponentFromPath('/c/avatar/extra')).toBeNull();
  });

  it('handles a malformed percent-encoding by returning null', () => {
    expect(parseComponentFromPath('/c/%E0%A4%A')).toBeNull();
  });
});

describe('buildComponentHref', () => {
  // There is exactly ONE documentation page per component, at /page/<name>.
  // The former /c/<name> shell page was a second rendering of the same content
  // and now 301s here.
  it('builds the canonical documentation path', () => {
    expect(buildComponentHref('avatar')).toBe('/page/avatar');
    expect(buildComponentHref('markdown-editor')).toBe('/page/markdown-editor');
  });

  it('encodes the component name defensively', () => {
    expect(buildComponentHref('weird name')).toBe('/page/weird%20name');
  });
});

describe('readFocusModeFromSearch', () => {
  it('returns false when the focus param is absent', () => {
    expect(readFocusModeFromSearch(new URLSearchParams(''))).toBe(false);
  });

  it('returns true for the canonical "1" value', () => {
    expect(readFocusModeFromSearch(new URLSearchParams('focus=1'))).toBe(true);
  });

  it('accepts a handful of truthy spellings', () => {
    expect(readFocusModeFromSearch(new URLSearchParams('focus=true'))).toBe(true);
    expect(readFocusModeFromSearch(new URLSearchParams('focus=TRUE'))).toBe(true);
    expect(readFocusModeFromSearch(new URLSearchParams('focus=yes'))).toBe(true);
    expect(readFocusModeFromSearch(new URLSearchParams('focus=on'))).toBe(true);
  });

  it('returns false for arbitrary values that are not in the truthy set', () => {
    expect(readFocusModeFromSearch(new URLSearchParams('focus=0'))).toBe(false);
    expect(readFocusModeFromSearch(new URLSearchParams('focus=false'))).toBe(false);
    expect(readFocusModeFromSearch(new URLSearchParams('focus=banana'))).toBe(false);
  });
});

describe('readPreviewWidthFromSearch', () => {
  it('returns null when the width param is absent', () => {
    expect(readPreviewWidthFromSearch(new URLSearchParams(''))).toBeNull();
  });

  it('returns a numeric width within range', () => {
    expect(readPreviewWidthFromSearch(new URLSearchParams('w=375'))).toBe(375);
    expect(readPreviewWidthFromSearch(new URLSearchParams('w=1280'))).toBe(1280);
  });

  it('returns null for out-of-range values', () => {
    expect(readPreviewWidthFromSearch(new URLSearchParams('w=10'))).toBeNull();
    expect(readPreviewWidthFromSearch(new URLSearchParams('w=99999'))).toBeNull();
  });

  it('returns null for non-numeric values', () => {
    expect(readPreviewWidthFromSearch(new URLSearchParams('w=banana'))).toBeNull();
  });
});

describe('component page view', () => {
  it('defaults to documentation, including for an unrecognised value', () => {
    expect(readViewFromSearch(new URLSearchParams(''))).toBe('documentation');
    expect(readViewFromSearch(new URLSearchParams('view=nonsense'))).toBe('documentation');
  });

  it('reads the playground view', () => {
    expect(readViewFromSearch(new URLSearchParams('view=playground'))).toBe('playground');
  });

  it('preserves other toolbar parameters when switching view', () => {
    const search = new URLSearchParams(`${TOOLBAR_PARAMS.width}=768&focus=1`);
    const playground = searchForView(search, 'playground');
    expect(playground).toContain('w=768');
    expect(playground).toContain('focus=1');
    expect(playground).toContain('view=playground');
  });

  it('expresses the default view by dropping the parameter', () => {
    expect(searchForView(new URLSearchParams('view=playground'), 'documentation')).toBe('');
    expect(searchForView(new URLSearchParams('view=playground&w=375'), 'documentation')).toBe(
      '?w=375',
    );
  });
});

describe('searchForPreviewWidth', () => {
  it('sets the width parameter, replacing the one already there and keeping the rest in order', () => {
    expect(searchForPreviewWidth(new URLSearchParams('view=playground&w=768&focus=1'), 375)).toBe(
      '?view=playground&w=375&focus=1',
    );
  });

  it('adds the width parameter to a URL that had none', () => {
    expect(searchForPreviewWidth(new URLSearchParams('view=playground'), 1280)).toBe(
      '?view=playground&w=1280',
    );
  });

  it('expresses the full width by dropping the parameter', () => {
    expect(searchForPreviewWidth(new URLSearchParams('w=768'), null)).toBe('');
    expect(searchForPreviewWidth(new URLSearchParams('w=768&theme=dark'), null)).toBe(
      '?theme=dark',
    );
  });

  it('round-trips through readPreviewWidthFromSearch', () => {
    for (const width of [375, 768, 1280, null] as const) {
      const search = searchForPreviewWidth(new URLSearchParams('w=999'), width);
      expect(readPreviewWidthFromSearch(new URLSearchParams(search))).toBe(width);
    }
  });
});

describe('searchForFocusMode', () => {
  it('sets the focus parameter when focus mode turns on, keeping the rest', () => {
    expect(searchForFocusMode(new URLSearchParams('w=768'), true)).toBe('?w=768&focus=1');
  });

  it('normalizes a truthy spelling the reader arrived with', () => {
    expect(searchForFocusMode(new URLSearchParams('focus=true&w=768'), true)).toBe(
      '?focus=1&w=768',
    );
  });

  it('expresses leaving focus mode by dropping the parameter', () => {
    expect(searchForFocusMode(new URLSearchParams('focus=1'), false)).toBe('');
    expect(searchForFocusMode(new URLSearchParams('w=768&focus=1&theme=dark'), false)).toBe(
      '?w=768&theme=dark',
    );
  });

  it('round-trips through readFocusModeFromSearch', () => {
    for (const focused of [true, false]) {
      const search = searchForFocusMode(new URLSearchParams('focus=yes'), focused);
      expect(readFocusModeFromSearch(new URLSearchParams(search))).toBe(focused);
    }
  });
});

describe('searchForTheme', () => {
  it('rewrites an existing theme parameter and keeps the other parameters in order', () => {
    expect(searchForTheme(new URLSearchParams('w=768&theme=dark&focus=1'), 'light')).toBe(
      '?w=768&theme=light&focus=1',
    );
  });

  it('replaces an unrecognised theme value with the chosen theme', () => {
    expect(searchForTheme(new URLSearchParams('theme=banana'), 'dark')).toBe('?theme=dark');
  });

  it('adds no theme parameter to a URL that has none', () => {
    expect(searchForTheme(new URLSearchParams('w=375'), 'dark')).toBe('?w=375');
    expect(searchForTheme(new URLSearchParams(''), 'dark')).toBe('');
  });
});
