import { expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import { findLockProcesses, findWorktreeProcesses, processIsAlive, run } from './leftovers.ts';
import { createScenarios } from './scenario.test-support.ts';

/**
 * Real processes: each scenario starts a child, looks it up through the real `lsof`, `pgrep` and
 * `kill -0`, and kills it in `tearDown`. They run at module scope in the slow lane because a child
 * boot and an `lsof +D` walk do not belong on the five-second per-test clock.
 */

let sandbox = '';
const children: ReturnType<typeof spawnWithHangGuard>[] = [];

const scenarios = createScenarios({
  setUp() {
    sandbox = mkdtempSync(join(tmpdir(), 'leftovers-'));
  },
  async tearDown() {
    for (const child of children.splice(0)) {
      child.kill();
      await child.exited;
    }
    rmSync(sandbox, { recursive: true, force: true });
  },
});

async function settleAfterSpawn(): Promise<void> {
  await Bun.sleep(200);
}

scenarios.scenario(
  'findWorktreeProcesses sees a process whose cwd is inside the directory',
  async () => {
    const child = spawnWithHangGuard(['sleep', '30'], { cwd: sandbox });
    children.push(child);
    await settleAfterSpawn();
    const found = findWorktreeProcesses(sandbox);
    expect(found.map((item) => item.pid)).toContain(child.pid);
    expect(found.find((item) => item.pid === child.pid)?.command).toBe('sleep');
  },
);

scenarios.scenario(
  'findWorktreeProcesses sees a process with an open file inside the directory',
  async () => {
    const file = join(sandbox, 'held.txt');
    writeFileSync(file, 'x');
    const child = spawnWithHangGuard(['sh', '-c', `exec tail -f ${file}`], { cwd: '/' });
    children.push(child);
    await settleAfterSpawn();
    expect(findWorktreeProcesses(sandbox).map((item) => item.pid)).toContain(child.pid);
  },
);

scenarios.scenario('an empty directory reports nothing', () => {
  expect(findWorktreeProcesses(sandbox)).toEqual([]);
});

scenarios.scenario('findLockProcesses matches a process by command line', async () => {
  const token = `leftovers-token-${process.pid}-${Date.now()}`;
  const child = spawnWithHangGuard(['sh', '-c', 'read line', token], { stdin: 'pipe' });
  children.push(child);
  await settleAfterSpawn();
  expect(findLockProcesses(`read line ${token}`).map((item) => item.pid)).toContain(child.pid);
  expect(findLockProcesses(`no-such-${token}`)).toEqual([]);
});

scenarios.scenario("processIsAlive follows a child's life", async () => {
  const child = spawnWithHangGuard(['sleep', '30']);
  children.push(child);
  expect(processIsAlive(child.pid)).toBe(true);
  child.kill();
  await child.exited;
  expect(processIsAlive(child.pid)).toBe(false);
});

scenarios.scenario('run exits 1 and names the process when a PID is alive', () => {
  const child = spawnWithHangGuard(['sleep', '30']);
  children.push(child);
  const result = run(['--pids', String(child.pid), '--json'], {
    runner: () => ({ code: 1, stdout: '', stderr: '' }),
  });
  expect(result.code).toBe(1);
  expect(JSON.parse(result.output).pids).toEqual([{ pid: child.pid, alive: true }]);
});

await scenarios.settled();
