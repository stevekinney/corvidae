import { describe, expect, test } from 'bun:test';

import { isSupportedHost } from './host-platform.ts';

describe('isSupportedHost', () => {
  test.each([
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['linux', 'arm64'],
    ['linux', 'x64'],
  ])('supports %s on %s', (platform, architecture) => {
    expect(isSupportedHost({ platform, architecture })).toBe(true);
  });

  test.each([
    ['win32', 'x64'],
    ['win32', 'arm64'],
    ['freebsd', 'x64'],
    ['linux', 'ia32'],
    ['darwin', 'ppc64'],
    ['', ''],
  ])('does not support %s on %s', (platform, architecture) => {
    expect(isSupportedHost({ platform, architecture })).toBe(false);
  });

  test('supports the host this suite runs on', () => {
    expect(isSupportedHost({ platform: process.platform, architecture: process.arch })).toBe(true);
  });
});
