/**
 * COR-2435: a saved tool source keeps its last tool listing across restarts, so a source that
 * fails to load still shows the tools it offered (`lastListing`), none of them offered to an
 * agent. A failure never replaces the listing, a source pointed elsewhere has none, and a removal
 * forgets it.
 */
import { generateEncryptionKey } from '@lostgradient/cryptography';
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  createToolListingMemory,
  sourceListingOwner,
  type ToolListingMemory,
} from './tool-listing-memory.ts';
import { createToolSourceManager, type ToolSourceManager } from './tool-source-manager.ts';
import { memoryHome } from './tool-source-memory-home.test-support.ts';
import { petsDocument } from './tool-source-servers.test-support.ts';

const petsSource = (extra: Record<string, unknown> = {}) => ({
  id: 'pets',
  kind: 'openapi',
  specification: { type: 'document', document: petsDocument },
  baseUrl: 'http://127.0.0.1:9/',
  authentication: { type: 'api-key', header: 'x-api-key', credential: 'key' },
  ...extra,
});

const closers: ToolSourceManager[] = [];

afterEach(async () => {
  for (const manager of closers.splice(0)) await manager.close();
});

function managerOver(
  home: ReturnType<typeof memoryHome>,
  keys: { current: Awaited<ReturnType<typeof generateEncryptionKey>> },
  listings: ToolListingMemory,
): ToolSourceManager {
  const manager = createToolSourceManager({
    bungalow: home.bungalow,
    keys,
    audit: async () => {},
    origin: () => 'http://127.0.0.1:1',
    listings,
  });
  closers.push(manager);
  return manager;
}

/** The sources the manager reports now. */
async function sourcesOf(manager: ToolSourceManager) {
  const snapshot = await manager.snapshot();
  return snapshot.sources;
}

/** A home with the pets source saved and loaded once, so its listing is kept. */
async function loadedOnce() {
  const home = memoryHome();
  const listings = createToolListingMemory(new MemoryStorage(), () => 0);
  const keys = { current: await generateEncryptionKey() };
  const first = managerOver(home, keys, listings);
  await first.connect({
    id: 'pets',
    source: petsSource(),
    credentials: { key: 'k' },
    principal: 'anonymous:local',
  });
  await first.start();
  return { home, listings, first };
}

describe('the last listing of a tool source', () => {
  test('a loaded source reports its tools and no last listing', async () => {
    const { first } = await loadedOnce();
    const [source] = await sourcesOf(first);
    expect(source?.state).toBe('loaded');
    expect(source?.tools.length).toBeGreaterThan(0);
    expect(source?.lastListing).toBeUndefined();
  });

  test('a source that fails after a restart still shows the tools it listed, and offers none', async () => {
    const { home, listings, first } = await loadedOnce();
    const [loaded] = await sourcesOf(first);
    const loadedTools = loaded?.tools.map((tool) => tool.name);

    // The key that sealed its credential is gone, so the next start cannot load it.
    const second = managerOver(home, { current: await generateEncryptionKey() }, listings);
    await second.start();
    const [source] = await sourcesOf(second);

    expect(source?.state).toBe('failed');
    expect(source?.tools).toEqual([]);
    expect(source?.lastListing?.listedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(source?.lastListing?.tools.map((tool) => tool.name)).toEqual(loadedTools ?? []);
    expect(source?.lastListing?.tools[0]).toMatchObject({
      enabled: true,
      savedEnabled: true,
      acceptsSecrets: false,
    });
    expect(Object.keys(second.tools())).toEqual([]);
  });

  test('a failed load never replaces the listing', async () => {
    const { home, listings } = await loadedOnce();
    const before = await listings.read(sourceListingOwner('pets'));
    const second = managerOver(home, { current: await generateEncryptionKey() }, listings);
    await second.start();
    expect(await listings.read(sourceListingOwner('pets'))).toEqual(before);
  });

  test('a source saved to point elsewhere reads as no listing known', async () => {
    const { home, listings, first } = await loadedOnce();
    await first.connect({
      id: 'pets',
      source: petsSource({ baseUrl: 'http://127.0.0.1:8/' }),
      credentials: { key: 'k' },
      principal: 'anonymous:local',
    });
    const second = managerOver(home, { current: await generateEncryptionKey() }, listings);
    await second.start();
    const [source] = await sourcesOf(second);
    expect(source?.state).toBe('failed');
    expect(source?.lastListing).toBeUndefined();
  });

  test('a removal forgets the listing', async () => {
    const { listings, first } = await loadedOnce();
    await first.remove({ id: 'pets', principal: 'anonymous:local' });
    expect(await listings.read(sourceListingOwner('pets'))).toBeUndefined();
  });
});
