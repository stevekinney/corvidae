import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { describe, expect, test } from 'bun:test';

import { openBungalow } from './bungalow.ts';
import { BungalowFilesystemError, BungalowInputError, BungalowLockedError } from './errors.ts';
import { homeEnvironment, TEST_NAME, useTemporaryDirectories } from './fixtures.test-support.ts';

const temporaryDirectory = useTemporaryDirectories();

/** A value no honest message, path, or stack would contain by accident. */
const SENTINEL = 'sentinel-secret-6c1d0e7a-do-not-leak';

/** Everything an error can expose: its message, stack, serialized form, and its whole cause chain. */
function exposure(error: unknown): string {
  const parts: string[] = [inspect(error, { depth: Infinity, showHidden: true })];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    parts.push(current.message, current.stack ?? '', String(current));
    current = current.cause;
  }
  if (current !== undefined && !(current instanceof Error)) parts.push(inspect(current));
  return parts.join('\n');
}

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the action to throw.');
}

describe('secrets never appear in errors', () => {
  test('the exposure helper does see a sentinel placed in an error', () => {
    expect(exposure(new Error('x', { cause: new Error(SENTINEL) }))).toContain(SENTINEL);
  });

  test('invalid key', () => {
    const root = temporaryDirectory();
    using handle = openBungalow({ name: TEST_NAME, environment: homeEnvironment(root) });
    handle.writeSecret('known', SENTINEL);

    const error = thrownBy(() => handle.writeSecret('../Bad Key', SENTINEL));
    expect(error).toBeInstanceOf(BungalowInputError);
    expect(exposure(error)).not.toContain(SENTINEL);

    const keyIsTheSecret = thrownBy(() => handle.writeSecret(SENTINEL.toUpperCase(), 'v'));
    expect(exposure(keyIsTheSecret)).not.toContain(SENTINEL.toUpperCase());
  });

  test('filesystem failure', () => {
    const root = temporaryDirectory();
    using handle = openBungalow({ name: TEST_NAME, environment: homeEnvironment(root) });
    handle.writeSecret('known', SENTINEL);

    // A directory where the secret's file belongs makes the final rename fail.
    mkdirSync(join(handle.secrets, 'blocked'));
    const renameFailure = thrownBy(() => handle.writeSecret('blocked', SENTINEL));
    expect(renameFailure).toBeInstanceOf(BungalowFilesystemError);
    expect((renameFailure as BungalowFilesystemError).cause).toBeDefined();
    expect(exposure(renameFailure)).not.toContain(SENTINEL);
    // The temporary file that held the value was removed.
    expect(readdirSync(handle.secrets).toSorted()).toEqual(['blocked', 'known']);

    // A directory where the secret's file belongs also makes the read fail.
    const readFailure = thrownBy(() => handle.readSecret('blocked'));
    expect(readFailure).toBeInstanceOf(BungalowFilesystemError);
    expect(exposure(readFailure)).not.toContain(SENTINEL);

    // A missing secrets directory makes the temporary file's creation fail.
    rmSync(handle.secrets, { recursive: true, force: true });
    const createFailure = thrownBy(() => handle.writeSecret('other', SENTINEL));
    expect(createFailure).toBeInstanceOf(BungalowFilesystemError);
    expect(exposure(createFailure)).not.toContain(SENTINEL);
  });

  test('locked root', () => {
    const root = temporaryDirectory();
    using handle = openBungalow({ name: TEST_NAME, environment: homeEnvironment(root) });
    handle.writeSecret('known', SENTINEL);

    const error = thrownBy(() =>
      openBungalow({ name: TEST_NAME, environment: homeEnvironment(root) }),
    );
    expect(error).toBeInstanceOf(BungalowLockedError);
    expect(exposure(error)).not.toContain(SENTINEL);
  });
});
