/**
 * COR-2435: each tool source's and plugin's last tool listing, kept in the host's storage so a
 * source that fails, waits for a sign-in, or a plugin that is off still shows its tools after a
 * restart. These pin the stored record: what reads as "no listing known", the bounds, and that
 * only a successful listing replaces it.
 */
import type { BureauPluginEntry, PluginListing } from '@lostgradient/bureau';
import { definePlugin } from '@lostgradient/interborough-plugin';
import { MemoryStorage } from '@lostgradient/storage';
import { describe, expect, test } from 'bun:test';

import { createPluginManager } from './plugin-manager.ts';
import {
  createToolListingMemory,
  listingRecord,
  MAXIMUM_LISTING_BYTES,
  MAXIMUM_REMEMBERED_DESCRIPTION_LENGTH,
  MAXIMUM_REMEMBERED_TOOLS,
  pluginListingOwner,
  rememberPluginListings,
  sourceListingOwner,
  TOOL_LISTING_KEY_PREFIX,
  type RememberedTool,
  type RememberedToolInput,
} from './tool-listing-memory.ts';
import { memoryHome } from './tool-source-memory-home.test-support.ts';

const createIssue: RememberedToolInput & RememberedTool = {
  name: 'github__create_issue',
  tool: 'create_issue',
  title: 'Create issue',
  description: 'Opens an issue in a GitHub repository.',
  shortDescription: null,
  tier: 'mutating',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
};

const at = Date.parse('2026-11-17T08:00:00.000Z');

describe('a remembered listing', () => {
  test('reads back what was remembered, for the revision it was made for', async () => {
    const memory = createToolListingMemory(new MemoryStorage(), () => at);
    await memory.remember(sourceListingOwner('github'), 'revision-1', [createIssue]);

    expect(await memory.read(sourceListingOwner('github'), 'revision-1')).toEqual({
      schemaVersion: 1,
      revision: 'revision-1',
      listedAt: '2026-11-17T08:00:00.000Z',
      tools: [createIssue],
      truncated: false,
    });
  });

  test('is unknown for another revision: a source pointed elsewhere, or a new one reusing the id', async () => {
    const memory = createToolListingMemory(new MemoryStorage(), () => at);
    await memory.remember(sourceListingOwner('github'), 'revision-1', [createIssue]);

    expect(await memory.read(sourceListingOwner('github'), 'revision-2')).toBeUndefined();
  });

  test('is unknown when nothing was stored, as for every source from before the change', async () => {
    const memory = createToolListingMemory(new MemoryStorage());
    expect(await memory.read(sourceListingOwner('github'))).toBeUndefined();
  });

  test('is unknown, never an error, for a record this reader cannot parse', async () => {
    const storage = new MemoryStorage();
    const memory = createToolListingMemory(storage);
    const key = `${TOOL_LISTING_KEY_PREFIX}${sourceListingOwner('github')}`;
    const encode = (value: string) => new TextEncoder().encode(value);

    await storage.put(key, encode('not json'));
    expect(await memory.read(sourceListingOwner('github'))).toBeUndefined();
    await storage.put(key, encode(JSON.stringify({ schemaVersion: 2, tools: [] })));
    expect(await memory.read(sourceListingOwner('github'))).toBeUndefined();
    await storage.put(
      key,
      encode(
        JSON.stringify({
          schemaVersion: 1,
          revision: 'r',
          listedAt: 'now',
          tools: [{ name: 'x' }],
          truncated: false,
        }),
      ),
    );
    expect(await memory.read(sourceListingOwner('github'))).toBeUndefined();
  });

  test('is forgotten when its owner is', async () => {
    const memory = createToolListingMemory(new MemoryStorage());
    await memory.remember(sourceListingOwner('github'), 'r', [createIssue]);
    await memory.forget(sourceListingOwner('github'));
    expect(await memory.read(sourceListingOwner('github'))).toBeUndefined();
  });

  test('keys a plugin by where it was loaded from, so two plugins of one name never share one', () => {
    const first = pluginListingOwner({ source: 'package', location: '@acme/demo' });
    const second = pluginListingOwner({ source: 'folder', location: '/plugins/demo' });
    expect(first).not.toBe(second);
    expect(first.startsWith('plugin:')).toBe(true);
  });
});

