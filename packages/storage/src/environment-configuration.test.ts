import { afterEach, expect, test } from 'bun:test';

import { resolveStorageEnvironment } from './environment-configuration.ts';

const originalFixtureSetting = process.env['WEFT_KEEP_DURABILITY_FIXTURES'];

afterEach(() => {
  if (originalFixtureSetting === undefined) delete process.env['WEFT_KEEP_DURABILITY_FIXTURES'];
  else process.env['WEFT_KEEP_DURABILITY_FIXTURES'] = originalFixtureSetting;
});

test('reads the exact durability fixture variable on every resolution', () => {
  process.env['WEFT_KEEP_DURABILITY_FIXTURES'] = '1';
  expect(resolveStorageEnvironment().keepDurabilityFixtures).toBe(true);

  process.env['WEFT_KEEP_DURABILITY_FIXTURES'] = '0';
  expect(resolveStorageEnvironment().keepDurabilityFixtures).toBe(false);
});
