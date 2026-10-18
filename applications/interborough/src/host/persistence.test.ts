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

  it('keeps tasks and the Bureau identity across a restart, and seeds only once', async () => {
    const home = await createHome();

    const first = await start(home);
    const bureauId = first.bureau.id;
    const run = first.bureau.run('assistant', 'Remember this run.');
    await run.result();
    const before = await first.bureau.listDurableRuns();
    expect(before?.total).toBeGreaterThan(0);
    const schedulesBefore = await first.bureau.listSchedules();
    await stop(first);

    const second = await start(home);
    expect(second.bureau.id).toBe(bureauId);
    expect(second.bureau.id).toBe(second.deploymentId);
    const after = await second.bureau.listDurableRuns();
    expect(after?.items.map((item) => item.id)).toEqual(
      expect.arrayContaining(before?.items.map((item) => item.id) ?? []),
    );
    for (const name of ['assistant', 'tool-runner', 'request-human-input', 'internal']) {
      expect(second.bureau.agents.has(name)).toBe(true);
    }
    const schedulesAfter = await second.bureau.listSchedules();
    expect(schedulesAfter?.total).toBe(schedulesBefore?.total);
    expect(schedulesBefore?.total).toBe(1);
  });
});
