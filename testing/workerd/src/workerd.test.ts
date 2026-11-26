import { expect, test } from 'bun:test';

import { WORKERD_COMPATIBILITY_DATE } from './workerd.ts';

test('uses an ISO compatibility date', () => {
  expect(WORKERD_COMPATIBILITY_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
