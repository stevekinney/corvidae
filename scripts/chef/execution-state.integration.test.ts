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

async function runClaim(stateDirectory: string, resource: string, runId: string, ownerId: string) {
  const modulePath = join(import.meta.dir, 'execution-state.ts');
  const program = `
    import { acquireDispatch, createExecutionStateStore } from ${JSON.stringify(modulePath)};
    const state = createExecutionStateStore({ stateDirectory: ${JSON.stringify(stateDirectory)}, hostId: 'host-a' });
    console.log(JSON.stringify(await acquireDispatch(state, { resource: ${JSON.stringify(resource)}, runId: ${JSON.stringify(runId)}, ownerId: ${JSON.stringify(ownerId)} })));
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
      runClaim(stateDirectory, 'issue:COR-1', 'run-a', 'owner-a'),
      runClaim(stateDirectory, 'issue:COR-1', 'run-b', 'owner-b'),
    ]);
    expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
    const outcomes = [first, second].map(
      ({ output }) => JSON.parse(output) as { granted: boolean },
    );
    expect(outcomes.filter((outcome) => outcome.granted)).toHaveLength(1);
  });

  // spawn-free: this isolated test starts hang-guarded coordinators on distinct resources.
  test('distinct resources preserve every granted ownership record in one shared snapshot', async () => {
    const stateDirectory = directory();
    const claims = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        runClaim(
          stateDirectory,
          `issue:COR-${index + 1}`,
          `run-${index + 1}`,
          `owner-${index + 1}`,
        ),
      ),
    );
    expect(claims.every((claim) => claim.exitCode === 0)).toBe(true);
    const snapshot = JSON.parse(
      await Bun.file(join(stateDirectory, 'execution-state.json')).text(),
    ) as { ownership: Record<string, unknown> };
    expect(Object.keys(snapshot.ownership)).toHaveLength(32);
  });
});
