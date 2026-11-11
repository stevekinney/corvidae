import { describe, expect, test } from 'bun:test';

import { HANG_GUARD_MILLISECONDS } from '../../../testing/testing/src/hang-guard.ts';
import configuration from '../playwright.config.ts';

describe('playwright.config.ts', () => {
  // Playwright SIGKILLs a web server that names no graceful shutdown, so `e2e-server.ts`'s SIGTERM
  // handler, the only thing that removes its `interborough-e2e-*` scratch directory, never ran and
  // every end-to-end run leaked a build and four homes into the temporary directory.
  test('stops the end-to-end server with SIGTERM so it removes its scratch directory', () => {
    const webServer = configuration.webServer;
    if (webServer === undefined || Array.isArray(webServer))
      throw new Error('Expected one webServer.');
    expect(webServer.gracefulShutdown?.signal).toBe('SIGTERM');
  });

  // COR-2305: Playwright's 60-second default failed design-review captures on a busy host while
  // the server was still seeding, so readiness is bounded by the hang guard alone.
  test('waits for the end-to-end server under the hang guard', () => {
    const webServer = configuration.webServer;
    if (webServer === undefined || Array.isArray(webServer))
      throw new Error('Expected one webServer.');
    expect(webServer.timeout).toBe(HANG_GUARD_MILLISECONDS);
  });
});
