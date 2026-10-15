import { describe, expect, test } from 'bun:test';

import { detectInputPlatform } from './input-platform.ts';

describe('detectInputPlatform', () => {
  test('recognises Apple platforms from the client hint or the platform string', () => {
    expect(detectInputPlatform({ userAgentData: { platform: 'macOS' } })).toBe('mac');
    expect(detectInputPlatform({ platform: 'MacIntel' })).toBe('mac');
    expect(detectInputPlatform({ platform: 'iPad' })).toBe('mac');
  });

  test('prefers the client hint over the legacy platform string', () => {
    expect(
      detectInputPlatform({ userAgentData: { platform: 'Linux' }, platform: 'MacIntel' }),
    ).toBe('other');
  });

  test('treats everything else, and no navigator at all, as other', () => {
    expect(detectInputPlatform({ platform: 'Win32' })).toBe('other');
    expect(detectInputPlatform({ platform: 'Linux x86_64' })).toBe('other');
    expect(detectInputPlatform({})).toBe('other');
    expect(detectInputPlatform(null)).toBe('other');
  });

  test('reads the real navigator by default', () => {
    expect(['mac', 'other']).toContain(detectInputPlatform());
  });
});
