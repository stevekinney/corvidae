import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach } from 'bun:test';

/** The application name every test uses, so its override variable is `BUNGALOW_TEST_HOME`. */
export const TEST_NAME = 'bungalow-test';
export const TEST_HOME_VARIABLE = 'BUNGALOW_TEST_HOME';

/**
 * Register cleanup for the calling test file, and return a function that makes a fresh
 * directory for each call. Everything made is removed after each test.
 */
export function useTemporaryDirectories(): () => string {
  const created: string[] = [];
  afterEach(() => {
    for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
  });
  return () => {
    const path = mkdtempSync(join(tmpdir(), 'bungalow-test-'));
    created.push(path);
    return path;
  };
}

/** An environment that points the test application at `root`. */
export function homeEnvironment(root: string): Record<string, string> {
  return { [TEST_HOME_VARIABLE]: root };
}
