/**
 * COR-2009 (`host:plugin-load-status`): a plugin that did not load needs attention, whoever skipped
 * it. The Bureau reports the plugins it skipped while composing; the host reports the ones it never
 * handed over (a folder whose code would not load, a plugin that declares a secret the host keeps),
 * and a plugin that only needs setup is never listed (Health, "A plugin that didn't load counts
 * under Needs attention").
 */
import type { BureauAttentionItem, BureauPluginEntry } from '@lostgradient/bureau';
import { definePlugin } from '@lostgradient/interborough-plugin';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';

const homes: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

function packagePlugin(
  name: string,
  extra: Partial<Parameters<typeof definePlugin>[0]> = {},
): BureauPluginEntry {
  return {
    descriptor: definePlugin({
      name,
      version: '1.0.0',
      description: `The ${name} plugin.`,
      ...extra,
    }),
    source: 'package',
    location: `@fixture/${name}`,
  };
}

async function writeFolderPlugin(home: string, folder: string, source: string): Promise<void> {
  const path = join(home, 'plugins', folder);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'plugin.ts'), source);
}

function notLoaded(items: readonly BureauAttentionItem[]) {
  return items
    .flatMap((item) => (item.kind === 'plugin-not-loaded' ? [item] : []))
    .toSorted((left, right) => left.plugin.localeCompare(right.plugin));
}

describe('Needs attention for plugins', () => {
  test('lists each plugin that did not load once, at the time the host loaded them, and never one that needs setup', async () => {
    const home = await mkdtemp(join(tmpdir(), 'interborough-plugin-attention-'));
    homes.push(home);
    await writeFolderPlugin(home, 'web-search', "throw new Error('nothing to see');\n");
    const before = Date.now();
    const host = await startHost({
      environment: { INTERBOROUGH_HOME: home },
      port: 0,
      log: () => undefined,
      plugins: [
        // Skipped by the Bureau: its setup throws.
        packagePlugin('flaky', {
          setup: () => {
            throw new Error('setup failed');
          },
        }),
        // Skipped by the host: it declares the host's own approval secret.
        packagePlugin('greedy', { secrets: ['approval-secret'] }),
        // Waits for a key: needs setup, and is not a problem to attend to.
        packagePlugin('keyed', { secrets: ['keyed-api-key'] }),
        packagePlugin('fine'),
      ],
    });
    hosts.push(host);

    const attention = await host.bureau.attention();
    const items = notLoaded(attention.items);
    expect(items.map(({ plugin, problems }) => ({ plugin, problems }))).toEqual([
      { plugin: 'flaky', problems: ['setup-failed'] },
      { plugin: 'greedy', problems: ['secret-refused'] },
      { plugin: 'web-search', problems: ['load-failed'] },
    ]);
    for (const item of items) {
      expect(item.area).toBe('plugins');
      expect(item.at).toBeGreaterThanOrEqual(before);
      expect(item.at).toBeLessThanOrEqual(Date.now());
    }
    const response = await fetch(new URL('/host/plugins', host.url));
    const plugins = (await response.json()) as {
      plugins: { descriptor: { name: string }; status: string }[];
    };
    expect(plugins.plugins.find((plugin) => plugin.descriptor.name === 'keyed')?.status).toBe(
      'needs-setup',
    );
  });

  test('lists nothing for plugins that all loaded or only need setup', async () => {
    const home = await mkdtemp(join(tmpdir(), 'interborough-plugin-attention-'));
    homes.push(home);
    const host = await startHost({
      environment: { INTERBOROUGH_HOME: home },
      port: 0,
      log: () => undefined,
      plugins: [packagePlugin('keyed', { secrets: ['keyed-api-key'] }), packagePlugin('fine')],
    });
    hosts.push(host);
    const attention = await host.bureau.attention();
    expect(notLoaded(attention.items)).toEqual([]);
  });
});
