import { expect, test } from 'bun:test';
import { secretPublicationDigest } from './secret-publication-digest.ts';

const digest = (payload: unknown) =>
  secretPublicationDigest({
    operation: 'connect',
    target: 'provider',
    expectedRevision: null,
    payload,
  });

test('canonical encoding normalizes object order and preserves meaningful request differences', () => {
  expect(digest({ b: 2, a: { z: 0, x: true } })).toBe(digest({ a: { x: true, z: -0 }, b: 2 }));
  expect(digest({ value: undefined })).toBe(digest({}));
  expect(digest({ value: null })).not.toBe(digest({}));
  expect(digest(['a', 'b'])).not.toBe(digest(['b', 'a']));
  expect(digest({ secret: 'one' })).not.toBe(digest({ secret: 'two' }));
  expect(digest({ models: ['a'] })).not.toBe(digest({ models: ['b'] }));
  expect(digest({})).toMatch(/^[a-f0-9]{64}$/);
});

test('non-JSON logical inputs and cycles fail with a value-free error', () => {
  const cycle: Record<string, unknown> = {};
  cycle['self'] = cycle;
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1n,
    Symbol('private'),
    () => 'private',
    new Date(),
    new Map(),
    [undefined],
    Array(1),
    cycle,
  ]) {
    expect(() => digest(value)).toThrow('The logical publication request is invalid.');
  }
  expect(() => digest({ [Symbol('private')]: 'value' })).toThrow(
    'The logical publication request is invalid.',
  );
});

test('operation target and expected revision are bound independently of payload', () => {
  const input = { operation: 'connect', target: 'provider', expectedRevision: null, payload: {} };
  for (const change of [
    { operation: 'disconnect' },
    { target: 'another' },
    { expectedRevision: 'revision' },
  ]) {
    expect(secretPublicationDigest({ ...input, ...change })).not.toBe(
      secretPublicationDigest(input),
    );
  }
});
