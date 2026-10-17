import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { openBungalow } from './bungalow.ts';
import { BungalowFilesystemError, BungalowLockedError, BungalowStateError } from './errors.ts';
import { homeEnvironment, TEST_NAME, useTemporaryDirectories } from './fixtures.test-support.ts';
import { startLockChild } from './lock-children.test-support.ts';
import { acquireRootLock, systemLockOperations, type LockOperations } from './lock.ts';

const temporaryDirectory = useTemporaryDirectories();

function openIn(root: string) {
  return openBungalow({ name: TEST_NAME, environment: homeEnvironment(root) });
}

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the action to throw.');
}

/**
 * The child-process scenarios run once at module scope, where no per-test clock applies and the
 * hang guard bounds them, rather than inside test bodies (AGENTS.md, COR-1507). Their results are
 * recorded here and asserted below.
 */
const scenarioRoots: string[] = [];
afterAll(() => {
  for (const root of scenarioRoots) rmSync(root, { recursive: true, force: true });
});
function scenarioRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungalow-lock-'));
  scenarioRoots.push(root);
  return root;
}

type HolderScenario = {
  readonly childProcessIdentifier: number;
  readonly held: string;
  readonly whileHeld: unknown;
  readonly lockFileWhileHeld: string;
  readonly afterKill: { readonly deploymentId: string } | { readonly error: unknown };
  readonly lockFileAfterKill: string;
};

/** A child holds the root; this process is refused, kills the child uncleanly, and reopens. */
async function runHolderScenario(): Promise<HolderScenario> {
  const root = scenarioRoot();
  const child = await startLockChild(root);
  try {
    const held = await child.ask('open');
    let whileHeld: unknown;
    try {
      openIn(root).close();
    } catch (error) {
      whileHeld = error;
    }
    const lockFileWhileHeld = readFileSync(join(root, 'lock'), 'utf8');

    await child.kill();

    let afterKill: HolderScenario['afterKill'];
    try {
      const reopened = openIn(root);
      afterKill = { deploymentId: reopened.deploymentId };
      reopened.close();
    } catch (error) {
      afterKill = { error };
    }
    return {
      childProcessIdentifier: child.processIdentifier,
      held,
      whileHeld,
      lockFileWhileHeld,
      afterKill,
      lockFileAfterKill: readFileSync(join(root, 'lock'), 'utf8'),
    };
  } finally {
    await child.kill();
  }
}

const CONTENDERS = 6;
const ROUNDS = 30;

type Round = {
  readonly replies: readonly { readonly processIdentifier: number; readonly reply: string }[];
  readonly closed: readonly string[];
};

/**
 * Several child processes try the same root at the same moment, round after round. Exactly one may
 * hold it in each round; a lock protocol with a race window shows up as two holders.
 */
async function runContentionScenario(): Promise<Round[]> {
  const root = scenarioRoot();
  const children = await Promise.all(
    Array.from({ length: CONTENDERS }, () => startLockChild(root)),
  );
  try {
    const rounds: Round[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const replies = await Promise.all(
        children.map(async (child) => ({
          processIdentifier: child.processIdentifier,
          reply: await child.ask('open'),
        })),
      );
      const closed = await Promise.all(children.map((child) => child.ask('close')));
      rounds.push({ replies, closed });
    }
    return rounds;
  } finally {
    await Promise.all(children.map((child) => child.kill()));
  }
}

const holder = await runHolderScenario();
const contention = await runContentionScenario();

