/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';

import { findEntryHref } from './progressive-navigation.ts';

function documentWith(source: string): Document {
  const parsed = window.document.implementation.createHTMLDocument('page');
  parsed.body.innerHTML = `<script type="module" src="${source}"></script>`;
  return parsed;
}

const base = 'https://cinder.website/page/button';

describe('findEntryHref', () => {
  test('accepts the development entry URLs', () => {
    expect(findEntryHref(documentWith('/page-bundle/button.js'), base)).toBe(
      'https://cinder.website/page-bundle/button.js',
    );
    expect(findEntryHref(documentWith('/shell-bundle/shell.js'), base)).toBe(
      'https://cinder.website/shell-bundle/shell.js',
    );
  });

  test('accepts the fingerprinted URLs the static export writes', () => {
    expect(findEntryHref(documentWith('/assets/0123abcd/page-bundle/button.js'), base)).toBe(
      'https://cinder.website/assets/0123abcd/page-bundle/button.js',
    );
    expect(findEntryHref(documentWith('/assets/0123abcd/shell-bundle/shell.js'), base)).toBe(
      'https://cinder.website/assets/0123abcd/shell-bundle/shell.js',
    );
  });

  test('rejects any other script', () => {
    expect(findEntryHref(documentWith('/assets/0123abcd/other/button.js'), base)).toBeNull();
    expect(findEntryHref(documentWith('/analytics.js'), base)).toBeNull();
    expect(findEntryHref(window.document.implementation.createHTMLDocument('x'), base)).toBeNull();
  });
});
