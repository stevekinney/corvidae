import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnWithHangGuard } from '../../testing/testing/src/hang-guard.ts';

const directories: string[] = [];

function directory() {
  const value = mkdtempSync(join(tmpdir(), 'execution-state-integration-'));
  directories.push(value);
  return value;
}

afterEach(() => {
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
});

async function runClaim(stateDirectory: string, runId: string, ownerId: string) {
  const modulePath = join(import.meta.dir, 'execution-state.ts');
  const program = `
    import { acquireDispatch, createExecutionStateStore } from ${JSON.stringify(modulePath)};
    const state = createExecutionStateStore({ stateDirectory: ${JSON.stringify(stateDirectory)}, hostId: 'host-a' });
    console.log(JSON.stringify(await acquireDispatch(state, { resource: 'issue:COR-1', runId: ${JSON.stringify(runId)}, ownerId: ${JSON.stringify(ownerId)} })));
  `;
  const child = spawnWithHangGuard(['bun', '--eval', program], { stdout: 'pipe', stderr: 'pipe' });
  const exitCode = await child.exited;
  const stdout = await new Response(child.stdout).text();
  return { exitCode, output: stdout.trim() };
}

describe('execution state across coordinator processes', () => {
  // spawn-free: this isolated test starts two hang-guarded Bun coordinators at module behavior boundary.
  test('two subprocess coordinators race for one resource and one receives authority', async () => {
    const stateDirectory = directory();
    const [first, second] = await Promise.all([
      runClaim(stateDirectory, 'run-a', 'owner-a'),
      runClaim(stateDirectory, 'run-b', 'owner-b'),
    ]);
    expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
    const outcomes = [first, second].map(
      ({ output }) => JSON.parse(output) as { granted: boolean },
    );
    expect(outcomes.filter((outcome) => outcome.granted)).toHaveLength(1);
  });
});
