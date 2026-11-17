/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { isPlayableMediaSource } = await import('./media-player-state.svelte.ts');

describe('isPlayableMediaSource', () => {
  test.each([
    'https://example.com/a.mp4',
    'http://example.com/a.mp4',
    'blob:https://example.com/3f0c1d2e-0000-4000-8000-000000000000',
    'HTTPS://EXAMPLE.COM/A.MP4',
    '  https://example.com/a.mp4',
  ])('allows %s', (src) => {
    expect(isPlayableMediaSource(src)).toBe(true);
  });

  test.each([
    'javascript:alert(1)',
    'data:video/mp4;base64,AAAA',
    'file:///etc/passwd',
    'ftp://example.com/a.mp4',
    'about:blank',
    '',
    '   ',
    'http://',
  ])('rejects %p', (src) => {
    expect(isPlayableMediaSource(src)).toBe(false);
  });

  test('rejects an undefined source', () => {
    expect(isPlayableMediaSource(undefined)).toBe(false);
  });
});
