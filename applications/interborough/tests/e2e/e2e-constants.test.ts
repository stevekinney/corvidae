import { expect, test } from 'bun:test';
import { isBindCollision } from './e2e-constants.ts';

test('finds a bind collision through nested causes without looping on cycles', () => {
  const collision = Object.assign(new Error('occupied'), { code: 'EADDRINUSE' });
  expect(isBindCollision(new Error('showcase', { cause: collision }))).toBe(true);
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  expect(isBindCollision(cycle)).toBe(false);
  expect(isBindCollision(new Error('other'))).toBe(false);
});
