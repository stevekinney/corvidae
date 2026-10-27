import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openBungalow } from '@lostgradient/bungalow';

import { startHost, type Host } from './host.ts';

const homes: string[] = [];
const hosts: Host[] = [];

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-host-'));
  homes.push(home);
  return home;
}

async function start(home: string): Promise<Host> {
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
  hosts.push(host);
  return host;
}

async function stop(host: Host): Promise<void> {
  hosts.splice(hosts.indexOf(host), 1);
  await host.close();
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

describe('the Interborough host', () => {
  it('binds to loopback and opens its state through Bungalow', async () => {
    const home = await createHome();
    const host = await start(home);

    expect(host.url.hostname).toBe('127.0.0.1');
    expect(host.databasePath).toBe(join(home, 'database.sqlite'));
    await stop(host);

    // Bungalow's lock is released on close, so the same root opens again.
    const bungalow = openBungalow({
      name: 'interborough',
      environment: { INTERBOROUGH_HOME: home },
    });
    expect(bungalow.database).toBe(join(home, 'database.sqlite'));
    bungalow.close();
  });

  it('keeps its runs, its sessions, and its seeded schedule across a restart', async () => {
    const home = await createHome();

    const first = await start(home);
    const run = await first.bureau.tasks.start('assistant', 'Remember this run.');
    await run.result();
    const runsBefore = await first.bureau.tasks.workflows();
    const runIds = runsBefore?.items.map((item) => item.id) ?? [];
    expect(runIds.length).toBeGreaterThan(0);
    const schedulesBefore = await first.bureau.schedules.list();
    const scheduleIds = schedulesBefore?.items.map((schedule) => schedule.id) ?? [];
    expect(scheduleIds).toHaveLength(1);
    await stop(first);

    const second = await start(home);
    // Only the database explains these: the host rebuilt the agents, and kept nothing in memory.
    expect(second.bureau.id).toBe(second.deploymentId);
    const runsAfter = await second.bureau.tasks.workflows();
    expect(runsAfter?.items.map((item) => item.id)).toEqual(expect.arrayContaining(runIds));
    for (const id of runIds) {
      const state = await second.bureau.tasks.workflow(id);
      expect(state?.status, id).toBe('completed');
    }
    const schedulesAfter = await second.bureau.schedules.list();
    expect(schedulesAfter?.items.map((schedule) => schedule.id)).toEqual(scheduleIds);
  });

  it('keeps one identity: the Bureau’s id is Bungalow’s deployment id, and survives', async () => {
    const home = await createHome();
    const first = await start(home);
    const identity = first.deploymentId;
    expect(first.bureau.id).toBe(identity);
    await stop(first);
    const second = await start(home);
    expect(second.deploymentId).toBe(identity);
    expect(second.bureau.id).toBe(identity);
  });
});
