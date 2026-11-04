import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';

const homes: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

describe('workspace runtime identity', () => {
  test('keeps the workspace memory tenant stable while runtime instances change', async () => {
    const home = await mkdtemp(join(tmpdir(), 'interborough-workspace-'));
    homes.push(home);

    const first = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
    hosts.push(first);
    expect(first.workspaceId).toBe(first.deploymentId);
    expect(first.bureau.id).toBe(first.workspaceId);
    const firstRuntime = first.runtimeInstanceId;
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);

    const second = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
    hosts.push(second);
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.bureau.id).toBe(first.bureau.id);
    expect(second.runtimeInstanceId).not.toBe(firstRuntime);
  });

  test('keeps two homes isolated when names overlap, and closing B leaves A usable', async () => {
    const homeA = await mkdtemp(join(tmpdir(), 'interborough-workspace-a-'));
    const homeB = await mkdtemp(join(tmpdir(), 'interborough-workspace-b-'));
    homes.push(homeA, homeB);
    const [hostA, hostB] = await Promise.all([
      startHost({ environment: { INTERBOROUGH_HOME: homeA }, port: 0 }),
      startHost({ environment: { INTERBOROUGH_HOME: homeB }, port: 0 }),
    ]);
    hosts.push(hostA, hostB);

    expect(hostA.workspaceId).not.toBe(hostB.workspaceId);
    expect(hostA.database).not.toEqual(hostB.database);
    expect(hostA.bureau.id).not.toBe(hostB.bureau.id);

    await hostB.close();
    hosts.splice(hosts.indexOf(hostB), 1);
    expect(hostA.bureau.lifecycle).toBe('ready');
    expect(hostA.bureau.id).toBe(hostA.workspaceId);
  });
});
