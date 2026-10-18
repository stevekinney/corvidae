import { describe, expect, test } from 'bun:test';

import { requireElement } from './dom.test-support.ts';

describe('requireElement', () => {
  test('returns an element of the requested constructor and names both sides of a mismatch', () => {
    const button = document.createElement('button');
    expect(requireElement(button, HTMLButtonElement)).toBe(button);

    expect(() => requireElement(document.createElement('span'), HTMLButtonElement)).toThrow(
      new TypeError('Expected HTMLButtonElement, received HTMLSpanElement'),
    );
    expect(() => requireElement(null, HTMLButtonElement)).toThrow(
      new TypeError('Expected HTMLButtonElement, received nothing'),
    );
  });
});
