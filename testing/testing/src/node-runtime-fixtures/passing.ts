import { expect, test } from 'bun:test';

test('first passing fixture case', () => {
  expect(1).toBe(1);
});

test('second passing fixture case', () => {
  expect(['corvidae']).toContain('corvidae');
});
