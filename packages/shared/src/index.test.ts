import { expect, it } from 'bun:test';

import { greet } from './index.ts';

it('greets by name', () => {
  expect(greet('World')).toBe('Hello, World!');
});
