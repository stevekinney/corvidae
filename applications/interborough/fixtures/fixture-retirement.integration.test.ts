import { afterAll, expect, test } from 'bun:test';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnPipedWithHangGuard } from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { resetOwnedFixture } from './fixture-ownership.ts';

const roots: string[] = [];
async function interrupt(phase: 'pending' | 'partial') {
  const root = mkdtempSync(join(tmpdir(), 'fixture-retirement-'));
  roots.push(root);
  const home = join(root, 'home');
  const sibling = join(root, 'sibling');
  const siblingLease = await resetOwnedFixture(sibling, { root, owner: root });
  siblingLease.release();
  writeFileSync(join(sibling, 'sentinel'), 'sibling intact');
  if (phase === 'partial') {
    const lease = await resetOwnedFixture(home, { root, owner: root });
    lease.release();
    mkdirSync(join(home, 'nested'));
    writeFileSync(join(home, 'nested', 'one'), 'one');
    writeFileSync(join(home, 'nested', 'two'), 'two');
  }
  const owner = spawnPipedWithHangGuard([
    process.execPath,
    join(import.meta.dir, 'fixture-retirement.test-support.ts'),
    root,
    phase,
  ]);
  void new Response(owner.stdout).text();
  void new Response(owner.stderr).text();
  let stopped = false;
  try {
    await waitUntil(() => existsSync(join(root, 'phase-ready')), {
      message: `fixture ${phase} phase`,
    });
    const homeInode = statSync(home).ino;
    const lockPath = join(home, 'lock');
    const lockInode = existsSync(lockPath) ? statSync(lockPath).ino : undefined;
    owner.kill('SIGKILL');
    const code = await owner.exited;
    stopped = true;
    let pendingLink: string | undefined;
    if (phase === 'pending') {
      const markerDirectory = join(root, '.fixture-owners');
      const markerName = readdirSync(markerDirectory).find((entry) => {
        const marker = JSON.parse(readFileSync(join(markerDirectory, entry), 'utf8')) as {
          state: string;
        };
        return marker.state === 'pending';
      });
      if (markerName === undefined) throw new Error('The pending marker was not found.');
      pendingLink = join(markerDirectory, `${markerName}.interrupted`);
      linkSync(join(markerDirectory, markerName), pendingLink);
    }
    const recovered = await resetOwnedFixture(home, { root, owner: root });
    const recoveredHome = statSync(home).ino;
    const recoveredLock = statSync(lockPath).ino;
    recovered.release();
    const repeated = await resetOwnedFixture(home, { root, owner: root });
    repeated.release();
    return {
      code,
      homeInode,
      lockInode,
      recoveredHome,
      recoveredLock,
      sibling: readFileSync(join(sibling, 'sentinel'), 'utf8'),
      nestedExists: existsSync(join(home, 'nested')),
      pendingLinkRemains: pendingLink !== undefined && existsSync(pendingLink),
    };
  } finally {
    if (!stopped) owner.kill('SIGKILL');
  }
}

const pending = await interrupt('pending');
const partial = await interrupt('partial');
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('a killed pending initializer resumes only its own empty inode', () => {
  expect(pending.code).not.toBe(0);
  expect(pending.recoveredHome).toBe(pending.homeInode);
  expect(pending.sibling).toBe('sibling intact');
  expect(pending.pendingLinkRemains).toBe(false);
});

test('a killed partial reset converges on replay without touching its sibling', () => {
  expect(partial.code).not.toBe(0);
  expect(partial.recoveredHome).toBe(partial.homeInode);
  if (partial.lockInode === undefined) throw new Error('The original lock inode was not recorded.');
  expect(partial.recoveredLock).toBe(partial.lockInode);
  expect(partial.nestedExists).toBe(false);
  expect(partial.sibling).toBe('sibling intact');
});
