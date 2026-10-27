/**
 * A schedule fire in the real host runs once and ends normally. The fire is started by Weft's
 * scheduler poller on real elapsed time (a `1s` schedule on a one-second poll), so this is slow by
 * nature and lives in the `test:slow` lane (COR-1576).
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { awakeTurns } from '@lostgradient/testing/wait-until';
import { startHost, type Host } from './host.ts';

const homes: string[] = [];
const hosts: Host[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** The first scheduled run to reach a terminal state, with how it ended. */
async function firstFinishedFire(host: Host) {
  for await (const _ of awakeTurns()) {
    const runs = await host.bureau.tasks.workflows();
    for (const item of runs?.items ?? []) {
      const state = await host.bureau.tasks.workflow(item.id);
      if (state?.status === 'completed' || state?.status === 'failed') return state;
    }
    await Bun.sleep(50);
  }
  throw new Error('No scheduled run finished.');
}

test('a schedule fire runs once and ends normally, not at the step limit', async () => {
  const home = await mkdtemp(join(tmpdir(), 'interborough-fire-'));
  homes.push(home);
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    seed: false,
  });
  hosts.push(host);
  await host.bureau.schedules.create({
    description: 'Fires every second',
    agentName: 'assistant',
    input: 'Summarize.',
    spec: '1s',
  });

  const state = await firstFinishedFire(host);
  const result = state.result as { steps: number; finishReason: string };
  expect(state.status).toBe('completed');
  expect(result.steps).toBe(1);
  expect(result.finishReason).toBe('stop-condition');
});
