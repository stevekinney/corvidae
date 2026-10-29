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
/** A valid key that no honest message, path, or stack would contain by accident. */
const KEY_SENTINEL = 'sentinel-key-91b4f2c8-do-not-leak';

/** Everything an error can expose: its message, stack, inspected form, and its whole cause chain. */
function exposure(error: unknown): string {
  const parts: string[] = [inspect(error, { depth: Infinity, showHidden: true })];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    parts.push(current.message, current.stack ?? '', String(current));
    current = current.cause;
  }
  if (current !== undefined) parts.push(inspect(current, { depth: Infinity, showHidden: true }));
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

function expectNoLeak(error: unknown): void {
  const text = exposure(error);
  expect(text).not.toContain(SENTINEL);
  expect(text).not.toContain(KEY_SENTINEL);
}

describe('neither a secret value nor a secret key appears in an error', () => {
  test('the exposure helper does see a sentinel placed anywhere in an error', () => {
    expect(exposure(new Error('x', { cause: new Error(SENTINEL) }))).toContain(SENTINEL);
    expect(exposure(new Error('x', { cause: { path: `/a/${KEY_SENTINEL}` } }))).toContain(
      KEY_SENTINEL,
    );
    expect(exposure(Object.assign(new Error('x'), { path: KEY_SENTINEL }))).toContain(KEY_SENTINEL);
  });

  test('invalid key', async () => {
    const root = temporaryDirectory();
    using handle = await openBungalow({ name: TEST_NAME, environment: homeEnvironment(root) });
    handle.writeSecret(KEY_SENTINEL, SENTINEL);

    const error = thrownBy(() => handle.writeSecret('../Bad Key', SENTINEL));
    expect(error).toBeInstanceOf(BungalowInputError);
    expectNoLeak(error);

    const keyIsTheSecret = thrownBy(() => handle.writeSecret(SENTINEL.toUpperCase(), 'v'));
    expect(exposure(keyIsTheSecret)).not.toContain(SENTINEL.toUpperCase());
    const readKey = thrownBy(() => handle.readSecret(KEY_SENTINEL.toUpperCase()));
    expect(exposure(readKey)).not.toContain(KEY_SENTINEL.toUpperCase());
  });

  test('filesystem failure carries a code, a system call, and an errno, and nothing else', async () => {
    const root = temporaryDirectory();
    using handle = await openBungalow({ name: TEST_NAME, environment: homeEnvironment(root) });
    handle.writeSecret('known', SENTINEL);

    // A directory where the secret's file belongs makes the final rename fail.
    mkdirSync(join(root, 'secrets', KEY_SENTINEL));
    const renameFailure = thrownBy(() => handle.writeSecret(KEY_SENTINEL, SENTINEL));
    expect(renameFailure).toBeInstanceOf(BungalowFilesystemError);
    const cause = (renameFailure as BungalowFilesystemError).cause as Record<string, unknown>;
    expect(Object.keys(cause).toSorted()).toEqual(['code', 'errno', 'syscall']);
    expect(cause['code']).toBeString();
    expectNoLeak(renameFailure);
    // The temporary file that held the value was removed, not left in secrets/.
    expect(readdirSync(join(root, 'secrets')).toSorted()).toEqual(
      [KEY_SENTINEL, 'known'].toSorted(),
    );

    // A missing secrets directory makes the temporary file's creation fail.
    rmSync(join(root, 'secrets'), { recursive: true, force: true });
    const createFailure = thrownBy(() => handle.writeSecret(KEY_SENTINEL, SENTINEL));
    expect(createFailure).toBeInstanceOf(BungalowFilesystemError);
    expect((createFailure as BungalowFilesystemError).cause).toBeDefined();
    expectNoLeak(createFailure);

    // Reading a key whose entry cannot be read as a file.
    mkdirSync(join(root, 'secrets'));
    mkdirSync(join(root, 'secrets', KEY_SENTINEL));
    expectNoLeak(thrownBy(() => handle.readSecret(KEY_SENTINEL)));
  });

  test('locked root', async () => {
    const root = temporaryDirectory();
    using handle = await openBungalow({ name: TEST_NAME, environment: homeEnvironment(root) });
    handle.writeSecret(KEY_SENTINEL, SENTINEL);

    const error = await openBungalow({
      name: TEST_NAME,
      environment: homeEnvironment(root),
    }).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(BungalowLockedError);
    expectNoLeak(error);
  });
});