describe('a lock held by another process', () => {
  test('makes a second open throw BungalowLockedError naming the holder', () => {
    expect(holder.held).toMatch(/^HELD [0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(holder.whileHeld).toBeInstanceOf(BungalowLockedError);
    const error = holder.whileHeld as BungalowLockedError;
    expect(error.holderProcessIdentifier).toBe(holder.childProcessIdentifier);
    expect(error.message).toContain(String(holder.childProcessIdentifier));
    expect(holder.lockFileWhileHeld).toBe(`${holder.childProcessIdentifier}\n`);
  });

  test('is released when the holder is killed without closing, keeping the persisted identity', () => {
    if ('error' in holder.afterKill) throw holder.afterKill.error;
    expect(holder.afterKill.deploymentId).toBe(holder.held.split(' ')[1]!);
    expect(holder.lockFileAfterKill).toBe('');
  });
});

describe('contending processes', () => {
  test('exactly one of several simultaneous openers holds the root in every round', () => {
    expect(contention).toHaveLength(ROUNDS);
    for (const [index, round] of contention.entries()) {
      const holders = round.replies.filter(({ reply }) => reply.startsWith('HELD '));
      expect(holders.length, `round ${index}`).toBe(1);
      for (const { reply } of round.replies) {
        if (reply.startsWith('HELD ')) continue;
        expect(reply, `round ${index}`).toBe(`LOCKED ${holders[0]!.processIdentifier}`);
      }
      expect(round.closed, `round ${index}`).toEqual(Array(CONTENDERS).fill('CLOSED'));
    }
  });
});

describe('a lock held by this process', () => {
  test('makes a second open of the same root throw BungalowLockedError naming this process', () => {
    const root = temporaryDirectory();
    using held = openIn(root);
    const error = thrownBy(() => openIn(root));
    expect(error).toBeInstanceOf(BungalowLockedError);
    expect((error as BungalowLockedError).holderProcessIdentifier).toBe(process.pid);
    // The refused attempt did not disturb the holder.
    expect(readFileSync(join(root, 'lock'), 'utf8')).toBe(`${process.pid}\n`);
    expect(thrownBy(() => openIn(root))).toBeInstanceOf(BungalowLockedError);
    expect(held.root).toBe(root);
  });

  test('reads only the first line of the lock file, so a later version can add more', () => {
    const root = temporaryDirectory();
    using held = openIn(root);
    appendFileSync(join(root, 'lock'), 'started 2026-10-17\nsome future field\n');
    const error = thrownBy(() => openIn(root)) as BungalowLockedError;
    expect(error.holderProcessIdentifier).toBe(process.pid);
    expect(held.root).toBe(root);
  });

  test('is released by close, so the root opens again, and the file stays in place', () => {
    const root = temporaryDirectory();
    openIn(root).close();
    expect(readFileSync(join(root, 'lock'), 'utf8')).toBe('');
    expect(statSync(join(root, 'lock')).mode & 0o777).toBe(0o600);
    openIn(root).close();
  });
});

describe('text left in the lock file by a process that is gone', () => {
  test.each(['2147483646\n', '', 'garbage', '-5\n', '12abc\n', '99999999999999999999\n'])(
    'does not hold the root: %p',
    (text) => {
      const root = temporaryDirectory();
      writeFileSync(join(root, 'lock'), text);
      using handle = openIn(root);
      expect(handle.root).toBe(root);
      expect(readFileSync(join(root, 'lock'), 'utf8')).toBe(`${process.pid}\n`);
    },
  );

  test('a live process named in the file does not hold the root either: the kernel does', () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'lock'), `${process.ppid}\n`);
    using handle = openIn(root);
    expect(handle.root).toBe(root);
  });
});

describe('acquireRootLock against a host that refuses', () => {
  const refusing = (attempt: ReturnType<LockOperations['tryLock']>): LockOperations => ({
    tryLock: () => attempt,
  });

  test('reports a failure that is not contention as a filesystem error', () => {
    const root = temporaryDirectory();
    const error = thrownBy(() => acquireRootLock(root, refusing({ errno: 45 })));
    expect(error).toBeInstanceOf(BungalowFilesystemError);
    expect((error as BungalowFilesystemError).cause).toEqual({ errno: 45 });
  });

  test('names no holder when contention finds no identifier in the file', () => {
    const root = temporaryDirectory();
    const error = thrownBy(() => acquireRootLock(root, refusing('contended')));
    expect(error).toBeInstanceOf(BungalowLockedError);
    expect((error as BungalowLockedError).holderProcessIdentifier).toBeUndefined();
  });

  test('reports a lock file that cannot be opened as a filesystem error', () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'lock'), '');
    const error = thrownBy(() => acquireRootLock(join(root, 'lock'), refusing('acquired')));
    expect(error).toBeInstanceOf(BungalowFilesystemError);
  });
});

