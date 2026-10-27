/**
 * COR-1711 — the host's runtime settings: a person's host locks none, and a host started with
 * `settings.locked` holds those keys to their code options, which the settings page shows read-only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host, type HostOptions } from './host.ts';

const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function start(options: Pick<HostOptions, 'settings'>) {
  const home = await mkdtemp(join(tmpdir(), 'interborough-settings-'));
  directories.push(home);
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0, ...options });
  hosts.push(host);
  return host;
}

describe('the host’s settings', () => {
  test('lock no key by default, and persist the record in the host’s database', async () => {
    const host = await start({});

    const snapshot = await host.bureau.settings.get();
    expect(snapshot.persisted).toBe(true);
    expect(Object.values(snapshot.keys).filter((state) => state.locked)).toEqual([]);
  });

  test('hold a locked key to its code option, and refuse a change to it', async () => {
    const host = await start({ settings: { locked: ['workflowVersion'] } });

    const snapshot = await host.bureau.settings.get();
    expect(snapshot.keys['workflowVersion']?.locked).toBe(true);
    expect(snapshot.keys['tools.wakeup']?.locked).toBe(false);
    const refused = await host.bureau.settings.update(
      { workflowVersion: 'v2' },
      { expectedRevision: snapshot.revision },
    );
    expect(refused).toMatchObject({ outcome: 'rejected', reason: 'locked' });
  });
});
