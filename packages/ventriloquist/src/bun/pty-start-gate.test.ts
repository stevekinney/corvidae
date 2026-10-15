import { SCENARIO_HANG_GUARD_MILLISECONDS } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scenarioTest, settleScenarios } from './bun-process.test-support.ts';
import type { SpawnedProcess } from './process-types.ts';
import { GATE_STDIO, abandonGate, gatedCommand, releaseGate } from './pty-start-gate.ts';

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

/** Spawn a gated child on a terminal, as the PTY helper does, collecting what it prints. */
function spawnGated(command: string[]) {
  const output: string[] = [];
  const child = Bun.spawn(gatedCommand(command), {
    stdio: GATE_STDIO as never,
    timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
    terminal: {
      cols: 80,
      rows: 24,
      data: (_terminal: unknown, bytes: Uint8Array) => output.push(new TextDecoder().decode(bytes)),
    },
  });
  children.push(child);
  return { child, output, process: child as unknown as SpawnedProcess };
}

describe('the PTY start gate', () => {
  gateScenario('the command does not run unless the gate is released', async () => {
    const marker = join(workspace(), 'ran');
    const { child, process } = spawnGated(['sh', '-c', `printf ran > '${marker}'`]);
    // Abandoning the gate is end of file on the release channel, which ends the shell without
    // running the command. The command running at all would leave the marker.
    expect(abandonGate(process)).toBe(true);
    expect(await child.exited).not.toBe(0);
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
      const text = output.join('');
      expect(text).toMatch(/\/dev\/\S+/);
      expect(text).toContain(`pid=${child.pid}`);
      expect(text.replace(/\s+/g, ' ')).toContain(`${child.pid} `);
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
    expect(output.join('')).toBe('closed');
  });

  // spawn-free: the child is a plain object with no process behind it, so only the descriptor lookup runs.
  test('a child without the channel cannot be released or abandoned', () => {
    const bare = { pid: 1, exited: Promise.resolve(0), signalCode: null, kill() {} };
    expect(releaseGate(bare)).toBe(false);
    expect(abandonGate(bare)).toBe(false);
  });
});

await settleScenarios();