describe('the lock descriptor', () => {
  test('is close-on-exec, so no process this one execs can hold the lock past it', () => {
    const system = systemLockOperations();
    let observed: boolean | undefined;
    const lock = acquireRootLock(temporaryDirectory(), {
      tryLock(descriptor) {
        observed = system.isCloseOnExec(descriptor);
        return system.tryLock(descriptor);
      },
    });
    lock.release();
    expect(observed).toBe(true);
  });

  test('is released at most once, so a repeated release cannot close a recycled descriptor', () => {
    const root = temporaryDirectory();
    const system = systemLockOperations();
    let held: number | undefined;
    const lock = acquireRootLock(root, {
      tryLock(descriptor) {
        held = descriptor;
        return system.tryLock(descriptor);
      },
    });
    lock.release();

    // The next descriptor the process opens takes the number the lock just gave up.
    const recycled = openSync(join(root, 'other'), 'w');
    try {
      expect(recycled).toBe(held!);
      lock.release();
      expect(() => fstatSync(recycled)).not.toThrow();
    } finally {
      closeSync(recycled);
    }
  });
});

describe('a holder that is just starting or just finishing', () => {
  test('is waited for: a contender that finds the file empty takes the lock when the holder goes', () => {
    const root = temporaryDirectory();
    const system = systemLockOperations();
    let attempts = 0;
    const lock = acquireRootLock(root, {
      tryLock(descriptor) {
        attempts += 1;
        // The first attempt loses to a holder that has already cleared the file and is closing.
        return attempts === 1 ? 'contended' : system.tryLock(descriptor);
      },
    });
    expect(attempts).toBe(2);
    expect(readFileSync(join(root, 'lock'), 'utf8')).toBe(`${process.pid}\n`);
    lock.release();
  });

  test('is reported as soon as the file names it, without waiting', () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'lock'), '4242\n');
    let attempts = 0;
    const error = thrownBy(() =>
      acquireRootLock(root, {
        tryLock: () => {
          attempts += 1;
          return 'contended';
        },
      }),
    );
    expect(error).toBeInstanceOf(BungalowLockedError);
    expect((error as BungalowLockedError).holderProcessIdentifier).toBe(4242);
    expect(attempts).toBe(1);
  });
});

describe('a lock entry that is not a regular file', () => {
  test('is refused when it is a symbolic link, and its target is left untouched', () => {
    const root = temporaryDirectory();
    const target = join(temporaryDirectory(), 'sentinel');
    writeFileSync(target, 'sentinel bytes that must survive');
    symlinkSync(target, join(root, 'lock'));
    expect(thrownBy(() => openIn(root))).toBeInstanceOf(BungalowStateError);
    expect(readFileSync(target, 'utf8')).toBe('sentinel bytes that must survive');
  });

  test('is refused when it is a dangling symbolic link, which is not created through', () => {
    const root = temporaryDirectory();
    const target = join(temporaryDirectory(), 'absent');
    symlinkSync(target, join(root, 'lock'));
    expect(thrownBy(() => openIn(root))).toBeInstanceOf(BungalowStateError);
    expect(existsSync(target)).toBe(false);
  });

  test('is refused when it is a directory', () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, 'lock'));
    expect(thrownBy(() => openIn(root))).toBeInstanceOf(BungalowFilesystemError);
  });
});
