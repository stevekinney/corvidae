import { describe, expect, test } from 'bun:test';

import {
  isSupportedHost,
  SUPPORTED_HOST_ARCHITECTURES,
  SUPPORTED_HOST_PLATFORMS,
} from './host-platform.ts';

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

  test('answers for the running host exactly as the declared matrix does', () => {
    const declared =
      (SUPPORTED_HOST_PLATFORMS as readonly string[]).includes(process.platform) &&
      (SUPPORTED_HOST_ARCHITECTURES as readonly string[]).includes(process.arch);
    expect(isSupportedHost({ platform: process.platform, architecture: process.arch })).toBe(
      declared,
    );
  });

  test('supports every declared platform on every declared architecture', () => {
    for (const platform of SUPPORTED_HOST_PLATFORMS) {
      for (const architecture of SUPPORTED_HOST_ARCHITECTURES) {
        expect(isSupportedHost({ platform, architecture })).toBe(true);
      }
    }
  });
});
