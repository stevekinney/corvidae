/**
 * COR-2101 — a formatter may list only event kinds Bureau publishes, and the plugin README's
 * examples name only such kinds.
 */
import { definePlugin, type PluginDescriptor } from '@lostgradient/interborough-plugin';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from '../agent-catalog';
import { BUREAU_EVENT_CATALOG } from '../bureau-event-catalog';
import { createBureau } from '../create-bureau';
import { listedPlugins } from '../testing/plugin-listing.test-support';
import type { Bureau } from '../bureau-types/facade';

const bureaus: Bureau<AgentDefinitions>[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

async function listFormatting(eventKinds: readonly string[]) {
  const descriptor: PluginDescriptor<z.ZodType> = definePlugin({
    name: 'formatting',
    version: '1.0.0',
    description: 'Formats events.',
    setup: () => ({
      formatters: [{ name: 'runs', eventKinds, format: () => ({ title: 'run' }) }],
    }),
  });
  const bureau = await createBureau<AgentDefinitions>({
    plugins: [{ descriptor, source: 'package', location: '@example/formatting' }],
  });
  bureaus.push(bureau);
  await bureau.plugins.ready();
  const [listing] = await listedPlugins(bureau);
  return listing;
}

describe('formatter event kinds', () => {
  it('skips a plugin whose formatter lists a kind Bureau never publishes', async () => {
    const listing = await listFormatting(['run.settled', 'run.nonexistent']);
    expect(listing?.status).toBe('skipped');
    expect(listing?.problems).toEqual([
      { code: 'formatter-unknown-kind', formatter: 'runs', kind: 'run.nonexistent' },
    ]);
  });

  it('composes a plugin whose formatter lists only catalog kinds', async () => {
    const listing = await listFormatting(['run.settled']);
    expect(listing?.status).toBe('running');
  });

  it('names only catalog kinds in the README code fences', async () => {
    const readme = await Bun.file(
      new URL('../../../interborough-plugin/README.md', import.meta.url),
    ).text();
    const kinds: string[] = [];
    for (const fence of readme.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)) {
      for (const array of (fence[1] ?? '').matchAll(
        /\b(?:eventKinds|events)\s*:\s*\[([^\]]*)\]/gu,
      )) {
        for (const literal of (array[1] ?? '').matchAll(/(['"`])((?:(?!\1).)*)\1/gu)) {
          kinds.push(literal[2] ?? '');
        }
      }
    }
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) expect(Object.hasOwn(BUREAU_EVENT_CATALOG, kind)).toBe(true);
  });
});
