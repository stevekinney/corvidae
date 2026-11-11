/**
 * The signing secret of a hook just made (COR-2022): held in memory for the one page that shows it,
 * and forgotten once that page has taken it.
 */
import { describe, expect, test } from 'bun:test';

import { holdSecret, peekHeldSecret, takeHeldSecret } from './hook-secret-once.ts';

describe('a secret shown once', () => {
  test('is taken by the page that shows it, and is gone the second time', () => {
    holdSecret('hook-1', 'whsec_one');
    expect(takeHeldSecret('hook-1')).toBe('whsec_one');
    expect(takeHeldSecret('hook-1')).toBeUndefined();
  });

  test('can be read without being forgotten, until it is taken', () => {
    holdSecret('hook-4', 'whsec_four');
    expect(peekHeldSecret('hook-4')).toBe('whsec_four');
    expect(peekHeldSecret('hook-4')).toBe('whsec_four');
    expect(takeHeldSecret('hook-4')).toBe('whsec_four');
    expect(peekHeldSecret('hook-4')).toBeUndefined();
  });

  test('belongs to the hook it was made for, and holds nothing for another', () => {
    holdSecret('hook-2', 'whsec_two');
    expect(takeHeldSecret('hook-3')).toBeUndefined();
    expect(takeHeldSecret('hook-2')).toBe('whsec_two');
  });

  test('is not found by a name every object has', () => {
    expect(takeHeldSecret('constructor')).toBeUndefined();
    expect(takeHeldSecret('__proto__')).toBeUndefined();
  });
});
