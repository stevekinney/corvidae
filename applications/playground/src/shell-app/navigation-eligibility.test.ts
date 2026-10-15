import { describe, expect, test } from 'bun:test';

import {
  isCanonicalDocumentPath,
  resolveClickNavigation,
  resolveInPageNavigation,
  type NavigationAnchor,
  type NavigationClick,
} from './navigation-eligibility.ts';

const current = new URL('https://cinder.website/page/button');
const plainClick: NavigationClick = {
  button: 0,
  defaultPrevented: false,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
};
const plainAnchor: NavigationAnchor = {
  href: 'https://cinder.website/page/chat',
  target: '',
  hasDownload: false,
  rel: '',
};

describe('resolveClickNavigation', () => {
  test('accepts a plain primary click on a canonical component link', () => {
    expect(resolveClickNavigation(plainClick, plainAnchor, current)?.pathname).toBe('/page/chat');
  });

  test('accepts the home link', () => {
    const anchor = { ...plainAnchor, href: 'https://cinder.website/' };
    expect(resolveClickNavigation(plainClick, anchor, current)?.pathname).toBe('/');
  });

  test.each([
    ['meta', { metaKey: true }],
    ['ctrl', { ctrlKey: true }],
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
    ['middle button', { button: 1 }],
    ['secondary button', { button: 2 }],
    ['already prevented', { defaultPrevented: true }],
  ])('leaves a %s click native', (_name, override) => {
    expect(resolveClickNavigation({ ...plainClick, ...override }, plainAnchor, current)).toBeNull();
  });

  test.each([
    ['a download link', { hasDownload: true }],
    ['a new-tab link', { target: '_blank' }],
    ['a top-frame link', { target: '_top' }],
    ['a named-frame link', { target: 'preview' }],
    ['an external link', { rel: 'noopener external' }],
    ['another origin', { href: 'https://example.com/page/chat' }],
    ['a query string', { href: 'https://cinder.website/page/chat?view=playground' }],
    ['a legacy path', { href: 'https://cinder.website/c/chat' }],
    ['an asset', { href: 'https://cinder.website/social.png' }],
    ['a mail link', { href: 'mailto:hello@example.com' }],
    ['the current page', { href: 'https://cinder.website/page/button#props' }],
  ])('leaves %s native', (_name, override) => {
    expect(resolveClickNavigation(plainClick, { ...plainAnchor, ...override }, current)).toBeNull();
  });

  test('accepts an explicit _self target and keeps the hash', () => {
    const anchor = {
      ...plainAnchor,
      target: '_self',
      href: 'https://cinder.website/page/chat#props',
    };
    expect(resolveClickNavigation(plainClick, anchor, current)?.hash).toBe('#props');
  });
});

describe('resolveInPageNavigation', () => {
  test('resolves a relative href against the current address', () => {
    expect(resolveInPageNavigation('/page/alert', current)?.href).toBe(
      'https://cinder.website/page/alert',
    );
  });

  test('rejects a malformed component segment', () => {
    expect(resolveInPageNavigation('/page/Alert', current)).toBeNull();
    expect(resolveInPageNavigation('/page/a/b', current)).toBeNull();
  });
});

describe('isCanonicalDocumentPath', () => {
  test('accepts only the home and component document shapes', () => {
    expect(isCanonicalDocumentPath('/')).toBe(true);
    expect(isCanonicalDocumentPath('/page/button')).toBe(true);
    expect(isCanonicalDocumentPath('/page/')).toBe(false);
    expect(isCanonicalDocumentPath('/api/manifest/button')).toBe(false);
  });
});
