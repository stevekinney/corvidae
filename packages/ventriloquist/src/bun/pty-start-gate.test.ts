import { SCENARIO_HANG_GUARD_MILLISECONDS } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scenarioTest, settleScenarios } from './bun-process.test-support.ts';
import type { SpawnedProcess } from './process-types.ts';
import { loadPtyDevice } from './pty-device.ts';
import { createPtyMaster } from './pty-master.ts';
import { abandonGate, gateStdio, gatedCommand, releaseGate } from './pty-start-gate.ts';

const directories: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];

function cleanUp(): void {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
}

/** A scenario that runs at module scope, then ends every child and removes every directory it made. */
function gateScenario(name: string, body: () => Promise<void> | void): void {
  scenarioTest(name, async () => {
    try {
      await body();
    } finally {
      cleanUp();
    }
  });
}

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ventriloquist-gate-'));
  directories.push(directory);
  return directory;
}

/**
 * Spawn a gated child on a terminal this test opened, as the PTY helper does, and read what it prints
 * once it has ended.
 */
function spawnGated(command: string[]) {
  const device = loadPtyDevice();
  const pair = device.open();
  const slave = device.openSlave(pair.slavePath);
  device.setWindowSize(pair, 80, 24);
  const child = Bun.spawn(gatedCommand(command, pair.slavePath), {
    stdio: gateStdio(slave),
    detached: true,
    timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
  });
  device.close(slave);
  children.push(child);
  const master = createPtyMaster({
    descriptor: pair.masterFd,
    device,
    endsWithIo: process.platform === 'linux',
  });
  /** Everything the child printed, read to the end of the terminal. */
  const output = async (): Promise<string> => {
    const reader = master.stream.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (let result = await reader.read(); !result.done; result = await reader.read()) {
      text += decoder.decode(result.value, { stream: true });
    }
    await master.stop();
    master.close();
    return text;
  };
  return { child, output, process: child as unknown as SpawnedProcess };
}

describe('the PTY start gate', () => {
  gateScenario('the command does not run unless the gate is released', async () => {
    const marker = join(workspace(), 'ran');
    const { child, output, process } = spawnGated(['sh', '-c', `printf ran > '${marker}'`]);
    // Abandoning the gate is end of file on the release channel, which ends the shell without
    // running the command. The command running at all would leave the marker.
    expect(abandonGate(process)).toBe(true);
    expect(await child.exited).not.toBe(0);
    await output();
    expect(existsSync(marker)).toBe(false);
  });

  gateScenario(
    'the command runs once the gate is released, in the shell’s session and terminal',
    async () => {
      const { child, output, process } = spawnGated([
        'sh',
        '-c',
        'tty; printf "pid=%s" "$$"; ps -o pgid= -p $$',
      ]);
      expect(releaseGate(process)).toBe(true);
      expect(await child.exited).toBe(0);
      const text = await output();
      expect(text).toMatch(/\/dev\/\S+/);
      expect(text).toContain(`pid=${child.pid}`);
      expect(text.replace(/\s+/g, ' ')).toContain(`${child.pid} `);
    },
  );

  gateScenario(
    'the command leads its session and its terminal is its controlling terminal',
    async () => {
      const { child, output, process } = spawnGated([
        'sh',
        '-c',
        'ps -o pid=,pgid=,tpgid= -p $$; (printf controlling > /dev/tty) 2>&1',
      ]);
      expect(releaseGate(process)).toBe(true);
      expect(await child.exited).toBe(0);
      const text = (await output()).replace(/\r/g, '');
      // A process that leads its group, whose group is the terminal's foreground group, owns the terminal.
      const [pid, group, foreground] = text.trim().split(/\s+/);
      expect(Number(pid)).toBe(child.pid);
      expect(group).toBe(pid as string);
      expect(foreground).toBe(pid as string);
      expect(text).toContain('controlling');
    },
  );

  gateScenario('the command does not see the release channel', async () => {
    const { child, output, process } = spawnGated([
      'sh',
      '-c',
      'if [ -e /dev/fd/3 ]; then printf open; else printf closed; fi',
    ]);
    releaseGate(process);
    await child.exited;
    expect(await output()).toBe('closed');
  });

  // spawn-free: the child is a plain object with no process behind it, so only the descriptor lookup runs.
  test('a child without the channel cannot be released or abandoned', () => {
    const bare = { pid: 1, exited: Promise.resolve(0), signalCode: null, kill() {} };
    expect(releaseGate(bare)).toBe(false);
    expect(abandonGate(bare)).toBe(false);
  });
});

await settleScenarios();
