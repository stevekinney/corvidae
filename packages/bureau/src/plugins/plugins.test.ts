/**
 * COR-1879 — `createBureau({ plugins, pluginConfiguration, pluginSecrets })`: setup in load order,
 * the configuration and clash checks, storage scoping, `afterStart`, and `plugins.list()`.
 */
import { definePlugin, type PluginDescriptor } from '@lostgradient/interborough-plugin';
import { MemoryStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createTool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from '../agent-catalog';
import { createBureau } from '../create-bureau';
import { agentFileDirectory } from '../sources/agent-file-directory';
import type { Bureau, BureauOptions } from '../types';
import type { BureauPluginEntry } from './plugin-types';

const bureaus: Bureau<AgentDefinitions>[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

async function start(options: Partial<BureauOptions<AgentDefinitions>>) {
  const bureau = await createBureau<AgentDefinitions>(options);
  bureaus.push(bureau);
  await bureau.plugins.ready();
  return bureau;
}

function entry(
  descriptor: PluginDescriptor<z.ZodType>,
  source: BureauPluginEntry['source'] = 'package',
  location = `@example/${descriptor.name}`,
): BureauPluginEntry {
  return { descriptor, source, location };
}

function toolNamed(name: string) {
  return createTool({
    name,
    description: `The ${name} tool`,
    input: z.object({}),
    execute: async () => name,
  });
}

describe('plugin composition', () => {
  it('skips a plugin whose configuration is invalid, with the field and message, and still starts', async () => {
    const setups: string[] = [];
    const strict = definePlugin({
      name: 'strict',
      version: '1.0.0',
      description: 'Needs a numeric limit.',
      configuration: z.object({ limit: z.number() }),
      setup: () => {
        setups.push('strict');
        return {};
      },
    });
    const fine = definePlugin({
      name: 'fine',
      version: '1.0.0',
      description: 'Needs nothing.',
      setup: () => {
        setups.push('fine');
        return {};
      },
    });
    const bureau = await start({
      plugins: [entry(strict), entry(fine)],
      pluginConfiguration: { strict: { configuration: { limit: 'ten' } } },
    });

    const [strictListing, fineListing] = bureau.plugins.list();
    expect(strictListing?.status).toBe('skipped');
    expect(strictListing?.problems).toEqual([
      { code: 'configuration-invalid', field: 'limit', message: expect.any(String) },
    ]);
    expect(fineListing?.status).toBe('running');
    expect(setups).toEqual(['fine']);
  });

  it('reports a disabled plugin without running its setup, and a required one runs anyway', async () => {
    const setups: string[] = [];
    const plugin = (name: string, extra: { required?: boolean; enabledByDefault?: boolean } = {}) =>
      definePlugin({
        name,
        version: '1.0.0',
        description: name,
        ...extra,
        setup: () => {
          setups.push(name);
          return {};
        },
      });
    const bureau = await start({
      plugins: [
        entry(plugin('off')),
        entry(plugin('demo', { enabledByDefault: false })),
        entry(plugin('core', { required: true })),
      ],
      pluginConfiguration: { off: { enabled: false }, core: { enabled: false } },
    });

    expect(bureau.plugins.list().map(({ status }) => status)).toEqual([
      'disabled',
      'disabled',
      'running',
    ]);
    expect(setups).toEqual(['core']);
  });

  it('runs the earlier plugin in load order on a plugin-name clash and skips the later one', async () => {
    const setups: string[] = [];
    const named = (location: string) =>
      definePlugin({
        name: 'twin',
        version: '1.0.0',
        description: location,
        setup: () => {
          setups.push(location);
          return {};
        },
      });
    const bureau = await start({
      // Folder plugins load after package plugins, by folder name, whatever order they are given in.
      plugins: [
        entry(named('/plugins/b-twin'), 'folder', '/plugins/b-twin'),
        entry(named('/plugins/a-twin'), 'folder', '/plugins/a-twin'),
      ],
    });

    expect(setups).toEqual(['/plugins/a-twin']);
    expect(bureau.plugins.list().map(({ location, status }) => [location, status])).toEqual([
      ['/plugins/a-twin', 'running'],
      ['/plugins/b-twin', 'skipped'],
    ]);
    expect(bureau.plugins.list()[1]?.problems).toEqual([
      {
        code: 'name-clash',
        name: 'twin',
        first: { source: 'folder', location: '/plugins/a-twin' },
        second: { source: 'folder', location: '/plugins/b-twin' },
      },
    ]);
  });

  it('keys each plugin tool by plugin:name, so only a host tool keyed the same way clashes with it', async () => {
    const searching = (name: string) =>
      definePlugin({
        name,
        version: '1.0.0',
        description: name,
        setup: () => ({ tools: [toolNamed('search')] }),
      });
    const bureau = await start({
      plugins: [entry(searching('first')), entry(searching('second'), 'folder', '/plugins/second')],
      // The host's own catalog already holds `second:search`, as a connected tool source could.
      agentSource: agentFileDirectory('/nonexistent-agent-directory', {
        tools: { 'second:search': toolNamed('search') },
        watch: false,
      }),
      models: { generate: () => async () => ({ content: '', toolCalls: [] }) },
    });

    const [first, second] = bureau.plugins.list();
    expect(first?.status).toBe('running');
    expect(first?.contributions).toEqual([{ kind: 'tool', id: 'first:search@1.0.0' }]);
    expect(second?.status).toBe('skipped');
    expect(second?.contributions).toEqual([]);
    expect(second?.problems).toEqual([
      {
        code: 'name-clash',
        name: 'second:search',
        first: { source: 'built-in', location: 'host' },
        second: { source: 'folder', location: '/plugins/second' },
      },
    ]);
  });

  it('skips a plugin that contributes two things under one id, and one whose formatter claims a held event kind', async () => {
    const twice = definePlugin({
      name: 'twice',
      version: '1.0.0',
      description: 'Two run hook sets named alike.',
      setup: () => ({ runHooks: [{ name: 'audit' }, { name: 'audit' }] }),
    });
    const formatting = (name: string) =>
      definePlugin({
        name,
        version: '1.0.0',
        description: name,
        setup: () => ({
          eventFormatters: [
            { name: 'runs', eventKinds: ['run.settled'], format: () => ({ title: name }) },
          ],
        }),
      });
    const bureau = await start({
      plugins: [entry(twice), entry(formatting('earlier')), entry(formatting('later'))],
    });

    const [twiceListing, earlier, later] = bureau.plugins.list();
    expect(twiceListing?.problems).toEqual([
      {
        code: 'name-clash',
        name: 'twice:audit',
        first: { source: 'package', location: '@example/twice' },
        second: { source: 'package', location: '@example/twice' },
      },
    ]);
    expect(earlier?.status).toBe('running');
    expect(later?.problems).toEqual([
      expect.objectContaining({ code: 'name-clash', name: 'run.settled' }),
    ]);
    // The running formatter is the one Bureau formats with.
    expect(bureau.formatEvent({ kind: 'run.settled', payload: {} } as never).title).toBe('earlier');
  });

  it('confines setup storage to keys under plugin:<name>:', async () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const decode = (bytes: Uint8Array | null) =>
      bytes === null ? null : new TextDecoder().decode(bytes);
    const storage = new MemoryStorage();
    await storage.put('plugin:other:note', encode('not yours'));
    const seen: (string | null)[] = [];
    const keeper = definePlugin({
      name: 'keeper',
      version: '1.0.0',
      description: 'Writes one key.',
      setup: async ({ storage: scoped }) => {
        await scoped.put('state', encode('kept'));
        seen.push(decode(await scoped.get('plugin:other:note')), decode(await scoped.get('state')));
        for await (const [key] of scoped.scan('')) seen.push(key);
        return {};
      },
    });
    await start({ plugins: [entry(keeper)], storage });

    expect(decode(await storage.get('plugin:keeper:state'))).toBe('kept');
    expect(await storage.get('state')).toBeNull();
    expect(seen).toEqual([null, 'kept', 'state']);
  });

  it('runs afterStart once, after construction, with the host API', async () => {
    const calls: string[][] = [];
    const starting = definePlugin({
      name: 'starting',
      version: '1.0.0',
      description: 'Lists the agents once Bureau has started.',
      setup: () => ({
        afterStart: (host) => {
          calls.push(host.agents.list().map(({ name }) => name));
        },
      }),
    });
    const failing = definePlugin({
      name: 'failing',
      version: '1.0.0',
      description: 'Fails after start.',
      setup: () => ({
        afterStart: () => Promise.reject(new Error('could not reach the service')),
      }),
    });
    const bureau = await start({ plugins: [entry(starting), entry(failing)] });

    expect(calls).toEqual([[]]);
    const [, failingListing] = bureau.plugins.list();
    expect(failingListing?.status).toBe('running');
    expect(failingListing?.problems).toEqual([
      { code: 'after-start-failed', message: 'could not reach the service' },
    ]);
  });

  it('skips a plugin whose setup throws, and the host starts', async () => {
    const broken = definePlugin({
      name: 'broken',
      version: '1.0.0',
      description: 'Throws in setup.',
      setup: () => {
        throw new Error('no connection');
      },
    });
    const bureau = await start({ plugins: [entry(broken)] });

    expect(bureau.plugins.list()[0]).toMatchObject({
      status: 'skipped',
      problems: [{ code: 'setup-failed', message: 'no connection' }],
    });
  });

  it('never puts a secret value in a plugins.list() response', async () => {
    const SECRET = 'sk-live-0123456789abcdef';
    const read: (string | undefined)[] = [];
    const keyed = definePlugin({
      name: 'keyed',
      version: '1.0.0',
      description: 'Reads its key.',
      secrets: ['keyed-api-key', { key: 'keyed-signing-key', generated: true }],
      configuration: z.object({ endpoint: z.string() }),
      setup: async ({ secrets }) => {
        read.push(await secrets.get('keyed-api-key'));
        expect(await rejectionOf(secrets.get('undeclared-key'))).toBeInstanceOf(TypeError);
        return { tools: [toolNamed('lookup')] };
      },
    });
    const leaky = definePlugin({
      name: 'leaky',
      version: '1.0.0',
      description: 'Quotes its key when setup fails.',
      secrets: ['leaky-api-key'],
      setup: async ({ secrets }) => {
        const key = await secrets.get('leaky-api-key');
        read.push(key);
        throw new Error(`rejected key ${String(key)} by the service`);
      },
    });
    const late = definePlugin({
      name: 'late',
      version: '1.0.0',
      description: 'Quotes its key when afterStart fails.',
      secrets: ['late-api-key'],
      setup: async ({ secrets }) => {
        const key = await secrets.get('late-api-key');
        read.push(key);
        return { afterStart: () => Promise.reject(new Error(`lost ${String(key)} after start`)) };
      },
    });
    const bureau = await start({
      plugins: [entry(keyed), entry(leaky), entry(late)],
      pluginConfiguration: { keyed: { configuration: { endpoint: 'https://example.test' } } },
      pluginSecrets: {
        get: async (key) => (key.endsWith('-key') ? SECRET : undefined),
        watch: () => () => undefined,
      },
    });

    expect(read).toEqual([SECRET, SECRET, SECRET]);
    const serialized = JSON.stringify(bureau.plugins.list());
    expect(serialized).not.toContain(SECRET);
    // A setup or afterStart that quotes a secret in its error is reported with the value removed.
    const [, leakyListing, lateListing] = bureau.plugins.list();
    expect(leakyListing?.problems).toEqual([
      { code: 'setup-failed', message: 'rejected key [redacted] by the service' },
    ]);
    expect(lateListing?.problems).toEqual([
      { code: 'after-start-failed', message: 'lost [redacted] after start' },
    ]);
    expect(bureau.plugins.list()[0]?.descriptor).toEqual({
      name: 'keyed',
      version: '1.0.0',
      description: 'Reads its key.',
      required: false,
      enabledByDefault: true,
      secrets: [
        { key: 'keyed-api-key', generated: false },
        { key: 'keyed-signing-key', generated: true },
      ],
    });
  });

  it('accepts a decisions.model that names a plugin’s decision router, and still refuses an unknown one', async () => {
    const routing = definePlugin({
      name: 'kit',
      version: '1.0.0',
      description: 'Contributes a decision router.',
      setup: () => ({
        decisionRouters: [{ name: 'router', kinds: new Set(), decide: async () => ({}) as never }],
      }),
    });
    const bureau = await start({ plugins: [entry(routing)], decisions: { model: 'kit:router' } });
    expect(bureau.plugins.list()[0]?.status).toBe('running');

    const refused = await rejectionOf(
      createBureau<AgentDefinitions>({
        plugins: [entry(routing)],
        decisions: { model: 'kit:nope' },
      }),
    );
    expect(refused).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('builds memory from a factory with the detectors and embedders plugins contribute', async () => {
    const received: unknown[] = [];
    const remembering = definePlugin({
      name: 'remembering',
      version: '1.0.0',
      description: 'Contributes to memory.',
      setup: () => ({
        memoryDetectors: [{ name: 'tags', detect: async () => ({ detected: false }) as never }],
        embedders: [
          { name: 'small', dimensions: 4, embed: async (texts) => texts.map(() => [0, 0, 0, 1]) },
        ],
      }),
    });
    await start({
      plugins: [entry(remembering)],
      memory: (contributions) => {
        received.push({
          detectors: contributions.detectors.map(({ name }) => name),
          embedders: contributions.embedders.map(({ id, dimension }) => ({ id, dimension })),
        });
        return undefined as never;
      },
    });

    expect(received).toEqual([
      { detectors: ['tags'], embedders: [{ id: 'remembering:small', dimension: 4 }] },
    ]);
  });
});
