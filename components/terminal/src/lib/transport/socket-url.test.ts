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
    ['wss://user:secret@terminal.example/terminal', 'credentials'],
    ['wss://user@terminal.example/terminal', 'credentials'],
    ['wss://terminal.example/terminal?token=hunter2', 'credential parameter'],
    ['wss://terminal.example/terminal?access_token=x', 'credential parameter'],
    ['wss://terminal.example/terminal?Authorization=x', 'credential parameter'],
    ['wss://terminal.example/terminal?api-key=x', 'credential parameter'],
    ['wss://terminal.example/terminal?key=x', 'credential parameter'],
    ['wss://terminal.example/terminal?password=x', 'credential parameter'],
    ['wss://terminal.example/terminal?cookie=x', 'credential parameter'],
  ])('refuses a credential in %s', (address, message) => {
    expect(() => validateSocketUrl(address, true)).toThrow(message);
  });

  test('allows ordinary parameters, including ones that merely contain a short word', () => {
    expect(() =>
      validateSocketUrl('wss://terminal.example/terminal?profile=shell&monkey=1&session=x', false),
    ).not.toThrow();
  });

  describe('a plain ws: address', () => {
    test.each([
      'ws://localhost:3000/t',
      'ws://127.0.0.1:3000/t',
      'ws://127.5.6.7/t',
      'ws://[::1]:3000/t',
    ])('is allowed to loopback %s only with the switch', (address) => {
      expect(() => validateSocketUrl(address, false)).toThrow('loopback');
      expect(() => validateSocketUrl(address, true)).not.toThrow();
    });

    test.each(['ws://terminal.example/t', 'ws://10.0.0.1/t', 'ws://127.0.0.1.evil.example/t'])(
      'is never allowed to %s',
      (address) => {
        expect(() => validateSocketUrl(address, true)).toThrow('loopback');
      },
    );
  });
});
