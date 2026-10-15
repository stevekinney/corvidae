import { describe, expect, test } from 'bun:test';

import { validateSocketUrl } from './socket-url.ts';

describe('validateSocketUrl', () => {
  test('accepts a secure address and returns it normalized', () => {
    expect(validateSocketUrl('wss://Terminal.Example/terminal?profile=shell', false)).toBe(
      'wss://terminal.example/terminal?profile=shell',
    );
  });

  test.each([
    ['http://terminal.example/terminal', 'the ws: or wss: scheme'],
    ['https://terminal.example/terminal', 'the ws: or wss: scheme'],
    ['not an address', 'absolute'],
    ['/terminal', 'absolute'],
  ])('refuses %s', (address, message) => {
    expect(() => validateSocketUrl(address, true)).toThrow(message);
  });

  test.each([
    ['wss://user:secret@terminal.example/terminal?profile=shell', 'credentials'],
    ['wss://user@terminal.example/terminal?profile=shell', 'credentials'],
    ['wss://terminal.example/terminal?profile=shell&token=hunter2', 'only the profile parameter'],
    ['wss://terminal.example/terminal?profile=shell&access_token=x', 'only the profile parameter'],
    ['wss://terminal.example/terminal?profile=shell&password=x', 'only the profile parameter'],
  ])('refuses a credential in %s', (address, message) => {
    expect(() => validateSocketUrl(address, true)).toThrow(message);
  });

  test('allows exactly one parameter, profile', () => {
    expect(() =>
      validateSocketUrl('wss://terminal.example/terminal?profile=shell', false),
    ).not.toThrow();
  });

  test.each(['sid', 'jwt', 'session', 'ticket', 'monkey', 'profiles', 'Profile', 'anything'])(
    'refuses a %s parameter, because only profile is allowed',
    (name) => {
      expect(() =>
        validateSocketUrl(`wss://terminal.example/terminal?profile=shell&${name}=x`, false),
      ).toThrow('only the profile parameter');
    },
  );

  test('refuses a repeated profile and a missing one', () => {
    expect(() =>
      validateSocketUrl('wss://terminal.example/terminal?profile=a&profile=b', false),
    ).toThrow('exactly one profile');
    expect(() => validateSocketUrl('wss://terminal.example/terminal', false)).toThrow(
      'exactly one profile',
    );
  });

  describe('a plain ws: address', () => {
    test.each([
      'ws://localhost:3000/t?profile=shell',
      'ws://127.0.0.1:3000/t?profile=shell',
      'ws://127.5.6.7/t?profile=shell',
      'ws://[::1]:3000/t?profile=shell',
    ])('is allowed to loopback %s only with the switch', (address) => {
      expect(() => validateSocketUrl(address, false)).toThrow('loopback');
      expect(() => validateSocketUrl(address, true)).not.toThrow();
    });

    test.each([
      'ws://terminal.example/t?profile=shell',
      'ws://10.0.0.1/t?profile=shell',
      'ws://127.0.0.1.evil.example/t?profile=shell',
    ])('is never allowed to %s', (address) => {
      expect(() => validateSocketUrl(address, true)).toThrow('loopback');
    });
  });
});
