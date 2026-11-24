import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openLocalBungalow } from '@lostgradient/bungalow';
import { Database } from 'bun:sqlite';
import { renameSync, symlinkSync } from 'node:fs';
import { resetOwnedFixture } from './fixture-ownership.ts';
import { seedSampleWorld } from './sample-world-seed.ts';

test('refuses a nonempty unmarked home before changing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sample-world-ownership-'));
  try {
    const home = join(root, 'home');
    await mkdir(home);
    await writeFile(join(home, 'sentinel'), 'preserve');
    expect(
      await throwingRejectionOf(
        seedSampleWorld(home, {
          ownership: { root, owner: root },
          onStep: () => {
            throw new Error('stop');
          },
        }),
      ),
    ).toThrow('nonempty unmarked');
    expect(await readFile(join(home, 'sentinel'), 'utf8')).toBe('preserve');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not treat an unmarked lock-only directory as disposable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sample-world-ownership-'));
  const home = join(root, 'home');
  try {
    await mkdir(home);
    await writeFile(join(home, 'lock'), 'foreign lock');
    expect(await throwingRejectionOf(resetOwnedFixture(home, { root, owner: root }))).toThrow(
      'nonempty unmarked',
    );
    expect(await readFile(join(home, 'lock'), 'utf8')).toBe('foreign lock');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts a trusted root alias while rejecting links below that root', async () => {
  const container = await mkdtemp(join(tmpdir(), 'sample-world-ownership-'));
  try {
    const actual = join(container, 'actual');
    const alias = join(container, 'alias');
    const outside = join(container, 'outside');
    await Promise.all([mkdir(actual), mkdir(outside)]);
    await symlink(actual, alias);
    const lease = await resetOwnedFixture(join(alias, 'home'), { root: alias, owner: container });
    lease.release();
    await writeFile(join(outside, 'sentinel'), 'outside');
    await symlink(outside, join(actual, 'escape'));
    expect(
      await throwingRejectionOf(
        resetOwnedFixture(join(alias, 'escape'), { root: alias, owner: container }),
      ),
    ).toThrow('symbolic links');
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('outside');
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});

test('captures the fixture owner before any asynchronous work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sample-world-ownership-'));
  try {
    const first = join(root, 'first');
    const second = join(root, 'second');
    const home = join(root, 'home');
    await Promise.all([mkdir(first), mkdir(second)]);
    const ownership = { root, owner: first };
    const pending = resetOwnedFixture(home, ownership);
    ownership.owner = second;
    const lease = await pending;
    lease.release();
    const next = await resetOwnedFixture(home, { root, owner: first });
    next.release();
    expect(await throwingRejectionOf(resetOwnedFixture(home, { root, owner: second }))).toThrow(
      'another owner',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('leaves both schema and data intact in unmarked and foreign homes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sample-world-ownership-'));
  try {
    const owner = join(root, 'owner');
    const foreignOwner = join(root, 'foreign-owner');
    const unmarked = join(root, 'unmarked');
    const foreign = join(root, 'foreign');
    await Promise.all([mkdir(owner), mkdir(foreignOwner), mkdir(unmarked)]);
    const lease = await resetOwnedFixture(foreign, { root, owner: foreignOwner });
    lease.release();
    for (const [home, value] of [
      [unmarked, 'unmarked'],
      [foreign, 'foreign'],
    ] as const) {
      const database = new Database(join(home, 'database.sqlite'));
      database.run('PRAGMA user_version = 7');
      database.run('CREATE TABLE sample (value TEXT NOT NULL)');
      database.run('INSERT INTO sample VALUES (?)', [value]);
      database.close();
    }
    expect(await throwingRejectionOf(resetOwnedFixture(unmarked, { root, owner }))).toThrow(
      'nonempty unmarked',
    );
    expect(await throwingRejectionOf(resetOwnedFixture(foreign, { root, owner }))).toThrow(
      'another owner',
    );
    for (const [home, value] of [
      [unmarked, 'unmarked'],
      [foreign, 'foreign'],
    ] as const) {
      const database = new Database(join(home, 'database.sqlite'), { readonly: true });
      expect(database.query('PRAGMA user_version').get()).toEqual({ user_version: 7 });
      expect(database.query('SELECT value FROM sample').get()).toEqual({ value });
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses nested fixture homes before touching the existing child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sample-world-ownership-'));
  try {
    const parent = join(root, 'parent');
    const lease = await resetOwnedFixture(parent, { root, owner: root });
    lease.release();
    expect(
      await throwingRejectionOf(
        resetOwnedFixture(join(parent, 'child'), { root: parent, owner: root }),
      ),
    ).toThrow('cannot also be a disposable root');
    await mkdir(join(parent, 'child'));
    await writeFile(join(parent, 'child', 'sentinel'), 'keep');
    expect(
      await throwingRejectionOf(resetOwnedFixture(join(parent, 'child'), { root, owner: root })),
    ).toThrow('direct child');
    expect(await readFile(join(parent, 'child', 'sentinel'), 'utf8')).toBe('keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a claimed disposable root cannot concurrently become a home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sample-world-ownership-'));
  try {
    const nestedRoot = join(root, 'nested');
    await mkdir(nestedRoot);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const nested = resetOwnedFixture(
      join(nestedRoot, 'child'),
      { root: nestedRoot, owner: root },
      async () => {
        entered.resolve();
        await resume.promise;
      },
    );
    await entered.promise;
    try {
      expect(
        await throwingRejectionOf(resetOwnedFixture(nestedRoot, { root, owner: root })),
      ).toThrow('disposable root');
    } finally {
      resume.resolve();
    }
    const lease = await nested;
    lease.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a different real directory substituted before the home is pinned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sample-world-ownership-'));
  try {
    const home = join(root, 'home');
    const original = join(root, 'original');
    const replacement = join(root, 'replacement');
    const ownership = { root, owner: root };
    const initial = await resetOwnedFixture(home, ownership);
    initial.release();
    await writeFile(join(home, 'sentinel'), 'owned');
    await mkdir(replacement);
    await writeFile(join(replacement, 'sentinel'), 'foreign');
    expect(
      await throwingRejectionOf(
        resetOwnedFixture(home, ownership, undefined, async () => {
          await rename(home, original);
          await rename(replacement, home);
        }),
      ),
    ).toThrow('changed before it was pinned');
    expect(await readFile(join(original, 'sentinel'), 'utf8')).toBe('owned');
    expect(await readFile(join(home, 'sentinel'), 'utf8')).toBe('foreign');
    expect(await throwingRejectionOf(resetOwnedFixture(home, ownership))).toThrow(
      'identity does not match',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves a normal Bungalow initialized after a pending marker but before the home flock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sample-world-ownership-'));
  const home = join(root, 'home');
  try {
    let deploymentId = '';
    expect(
      await throwingRejectionOf(
        resetOwnedFixture(home, { root, owner: root }, undefined, undefined, async () => {
          const bungalow = await openLocalBungalow({ name: 'interborough', root: home });
          deploymentId = bungalow.deploymentId;
          await writeFile(join(home, 'sentinel'), 'normal home');
          bungalow.close();
        }),
      ),
    ).toThrow('not empty');
    expect(await readFile(join(home, 'sentinel'), 'utf8')).toBe('normal home');
    const savedDeployment = await readFile(join(home, 'deployment-id'), 'utf8');
    expect(savedDeployment.trim()).toBe(deploymentId);
    expect(await throwingRejectionOf(resetOwnedFixture(home, { root, owner: root }))).toThrow(
      'not empty',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a borrowed home that changes before a seed host opens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sample-world-ownership-'));
  const outside = await mkdtemp(join(tmpdir(), 'sample-world-outside-'));
  const home = join(root, 'home');
  try {
    await writeFile(join(outside, 'sentinel'), 'outside');
    expect(
      await throwingRejectionOf(
        seedSampleWorld(home, {
          ownership: { root, owner: root },
          onStep: (step) => {
            if (step === 'Tool runner version 1: starting its host') {
              renameSync(home, join(root, 'original'));
              symlinkSync(outside, home);
            }
          },
        }),
      ),
    ).toThrow('Fixture changed after reset');
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('outside');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('keeps foreign and linked homes intact and holds the Bungalow lock across reset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sample-world-ownership-'));
  const outside = await mkdtemp(join(tmpdir(), 'sample-world-outside-'));
  try {
    const owner = join(root, 'owner');
    const other = join(root, 'other');
    const home = join(root, 'home');
    await Promise.all([mkdir(owner), mkdir(other)]);
    const lease = await resetOwnedFixture(home, { root, owner });
    expect(
      await throwingRejectionOf(openLocalBungalow({ name: 'interborough', root: home })),
    ).toThrow();
    await writeFile(join(home, 'sentinel'), 'owned');
    lease.release();
    expect(await throwingRejectionOf(resetOwnedFixture(home, { root, owner: other }))).toThrow(
      'another owner',
    );
    expect(await readFile(join(home, 'sentinel'), 'utf8')).toBe('owned');
    await writeFile(join(outside, 'sentinel'), 'outside');
    await symlink(outside, join(root, 'link'));
    expect(
      await throwingRejectionOf(resetOwnedFixture(join(root, 'link'), { root, owner })),
    ).toThrow('symbolic links');
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('outside');
    const next = await resetOwnedFixture(home, { root, owner });
    next.release();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
