/**
 * COR-2180: the hooks a plugin declares in its descriptor are default hooks of the host's Bureau.
 * Starting the host with the plugin enabled makes them, a restart with the plugin disabled leaves
 * them as they were (they run nothing, because no reaction is registered), and a restart that no
 * longer gives the plugin to the host withdraws them, never deletes them. Each test starts the real
 * host on its own home.
 */
import type { BureauPluginEntry } from '@lostgradient/bureau';
import { definePlugin } from '@lostgradient/interborough-plugin';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { startHost, type Host } from './host.ts';

const homes: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** A package plugin with one reaction and the hooks `hooks` declares, as a host loads it. */
function pager(hooks: readonly { name: string; configuration?: unknown }[]): BureauPluginEntry {
  const descriptor = definePlugin({
    name: 'pager',
    version: '1.0.0',
    description: 'Pages someone.',
    hooks: hooks.map(({ name, configuration }) => ({
      name,
      events: ['run.settled'],
      reaction: 'page',
      ...(configuration === undefined ? {} : { configuration }),
    })),
    setup: () => ({
      reactions: [
        {
          name: 'page',
          description: 'Pages a team.',
          configuration: z.object({ team: z.string() }),
          run: async () => undefined,
        },
      ],
    }),
  });
  return { descriptor, source: 'package', location: '@example/pager' };
}

async function start(home: string, plugins: readonly BureauPluginEntry[]): Promise<Host> {
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0, plugins });
  hosts.push(host);
  return host;
}

async function close(host: Host): Promise<void> {
  await host.close();
  hosts.splice(hosts.indexOf(host), 1);
}

/** What the hooks of `host` are: name, whether each fires, and where it comes from. */
async function hooksOf(host: Host) {
  const listed = (await host.bureau.hooks?.list()) ?? [];
  return listed.map(({ name, enabled, declaredBy }) => ({ name, enabled, declaredBy }));
}

describe('the hooks a plugin declares (COR-2180)', () => {
  test('enabling the plugin makes them, and a restart reconciles them with the descriptor', async () => {
    const home = await mkdtemp(join(tmpdir(), 'interborough-plugin-hooks-'));
    homes.push(home);
    const first = await start(home, [
      pager([{ name: 'Page on settle', configuration: { team: 'a' } }]),
    ]);
    expect(await hooksOf(first)).toEqual([
      { name: 'Page on settle', enabled: true, declaredBy: { plugin: 'pager' } },
    ]);
    const [before] = (await first.bureau.hooks?.list()) ?? [];
    await close(first);

    // The next release changes the hook's configuration and adds one: the changed one is replaced
    // in place, and the new one is made.
    const second = await start(home, [
      pager([
        { name: 'Page on settle', configuration: { team: 'b' } },
        { name: 'Page again', configuration: { team: 'b' } },
      ]),
    ]);
    const listed = (await second.bureau.hooks?.list()) ?? [];
    expect(
      listed.map(({ name }) => name ?? '').toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(['Page again', 'Page on settle']);
    // A changed declaration replaces the hook in place.
    expect(listed.find(({ name }) => name === 'Page on settle')?.id).toBe(before?.id);
    await close(second);

    // The release after drops the first hook: it is withdrawn and kept.
    const third = await start(home, [
      pager([{ name: 'Page again', configuration: { team: 'b' } }]),
    ]);
    expect(await hooksOf(third)).toEqual([
      { name: 'Page on settle', enabled: false, declaredBy: { plugin: 'pager', withdrawn: true } },
      { name: 'Page again', enabled: true, declaredBy: { plugin: 'pager' } },
    ]);
  });

  test('disabling the plugin leaves them as they are, and removing it withdraws them, never deletes them', async () => {
    const home = await mkdtemp(join(tmpdir(), 'interborough-plugin-hooks-off-'));
    homes.push(home);
    const entry = pager([{ name: 'Page on settle', configuration: { team: 'a' } }]);
    const first = await start(home, [entry]);
    expect(await hooksOf(first)).toHaveLength(1);

    const snapshot = await first.plugins.snapshot();
    const disabled = await fetch(new URL('/host/plugins/pager', first.url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: false,
        operationId: crypto.randomUUID(),
        expectedRevision: snapshot.configurationRevision,
      }),
    });
    expect(disabled.status).toBe(200);
    await close(first);

    // Disabled: the plugin is not running, so nothing reconciles, and an empty list never says so.
    const second = await start(home, [entry]);
    expect(await hooksOf(second)).toEqual([
      { name: 'Page on settle', enabled: true, declaredBy: { plugin: 'pager' } },
    ]);
    const secondPlugins = await second.bureau.plugins.list();
    const listing = secondPlugins.find(({ descriptor }) => descriptor.name === 'pager');
    expect(listing?.status).toBe('disabled');
    await close(second);

    // Removed: the host gives the Bureau no such plugin, so its hooks are withdrawn.
    const third = await start(home, []);
    expect(await hooksOf(third)).toEqual([
      { name: 'Page on settle', enabled: false, declaredBy: { plugin: 'pager', withdrawn: true } },
    ]);
  });

  test('a hook the plugin declares badly is skipped alone: the plugin runs and lists the problem', async () => {
    const home = await mkdtemp(join(tmpdir(), 'interborough-plugin-hooks-bad-'));
    homes.push(home);
    const host = await start(home, [
      pager([
        { name: 'Page on settle', configuration: { team: 'a' } },
        { name: 'Wrong configuration', configuration: { team: 7 } },
      ]),
    ]);

    const hosted = await hooksOf(host);
    expect(hosted.map(({ name }) => name)).toEqual(['Page on settle']);
    const hostedPlugins = await host.bureau.plugins.list();
    const listing = hostedPlugins.find(({ descriptor }) => descriptor.name === 'pager');
    expect(listing?.status).toBe('running');
    expect(listing?.problems).toEqual([
      { code: 'hook-invalid', hook: 'Wrong configuration', path: 'configuration' },
    ]);
  });
});
