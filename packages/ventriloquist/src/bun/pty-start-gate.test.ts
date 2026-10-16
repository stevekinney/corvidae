import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { describe, expect, test } from 'bun:test';
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  scenario,
  scenarioResult,
  settleScenarios,
  type Scenario,
} from './bun-process.test-support.ts';
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
function gateScenario(name: string, body: () => Promise<void> | void): Scenario {
  return scenario(name, async () => {
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
  const child = spawnWithHangGuard(gatedCommand(command, pair.slavePath), {
    stdio: gateStdio(slave),
    detached: true,
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

const scenario1 = gateScenario('the command does not run unless the gate is released', async () => {
  const marker = join(workspace(), 'ran');
  const { child, output, process } = spawnGated(['sh', '-c', `printf ran > '${marker}'`]);
  // Abandoning the gate is end of file on the release channel, which ends the shell without
  // running the command. The command running at all would leave the marker.
  expect(abandonGate(process)).toBe(true);
  expect(await child.exited).not.toBe(0);
  await output();
  expect(existsSync(marker)).toBe(false);
});

const scenario2 = gateScenario(
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

const scenario3 = gateScenario(
  'the command leads its session and its terminal is its controlling terminal',
  async () => {
    const { child, output, process } = spawnGated([
      'sh',
      '-c',
      'ps -o pid=,pgid=,tpgid= -p $$; (printf controlling > /dev/tty) 2>&1',
    ]);
    expect(releaseGate(process)).toBe(true);
    expect(await child.exited).toBe(0);
    const printed = await output();
    const text = printed.replace(/\r/g, '');
    // A process that leads its group, whose group is the terminal's foreground group, owns the terminal.
    const [pid, group, foreground] = text.trim().split(/\s+/);
    expect(Number(pid)).toBe(child.pid);
    expect(group).toBe(pid as string);
    expect(foreground).toBe(pid as string);
    expect(text).toContain('controlling');
  },
);

const scenario4 = gateScenario('the command does not see the release channel', async () => {
  const { child, output, process } = spawnGated([
    'sh',
    '-c',
    'if [ -e /dev/fd/3 ]; then printf open; else printf closed; fi',
  ]);
  releaseGate(process);
  await child.exited;
  expect(await output()).toBe('closed');
});

describe('the PTY start gate', () => {
  scenarioResult('the command does not run unless the gate is released', scenario1);

  scenarioResult(
    'the command runs once the gate is released, in the shell’s session and terminal',
    scenario2,
  );

  scenarioResult(
    'the command leads its session and its terminal is its controlling terminal',
    scenario3,
  );

  scenarioResult('the command does not see the release channel', scenario4);

  // spawn-free: the child is a plain object holding a descriptor, so only the closing runs.
  test('the release channel is closed once, however many times the gate is released or abandoned', () => {
    const channel = openSync('/dev/null', 'r');
    const child = {
      pid: 1,
      exited: Promise.resolve(0),
      signalCode: null,
      stdio: [null, null, null, channel],
      kill() {},
    };
    expect(abandonGate(child)).toBe(true);
    // The number is free now, and the next descriptor opened takes it; closing it again would close that one.
    const reused = openSync('/dev/null', 'r');
    try {
      expect(reused).toBe(channel);
      expect(abandonGate(child)).toBe(true);
      expect(releaseGate(child)).toBe(true);
      expect(() => fstatSync(reused)).not.toThrow();
    } finally {
      closeSync(reused);
    }
  });

  // spawn-free: the child is a plain object with no process behind it, so only the descriptor lookup runs.
  test('a child without the channel cannot be released or abandoned', () => {
    const bare = { pid: 1, exited: Promise.resolve(0), signalCode: null, kill() {} };
    expect(releaseGate(bare)).toBe(false);
    expect(abandonGate(bare)).toBe(false);
  });
});

await settleScenarios();
