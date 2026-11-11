import { describe, expect, test } from 'bun:test';

import { resolveCitationLink } from './citation-link.ts';

describe('resolveCitationLink', () => {
  test('links an http or https address and names its host', () => {
    expect(resolveCitationLink('https://docs.example.com/guide')).toEqual({
      kind: 'link',
      href: 'https://docs.example.com/guide',
      host: 'docs.example.com',
    });
    expect(resolveCitationLink('  http://example.com:8080/a  ')).toEqual({
      kind: 'link',
      href: 'http://example.com:8080/a',
      host: 'example.com:8080',
    });
  });

  test('links a relative path with no host', () => {
    expect(resolveCitationLink('/sources/one')).toEqual({
      kind: 'link',
      href: '/sources/one',
      host: undefined,
    });
  });

  test('reads a missing or blank address as no link', () => {
    expect(resolveCitationLink(undefined)).toEqual({ kind: 'none' });
    expect(resolveCitationLink('')).toEqual({ kind: 'none' });
    expect(resolveCitationLink('   ')).toEqual({ kind: 'none' });
  });

  test('refuses every other scheme, protocol-relative addresses and control characters', () => {
    for (const url of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,hello',
      'file:///etc/passwd',
      'mailto:someone@example.com',
      '//evil.example.com/path',
      '\\\\evil.example.com\\path',
      '/sources/\u0000one',
      'https://example.com/\u007f',
      'https://',
    ]) {
      expect(resolveCitationLink(url)).toEqual({ kind: 'rejected' });
    }
  });
});
