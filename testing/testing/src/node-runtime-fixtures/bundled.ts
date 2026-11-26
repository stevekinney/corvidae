import { expect, test } from 'bun:test';

import { siblingValue } from './sibling';

test('bundles an extensionless sibling import', () => {
  expect(siblingValue).toBe('bundled sibling');
});
