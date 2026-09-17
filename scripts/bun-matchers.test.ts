import { expect, test } from 'bun:test';

test('Bun promise matchers finish the assertion before returning void', () => {
  let settled = false;
  const pending = new Promise<number>((resolve) => {
    queueMicrotask(() => {
      settled = true;
      resolve(42);
    });
  });

  const returned: unknown = expect(pending).resolves.toBe(42);
  expect(settled).toBe(true);
  expect(returned).toBeUndefined();
});

test('Bun rejection matcher failures propagate synchronously', () => {
  let settled = false;
  const pending = new Promise((_resolve, reject) => {
    queueMicrotask(() => {
      settled = true;
      reject(new Error('actual failure'));
    });
  });

  expect(() => expect(pending).rejects.toThrow('different failure')).toThrow();
  expect(settled).toBe(true);
});

test('Bun negated promise matchers retain the same completion contract', () => {
  const returned: unknown = expect(Promise.resolve(42)).resolves.not.toBe(41);
  expect(returned).toBeUndefined();
  expect(() => expect(Promise.resolve(42)).resolves.not.toBe(42)).toThrow();
});
