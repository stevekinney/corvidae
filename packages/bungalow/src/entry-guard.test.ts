import {
  chmodSync,
  existsSync,
  linkSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { openBungalow } from './bungalow.ts';
import { BungalowStateError } from './errors.ts';
import { makeFifo } from './fifo.test-support.ts';
import { homeEnvironment, TEST_NAME, useTemporaryDirectories } from './fixtures.test-support.ts';

const temporaryDirectory = useTemporaryDirectories();

const ULID = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const UUID = '123e4567-e89b-12d3-a456-426614174000';

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function openIn(root: string) {
  return openBungalow({ name: TEST_NAME, environment: homeEnvironment(root) });
}

/** Open the root and release it again, so the next open starts from a cleanly closed root. */
async function openAndClose(root: string): Promise<void> {
  const handle = await openIn(root);
  handle.close();
}

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the action to throw.');
}

async function rejectedBy(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the action to reject.');
}

/** A directory somebody else owns, which no Bungalow operation may change. */
function foreignDirectory(): string {
  const directory = temporaryDirectory();
  writeFileSync(join(directory, 'theirs'), 'not bungalow');
  chmodSync(directory, 0o755);
  return directory;
}

function expectForeignDirectoryUntouched(directory: string): void {
  expect(modeOf(directory)).toBe(0o755);
  expect(readdirSync(directory)).toEqual(['theirs']);
  expect(readFileSync(join(directory, 'theirs'), 'utf8')).toBe('not bungalow');
}

