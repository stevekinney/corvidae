import { expect, test } from 'bun:test';

import rootManifest from '../package.json';

test('root type-check builds workspace declarations before either checker (COR-2389)', () => {
  const stages = rootManifest.scripts['typecheck:root'].split(/\s*&&\s*/);

  expect(stages[0]).toBe('bunx turbo run types');
  expect(stages.findIndex((stage) => stage.startsWith('tsc '))).toBeGreaterThan(0);
  expect(stages.findIndex((stage) => stage.startsWith('svelte-check '))).toBeGreaterThan(0);
});