describe('the bounds of a listing', () => {
  test('keeps at most the tool limit, and says that some were left out', () => {
    const many = Array.from({ length: MAXIMUM_REMEMBERED_TOOLS + 5 }, (_, index) => ({
      ...createIssue,
      name: `github__tool_${index}`,
      tool: `tool_${index}`,
    }));
    const record = listingRecord('r', 'now', many);
    expect(record.tools).toHaveLength(MAXIMUM_REMEMBERED_TOOLS);
    expect(record.truncated).toBe(true);
  });

  test('cuts a long description, and reads an unknown tier as none', () => {
    const [tool] = listingRecord('r', 'now', [
      { ...createIssue, description: 'x'.repeat(5000), tier: 'cosmic' },
    ]).tools;
    expect(tool?.description).toHaveLength(MAXIMUM_REMEMBERED_DESCRIPTION_LENGTH);
    expect(tool?.tier).toBeNull();
  });

  test('drops input schemas from the end until the record fits its byte limit', () => {
    const huge = { type: 'object', description: 'y'.repeat(8 * 1024) };
    const tools = Array.from({ length: 64 }, (_, index) => ({
      ...createIssue,
      name: `github__tool_${index}`,
      tool: `tool_${index}`,
      inputSchema: huge,
    }));
    const record = listingRecord('r', 'now', tools);

    expect(new TextEncoder().encode(JSON.stringify(record)).byteLength).toBeLessThanOrEqual(
      MAXIMUM_LISTING_BYTES,
    );
    expect(record.tools).toHaveLength(64);
    expect(record.tools[0]?.inputSchema).toEqual(huge);
    expect(record.tools.at(-1)?.inputSchema).toBeNull();
    expect(record.truncated).toBe(true);
  });
});

const demo: BureauPluginEntry = {
  descriptor: definePlugin({
    name: 'demo',
    version: '1.0.0',
    description: 'Drafts release notes.',
  }),
  source: 'package',
  location: '@fixture/demo',
};

function listingOf(status: PluginListing['status']): PluginListing {
  return {
    descriptor: {
      name: 'demo',
      title: 'Demo',
      version: '1.0.0',
      description: 'Drafts release notes.',
      required: false,
      enabledByDefault: true,
      secrets: [],
    },
    source: 'package',
    location: '@fixture/demo',
    status,
    problems: [],
    contributions: [],
  };
}

const draftReleaseNotes = {
  name: 'demo:draft-release-notes',
  title: 'Draft release notes',
  description: 'Writes release notes from merged changes.',
  shortDescription: null,
  tier: 'mutating',
  inputSchema: null,
  source: 'plugin',
  plugin: 'demo',
} as const;

describe('a plugin listing', () => {
  test('is kept from a running plugin, and a disabled plugin leaves it as it was', async () => {
    const memory = createToolListingMemory(new MemoryStorage(), () => at);
    const owner = pluginListingOwner(listingOf('running'));
    await rememberPluginListings(memory, [listingOf('running')], [draftReleaseNotes], () => {});

    // The next start has the plugin off: it lists nothing, and the last listing stays.
    await rememberPluginListings(memory, [listingOf('disabled')], [], () => {});

    const record = await memory.read(owner);
    expect(record?.tools.map((tool) => [tool.name, tool.title, tool.tier])).toEqual([
      ['demo:draft-release-notes', 'Draft release notes', 'mutating'],
    ]);
  });

  test('takes only the tools the plugin itself contributes', async () => {
    const memory = createToolListingMemory(new MemoryStorage());
    await rememberPluginListings(
      memory,
      [listingOf('running')],
      [
        draftReleaseNotes,
        { ...draftReleaseNotes, name: 'other:tool', plugin: 'other' },
        { ...draftReleaseNotes, name: 'github__create_issue', source: 'host', plugin: null },
      ],
      () => {},
    );
    const record = await memory.read(pluginListingOwner(listingOf('running')));
    expect(record?.tools.map((tool) => tool.name)).toEqual(['demo:draft-release-notes']);
  });

  test('a write that fails is a warning, and never a failure', async () => {
    const storage = new MemoryStorage();
    storage.put = () => Promise.reject(new Error('disk full'));
    const warnings: string[] = [];
    await rememberPluginListings(
      createToolListingMemory(storage),
      [listingOf('running')],
      [draftReleaseNotes],
      (message) => warnings.push(message),
    );
    expect(warnings).toHaveLength(1);
  });

  test('the plugin snapshot reports the last listing of a disabled plugin, and none for a running one', async () => {
    const memory = createToolListingMemory(new MemoryStorage(), () => at);
    await rememberPluginListings(memory, [listingOf('running')], [draftReleaseNotes], () => {});

    const snapshotWith = async (status: PluginListing['status']) => {
      const manager = await createPluginManager({
        bungalow: memoryHome().bungalow,
        plugins: [demo],
        listing: async () => [listingOf(status)],
        reservedSecretKeys: [],
        reservedSecretPrefixes: [],
        listings: memory,
      });
      const snapshot = await manager.snapshot();
      return snapshot.plugins[0];
    };

    const disabled = await snapshotWith('disabled');
    expect(disabled?.lastListing).toMatchObject({
      listedAt: '2026-11-17T08:00:00.000Z',
      truncated: false,
      tools: [{ name: 'demo:draft-release-notes', title: 'Draft release notes' }],
    });
    const running = await snapshotWith('running');
    expect(running?.lastListing).toBeUndefined();
  });
});
