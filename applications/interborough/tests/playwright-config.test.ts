import { describe, expect, test } from 'bun:test';

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
});
