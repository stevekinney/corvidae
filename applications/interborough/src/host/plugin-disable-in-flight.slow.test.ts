/**
 * COR-2235: disabling a plugin whose agents have runs in flight. The next start recovers the runs
 * while the plugin is off, so each settles failed naming `definition-drifted` (COR-2230), and runs
 * no step, instead of recovering to `missing-agent`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { awakeTurns } from '@lostgradient/testing/wait-until';

import { enableDemoPlugin, setPluginsEnabled } from './demo-plugin-home.ts';
import { startHost, type Host } from './host.ts';

const homes: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function waitForReview(host: Host, runId: string) {
  for await (const _ of awakeTurns()) {
    const review = host.bureau.reviews.list().find((candidate) => candidate.runId === runId);
    if (review !== undefined) return review;
    await Bun.sleep(5);
  }
  throw new Error(`No review was raised for run "${runId}".`);
}

describe('disabling a plugin that has a run in flight', () => {
  test('settles the run failed with definition-drifted after the restart, and not as missing-agent (COR-2235)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'interborough-disable-runs-'));
    homes.push(home);
    await enableDemoPlugin(home);
    const first = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
    hosts.push(first);
    await first.bureau.plugins.ready();
    const run = await first.bureau.tasks.start('demo:request-human-input', 'Ship it');
    await waitForReview(first, run.id);
    const parked = await first.bureau.tasks.get(run.id);
    expect(parked?.status).toBe('input-required');
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);

    // The restart the disable dialog asks for, with the plugin switched off.
    await setPluginsEnabled(home, { demo: false });
    const second = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
    hosts.push(second);

    const settled = await second.bureau.tasks.wait(run.id);
    expect(settled?.status).toBe('failed');
    const session = await second.bureau.contexts.get(run.contextId);
    expect(session?.metadata['lastRunStatus']).toBe('error');
    const lastError = session?.metadata['lastError'];
    const reason = typeof lastError === 'string' ? lastError : '';
    expect(reason).toContain('definition-drifted');
    expect(reason).toMatch(/its version was [\d.]+ and is now none/);
    expect(reason).not.toContain('no longer in the catalog');
    expect(second.bureau.reviews.list().filter((review) => review.runId === run.id)).toEqual([]);
  });
});
