/**
 * COR-2416: the same suites as `mid-operation-side-effects.test.ts` and
 * `document-parallel-durability.test.ts`, run as a runtime without `node:async_hooks` would (the
 * engine runs in Web Workers and Service Workers). What a branch operation stages reaches the
 * commit of its result through the operation itself, never an ambient async context, so every
 * test holds the same.
 *
 * The engine looks the module up lazily, when a test first needs it, so hiding it here, after the
 * suites' modules have loaded and before any test runs, is enough.
 */
import { afterAll, expect, it } from 'bun:test';

import '../../document-workflow/document-parallel-durability.test.ts';
import { hideAsyncHooks } from '../../testing/hide-async-hooks.test-support.ts';
import './mid-operation-side-effects.test.ts';

const restoreAsyncHooks = hideAsyncHooks();
afterAll(restoreAsyncHooks);

it('runs these suites without node:async_hooks', () => {
  const host = process as unknown as { getBuiltinModule: (id: string) => unknown };
  expect(host.getBuiltinModule('node:async_hooks')).toBeUndefined();
});
