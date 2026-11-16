/**
 * COR-2164 — the sweep of the state a contributed trigger keeps per workflow file. State goes when
 * its file goes, or when the file's trigger becomes another kind; it stays while its file is only
 * invalid, unreadable or paused, and while its plugin is not one the sweep was asked about.
 */
import { describe, expect, it } from 'bun:test';
import { MemoryStorage, type Storage } from '@lostgradient/storage';

import {
  createTriggerStorage,
  sweepTriggerState,
  triggerStatePrefix,
} from './workflow-trigger-state';

async function keysOf(storage: Storage): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of storage.scan('')) keys.push(key);
  return keys.toSorted();
}

async function seeded(keys: readonly string[]): Promise<MemoryStorage> {
  const storage = new MemoryStorage();
  for (const key of keys) await storage.put(key, new Uint8Array([1]));
  return storage;
}

function sweep(
  storage: Storage,
  files: ReadonlyMap<string, string | undefined>,
  plugins: Iterable<string> = ['x'],
  diagnosed: string[] = [],
  runningPlugins: ReadonlySet<string> = new Set(['x']),
) {
  return sweepTriggerState({
    storage,
    plugins,
    runningPlugins,
    files,
    diagnose: (message) => void diagnosed.push(message),
  });
}

describe('triggerStatePrefix', () => {
  it('is plugin, trigger name, then the file in its Weft form', () => {
    expect(triggerStatePrefix('x:cursor', 'inbox')).toBe('plugin:x:trigger:cursor:inbox:');
    expect(triggerStatePrefix('x:cursor', 'linear:sync')).toBe(
      'plugin:x:trigger:cursor:linear__sync:',
    );
  });

  it('never has the prefix of one file inside the prefix of another', () => {
    const owner = triggerStatePrefix('x:cursor', 'foo');
    const plugins = triggerStatePrefix('x:cursor', 'foo:bar');
    expect(plugins.startsWith(owner)).toBe(false);
    expect(owner.startsWith(plugins)).toBe(false);
  });

  it('writes where the narrowed storage says', async () => {
    const backing = new MemoryStorage();
    await createTriggerStorage(backing, 'x:cursor', 'inbox').put('k', new Uint8Array([1]));
    expect(await keysOf(backing)).toEqual([`${triggerStatePrefix('x:cursor', 'inbox')}k`]);
  });
});

describe('sweepTriggerState', () => {
  it('deletes every key of a file that is no longer listed, and only its keys', async () => {
    const storage = await seeded([
      'plugin:x:trigger:cursor:gone:cursor',
      'plugin:x:trigger:cursor:gone:deep:key',
      'plugin:x:trigger:cursor:kept:cursor',
      'plugin:x:setup-state',
    ]);

    await sweep(storage, new Map([['kept', 'x:cursor']]));

    expect(await keysOf(storage)).toEqual([
      'plugin:x:setup-state',
      'plugin:x:trigger:cursor:kept:cursor',
    ]);
  });

  it('keeps the state of a paused file, which is listed with its trigger kind', async () => {
    const storage = await seeded(['plugin:x:trigger:cursor:paused:cursor']);
    await sweep(storage, new Map([['paused', 'x:cursor']]));
    expect(await keysOf(storage)).toEqual(['plugin:x:trigger:cursor:paused:cursor']);
  });

  it('keeps the state of a file that is invalid or unreadable, which names no kind', async () => {
    const storage = await seeded([
      'plugin:x:trigger:cursor:invalid:cursor',
      'plugin:x:trigger:cursor:newer:cursor',
    ]);
    await sweep(
      storage,
      new Map([
        ['invalid', undefined],
        ['newer', undefined],
      ]),
    );
    expect(await keysOf(storage)).toEqual([
      'plugin:x:trigger:cursor:invalid:cursor',
      'plugin:x:trigger:cursor:newer:cursor',
    ]);
  });

  it('deletes the state of a file whose trigger became another kind of the same plugin, or a built-in one', async () => {
    const storage = await seeded([
      'plugin:x:trigger:cursor:moved:cursor',
      'plugin:x:trigger:cursor:scheduled:cursor',
      'plugin:x:trigger:other:moved:cursor',
    ]);
    await sweep(
      storage,
      new Map([
        ['moved', 'x:other'],
        ['scheduled', 'schedule'],
      ]),
    );
    // `moved` keeps what it wrote as `other`; `cursor`'s keys went, so a return to it starts empty.
    expect(await keysOf(storage)).toEqual(['plugin:x:trigger:other:moved:cursor']);
  });

  it('judges a plugin file, whose id has a colon, by its own segment and not the owner file of its plugin name', async () => {
    const storage = await seeded([
      'plugin:x:trigger:cursor:foo:cursor',
      'plugin:x:trigger:cursor:foo__bar:cursor',
    ]);
    await sweep(storage, new Map([['foo:bar', 'x:cursor']]));
    expect(await keysOf(storage)).toEqual(['plugin:x:trigger:cursor:foo__bar:cursor']);
  });

  it('keeps the state of a plugin file whose shipping plugin is not running, and deletes it once it runs', async () => {
    const storage = await seeded([
      'plugin:x:trigger:cursor:shipper__digest:cursor',
      'plugin:x:trigger:cursor:owned:cursor',
    ]);

    // `shipper` is disabled or failed its setup this start: its file is absent for now only.
    await sweep(storage, new Map(), ['x'], [], new Set(['x']));
    expect(await keysOf(storage)).toEqual(['plugin:x:trigger:cursor:shipper__digest:cursor']);

    // `shipper` runs and ships no such file: nothing can bring it back.
    await sweep(storage, new Map(), ['x'], [], new Set(['x', 'shipper']));
    expect(await keysOf(storage)).toEqual([]);
  });

  it('leaves the keys of a plugin it was not asked about until that plugin is swept', async () => {
    const storage = await seeded(['plugin:y:trigger:cursor:gone:cursor']);

    await sweep(storage, new Map(), ['x']);
    expect(await keysOf(storage)).toEqual(['plugin:y:trigger:cursor:gone:cursor']);

    await sweep(storage, new Map(), ['x', 'y']);
    expect(await keysOf(storage)).toEqual([]);
  });

  it('ignores a key under the trigger namespace that does not have the shape of trigger state', async () => {
    const storage = await seeded(['plugin:x:trigger:note', 'plugin:x:trigger:cursor:onlyfile']);
    await sweep(storage, new Map());
    expect(await keysOf(storage)).toEqual([
      'plugin:x:trigger:cursor:onlyfile',
      'plugin:x:trigger:note',
    ]);
  });

  it('reports a plugin it cannot sweep and sweeps the rest', async () => {
    const storage = await seeded(['plugin:y:trigger:cursor:gone:cursor']);
    const diagnosed: string[] = [];

    await sweep(storage, new Map(), ['Not_A_Plugin', 'y'], diagnosed);

    expect(diagnosed).toHaveLength(1);
    expect(await keysOf(storage)).toEqual([]);
  });
});
