import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { lockFixtureRoot, resetPinnedDirectory } from './fixture-directory.ts';

test('retains the home and lock inodes while resetting an owned directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-directory-'));
  try {
    const home = join(root, 'home');
    mkdirSync(home);
    const first = await resetPinnedDirectory(root, 'home');
    const inode = statSync(join(home, 'lock')).ino;
    const homeInode = statSync(home).ino;
    first.release();
    writeFileSync(join(home, 'old'), 'old');
    const second = await resetPinnedDirectory(root, 'home');
    expect(statSync(join(home, 'lock')).ino).toBe(inode);
    expect(statSync(home).ino).toBe(homeInode);
    expect(() => readFileSync(join(home, 'old'))).toThrow();
    second.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a root and the same directory as a home contend on the same lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-directory-'));
  try {
    const home = join(root, 'home');
    mkdirSync(home);
    const lease = await lockFixtureRoot(home);
    try {
      expect(await throwingRejectionOf(resetPinnedDirectory(root, 'home'))).toThrow();
    } finally {
      lease.release();
    }
    const reset = await resetPinnedDirectory(root, 'home');
    reset.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a target swapped for an escaping link and restores that link', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-directory-'));
  const outside = mkdtempSync(join(tmpdir(), 'fixture-outside-'));
  try {
    const home = join(root, 'home');
    const original = join(root, 'original');
    mkdirSync(home);
    writeFileSync(join(home, 'sentinel'), 'inside');
    writeFileSync(join(outside, 'sentinel'), 'outside');
    expect(
      await throwingRejectionOf(
        resetPinnedDirectory(root, 'home', () => {
          renameSync(home, original);
          symlinkSync(outside, home);
        }),
      ),
    ).toThrow('changed during reset');
    expect(readFileSync(join(original, 'sentinel'), 'utf8')).toBe('inside');
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('outside');
    expect(readFileSync(join(home, 'sentinel'), 'utf8')).toBe('outside');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a partial nested reset can be repeated without changing the home or lock inode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-directory-'));
  try {
    const home = join(root, 'home');
    mkdirSync(home);
    const initial = await resetPinnedDirectory(root, 'home');
    initial.release();
    mkdirSync(join(home, 'nested'));
    writeFileSync(join(home, 'nested', 'first'), 'one');
    writeFileSync(join(home, 'nested', 'second'), 'two');
    const inode = statSync(join(home, 'lock')).ino;
    const homeInode = statSync(home).ino;
    expect(
      await throwingRejectionOf(
        resetPinnedDirectory(root, 'home', undefined, undefined, undefined, () => {
          throw new Error('interrupted reset');
        }),
      ),
    ).toThrow('interrupted reset');
    expect(statSync(join(home, 'lock')).ino).toBe(inode);
    const next = await resetPinnedDirectory(root, 'home');
    expect(statSync(home).ino).toBe(homeInode);
    expect(() => statSync(join(home, 'nested'))).toThrow();
    next.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('removes a link inside the owned home without traversing its target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-directory-'));
  const outside = mkdtempSync(join(tmpdir(), 'fixture-outside-'));
  try {
    const home = join(root, 'home');
    mkdirSync(home);
    writeFileSync(join(outside, 'sentinel'), 'outside');
    symlinkSync(outside, join(home, 'link'));
    const lease = await resetPinnedDirectory(root, 'home');
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('outside');
    expect(() => statSync(join(home, 'link'))).toThrow();
    lease.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('refuses to hand off a lease if the home changes during the walk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-directory-'));
  const outside = mkdtempSync(join(tmpdir(), 'fixture-outside-'));
  try {
    const home = join(root, 'home');
    mkdirSync(home);
    writeFileSync(join(home, 'owned'), 'owned');
    writeFileSync(join(outside, 'sentinel'), 'outside');
    expect(
      await throwingRejectionOf(
        resetPinnedDirectory(root, 'home', undefined, undefined, undefined, () => {
          renameSync(home, join(root, 'original'));
          symlinkSync(outside, home);
        }),
      ),
    ).toThrow('changed during reset');
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('outside');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
