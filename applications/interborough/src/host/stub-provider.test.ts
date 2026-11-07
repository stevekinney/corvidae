/**
 * `writeProviderHome` sets the provider's models and keeps what else the home's configuration
 * holds. The end-to-end server once wrote the provider after turning the demo plugin on, which
 * replaced the file and left a host without `demo:echo` or `demo:tool-runner`, so the notification
 * bell's specification started approvals and questions that no agent could start.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bindHome, enableDemoPlugin } from './demo-plugin-home.ts';
import { writeProviderHome } from './stub-provider.ts';

const homes: string[] = [];

async function newHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-stub-provider-'));
  homes.push(home);
  return home;
}

async function configurationOf(home: string): Promise<{
  plugins: Record<string, { enabled?: boolean; configuration?: { models?: string[] } }>;
}> {
  return JSON.parse(await readFile(join(home, 'configuration.json'), 'utf8'));
}

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

describe('writeProviderHome', () => {
  test('keeps the demo plugin on when the provider is written after it was enabled', async () => {
    const home = await newHome();
    await enableDemoPlugin(home);

    await writeProviderHome(home, ['sonnet', 'haiku']);

    const { plugins } = await configurationOf(home);
    expect(plugins['demo']?.enabled).toBe(true);
    expect(plugins['anthropic']?.configuration?.models).toEqual(['sonnet', 'haiku']);
  });

  test('is kept by enabling the demo plugin afterwards, in either order', async () => {
    const home = await newHome();
    await bindHome(home);
    await writeProviderHome(home);
    await enableDemoPlugin(home);

    const { plugins } = await configurationOf(home);
    expect(plugins['demo']?.enabled).toBe(true);
    expect(plugins['anthropic']?.configuration?.models).toEqual(['sonnet']);
  });

  test('replaces its own earlier models rather than adding to them', async () => {
    const home = await newHome();
    await bindHome(home);
    await writeProviderHome(home, ['sonnet', 'haiku']);

    await writeProviderHome(home, ['opus']);

    const { plugins } = await configurationOf(home);
    expect(plugins['anthropic']?.configuration?.models).toEqual(['opus']);
  });
});
