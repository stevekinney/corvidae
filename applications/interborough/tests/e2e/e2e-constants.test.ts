import { expect, test } from 'bun:test';
import { END_TO_END_PORT_COUNT } from '../../scripts/environment-configuration.ts';
import { E2E_CHAT_SHARING_PORT, E2E_PORT, isBindCollision } from './e2e-constants.ts';

test('the sharing listener is included in the allocated block', () => {
  expect(E2E_CHAT_SHARING_PORT - E2E_PORT).toBe(END_TO_END_PORT_COUNT - 1);
});

test('finds a bind collision through nested causes without looping on cycles', () => {
  const collision = Object.assign(new Error('occupied'), { code: 'EADDRINUSE' });
  expect(isBindCollision(new Error('showcase', { cause: collision }))).toBe(true);
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  expect(isBindCollision(cycle)).toBe(false);
  expect(isBindCollision(new Error('other'))).toBe(false);
});
