import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { isGuardrailFactory } from './index.ts';

describe('isGuardrailFactory', () => {
  test('is true for a configuration object and a create function', () => {
    expect(isGuardrailFactory({ configuration: z.object({}), create: () => ({}) })).toBe(true);
  });

  test('is false for a plain guardrail, which carries neither', () => {
    expect(isGuardrailFactory({ name: 'scan', detect: () => {} })).toBe(false);
  });

  // `typeof null` is `'object'`, so a null configuration used to pass for a schema.
  test('is false when the configuration is null', () => {
    expect(isGuardrailFactory({ configuration: null, create: () => ({}) })).toBe(false);
  });

  test('is false when create is not a function', () => {
    expect(isGuardrailFactory({ configuration: z.object({}), create: 'build' })).toBe(false);
  });
});
