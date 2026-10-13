import { expect, test } from 'bun:test';

test('the message types are erased at runtime and the module still loads', async () => {
  expect(Object.keys(await import('./messages.ts'))).toEqual([]);
});