/** Every entry Bungalow opens inside a root, replaced by something it must not trust. */
describe('an entry inside the root that is not what Bungalow expects', () => {
  const directoryEntries = [
    ['secrets', 'secrets directory'],
    ['logs', 'logs directory'],
  ] as const;

  test.each(directoryEntries)(
    'a symbolic link at %s is refused and its target left alone',
    async (name, label) => {
      const root = temporaryDirectory();
      const target = foreignDirectory();
      symlinkSync(target, join(root, name));
      const error = await rejectedBy(openIn(root));
      expect(error).toBeInstanceOf(BungalowStateError);
      expect((error as Error).message).toContain(label);
      expect((error as Error).message).toContain('symbolic link');
      expectForeignDirectoryUntouched(target);
    },
  );

  test('a symbolic link as the root itself is refused and its target left alone', async () => {
    const target = foreignDirectory();
    const root = join(temporaryDirectory(), 'link');
    symlinkSync(target, root);
    const error = await rejectedBy(openIn(root));
    expect(error).toBeInstanceOf(BungalowStateError);
    expect((error as Error).message).toContain('root directory');
    expectForeignDirectoryUntouched(target);
  });

  test('a symbolic link as a content directory is refused and its target left alone', async () => {
    const root = temporaryDirectory();
    const target = foreignDirectory();
    using handle = await openIn(root);
    symlinkSync(target, join(root, 'agents'));
    const error = thrownBy(() => handle.content('agents'));
    expect(error).toBeInstanceOf(BungalowStateError);
    expect((error as Error).message).toContain('content directory');
    expectForeignDirectoryUntouched(target);
  });

  test('a file where a directory belongs is refused', async () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'secrets'), 'a file');
    const error = await rejectedBy(openIn(root));
    expect(error).toBeInstanceOf(BungalowStateError);
    expect((error as Error).message).toContain('not a directory');
  });

  test('a symbolic link as the lock is refused and its target left alone', async () => {
    const root = temporaryDirectory();
    const target = join(foreignDirectory(), 'theirs');
    symlinkSync(target, join(root, 'lock'));
    const error = await rejectedBy(openIn(root));
    expect(error).toBeInstanceOf(BungalowStateError);
    expect((error as Error).message).toContain('lock file');
    expect(readFileSync(target, 'utf8')).toBe('not bungalow');
  });

  test('a lock that is also a hard link elsewhere is refused and the other link is left alone', async () => {
    const root = temporaryDirectory();
    const other = join(temporaryDirectory(), 'other-link');
    writeFileSync(other, 'bytes that must survive');
    linkSync(other, join(root, 'lock'));
    const error = await rejectedBy(openIn(root));
    expect(error).toBeInstanceOf(BungalowStateError);
    expect((error as Error).message).toContain('lock file');
    expect((error as Error).message).toContain('hard link');
    expect(readFileSync(other, 'utf8')).toBe('bytes that must survive');
    expect(statSync(other).nlink).toBe(2);
  });

  test('a symbolic link as deployment-id is refused instead of read through', async () => {
    const root = temporaryDirectory();
    const target = join(temporaryDirectory(), 'identity');
    writeFileSync(target, `${ULID}\n`);
    symlinkSync(target, join(root, 'deployment-id'));
    const error = await rejectedBy(openIn(root));
    expect(error).toBeInstanceOf(BungalowStateError);
    expect((error as Error).message).toContain('deployment-id file');
    expect(readFileSync(target, 'utf8')).toBe(`${ULID}\n`);
  });

  test('a FIFO as deployment-id is refused promptly instead of blocking the open', async () => {
    const root = temporaryDirectory();
    makeFifo(join(root, 'deployment-id'));
    const error = await rejectedBy(openIn(root));
    expect(error).toBeInstanceOf(BungalowStateError);
    expect((error as Error).message).toContain('not a regular file');
  });

  test('a symbolic link as the configuration is refused instead of read through', async () => {
    const root = temporaryDirectory();
    using handle = await openIn(root);
    const target = join(temporaryDirectory(), 'theirs');
    writeFileSync(target, '{"not":"ours"}');
    symlinkSync(target, join(root, 'configuration.json'));
    const error = await rejectedBy(handle.readConfiguration());
    expect(error).toBeInstanceOf(BungalowStateError);
    expect((error as Error).message).toContain('configuration file');
  });

  test('a FIFO as a secret is refused promptly instead of blocking the read', async () => {
    using handle = await openIn(temporaryDirectory());
    makeFifo(handle.secretLocation('token'));
    const error = thrownBy(() => handle.readSecret('token'));
    expect(error).toBeInstanceOf(BungalowStateError);
    expect((error as Error).message).toContain('secret file');
    expect((error as Error).message).not.toContain('token');
  });

  test('a symbolic link as a secret is refused instead of read or tightened through', async () => {
    using handle = await openIn(temporaryDirectory());
    const target = join(temporaryDirectory(), 'theirs');
    writeFileSync(target, 'not a secret of ours');
    chmodSync(target, 0o644);
    symlinkSync(target, handle.secretLocation('token'));
    expect(thrownBy(() => handle.readSecret('token'))).toBeInstanceOf(BungalowStateError);
    expect(modeOf(target)).toBe(0o644);
  });

  test('a secret that is also a hard link elsewhere is refused and the other link left alone', async () => {
    using handle = await openIn(temporaryDirectory());
    const other = join(temporaryDirectory(), 'theirs');
    writeFileSync(other, 'shared');
    chmodSync(other, 0o644);
    linkSync(other, handle.secretLocation('token'));
    const error = thrownBy(() => handle.readSecret('token'));
    expect(error).toBeInstanceOf(BungalowStateError);
    expect((error as Error).message).toContain('hard link');
    expect(modeOf(other)).toBe(0o644);
  });

  test('writing a secret over a symbolic link replaces the link and leaves its target alone', async () => {
    using handle = await openIn(temporaryDirectory());
    const target = join(temporaryDirectory(), 'theirs');
    writeFileSync(target, 'not a secret of ours');
    symlinkSync(target, handle.secretLocation('token'));
    handle.writeSecret('token', 'ours');
    expect(readFileSync(target, 'utf8')).toBe('not a secret of ours');
    expect(handle.readSecret('token')).toBe('ours');
  });

  test('the temporary-file sweep neither deletes through a symbolic link nor follows one', async () => {
    const root = temporaryDirectory();
    await openAndClose(root);
    const target = join(temporaryDirectory(), 'theirs');
    writeFileSync(target, 'not bungalow');
    const rootLink = join(root, `deployment-id.4242-${UUID}.tmp`);
    const secretLink = join(root, 'secrets', `token.4242-${UUID}.tmp`);
    symlinkSync(target, rootLink);
    symlinkSync(target, secretLink);
    using handle = await openIn(root);
    expect(handle.configurationLocation).toBe(join(root, 'configuration.json'));
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('not bungalow');
  });

  test('a refused open releases the lock', async () => {
    const root = temporaryDirectory();
    const target = foreignDirectory();
    symlinkSync(target, join(root, 'secrets'));
    expect(await rejectedBy(openIn(root))).toBeInstanceOf(BungalowStateError);
    // Nothing else holds the root, so the next open reaches the same refusal rather than a lock.
    expect(await rejectedBy(openIn(root))).toBeInstanceOf(BungalowStateError);
  });
});
