/**
 * COR-1874 — the supervisor that keeps the contributed triggers equal to the workflow files'. It
 * never starts a trigger once it is closed, however far into a reconcile the close lands.
 */
import { describe, expect, it } from 'bun:test';
import type { PluginTrigger, PluginTriggerContext } from '@lostgradient/interborough-plugin';
import { MemoryStorage, type Storage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { z } from 'zod';

import type { VersionedCatalogEntry } from './versioned-catalog';
import {
  createWorkflowTriggerSupervisor,
  type DesiredTrigger,
} from './workflow-trigger-supervisor';

/** A promise a test settles by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** A kind that records each start and stop by the `id` in its configuration; `hold` delays a start. */
function recordingKind(
  log: string[],
  hold: (id: string) => Promise<void> | undefined,
): VersionedCatalogEntry<PluginTrigger> {
  return {
    kind: 'trigger',
    name: 'x:recorder',
    version: '1',
    id: 'x:recorder@1',
    source: { name: 'x', version: '1' },
    value: {
      name: 'recorder',
      description: 'Records its starts and stops.',
      configuration: z.object({ id: z.string() }),
      start: async (context) => {
        const { id } = context.configuration as { id: string };
        log.push(`start:${id}`);
        await hold(id);
        return () => {
          log.push(`stop:${id}`);
        };
      },
    },
  };
}

function desire(
  kind: VersionedCatalogEntry<PluginTrigger>,
  ids: readonly string[],
): Map<string, DesiredTrigger> {
  return new Map(
    ids.map((id) => [id, { kind, trigger: { kind: kind.name, id } } satisfies DesiredTrigger]),
  );
}

describe('the workflow trigger supervisor', () => {
  it('starts nothing more once it is closed while a trigger is still starting', async () => {
    const log: string[] = [];
    const first = gate();
    const kind = recordingKind(log, (id) => (id === 'a' ? first.promise : undefined));
    const supervisor = createWorkflowTriggerSupervisor({
      fire: async () => undefined,
      diagnose: () => undefined,
      storage: new MemoryStorage(),
    });

    const reconciling = supervisor.reconcile(desire(kind, ['a', 'b']), new Set());
    await waitUntil(() => log.includes('start:a'), { message: 'the first trigger to start' });
    const closing = supervisor.close();
    first.open();
    await reconciling;
    await closing;

    expect(log).toEqual(['start:a', 'stop:a']);
  });

  it('starts nothing when it is closed before a reconcile', async () => {
    const log: string[] = [];
    const supervisor = createWorkflowTriggerSupervisor({
      fire: async () => undefined,
      diagnose: () => undefined,
      storage: new MemoryStorage(),
    });
    await supervisor.close();
    await supervisor.reconcile(
      desire(
        recordingKind(log, () => undefined),
        ['a'],
      ),
      new Set(),
    );
    expect(log).toEqual([]);
  });

  it('starts nothing after a close that lands while a changed trigger is being replaced', async () => {
    const log: string[] = [];
    const release = gate();
    let held = false;
    const kind = recordingKind(log, (id) => {
      if (id !== 'a-changed' || held) return undefined;
      held = true;
      return release.promise;
    });
    const supervisor = createWorkflowTriggerSupervisor({
      fire: async () => undefined,
      diagnose: () => undefined,
      storage: new MemoryStorage(),
    });
    await supervisor.reconcile(desire(kind, ['a']), new Set());
    const changed = new Map<string, DesiredTrigger>([
      ['a', { kind, trigger: { kind: kind.name, id: 'a-changed' } }],
      ['b', { kind, trigger: { kind: kind.name, id: 'b' } }],
    ]);

    const reconciling = supervisor.reconcile(changed, new Set());
    await waitUntil(() => log.includes('start:a-changed'), { message: 'the replacement to start' });
    const closing = supervisor.close();
    release.open();
    await reconciling;
    await closing;

    expect(log).not.toContain('start:b');
  });
});

/** A kind that hands the context of each start to `contexts`. */
function stateKind(
  contexts: PluginTriggerContext[],
  options: { name?: string; plugin?: string; version?: string } = {},
): VersionedCatalogEntry<PluginTrigger> {
  const { name = 'cursor', plugin = 'x', version = '1' } = options;
  return {
    kind: 'trigger',
    name: `${plugin}:${name}`,
    version,
    id: `${plugin}:${name}@${version}`,
    source: { name: plugin, version },
    value: {
      name,
      description: 'Keeps a cursor.',
      configuration: z.object({ account: z.string().optional() }),
      start: async (context) => {
        contexts.push(context);
        return () => undefined;
      },
    },
  };
}

function wantedKind(
  kind: VersionedCatalogEntry<PluginTrigger>,
  files: Readonly<Record<string, Record<string, unknown>>>,
): Map<string, DesiredTrigger> {
  return new Map(
    Object.entries(files).map(([id, rest]) => [
      id,
      { kind, trigger: { kind: kind.name, ...rest } } satisfies DesiredTrigger,
    ]),
  );
}

const encoded = (value: string) => new TextEncoder().encode(value);

/** Every key of `storage`, sorted. */
async function keysOf(storage: Storage): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of storage.scan('')) keys.push(key);
  return keys.toSorted();
}

function supervisorOver(storage: Storage, diagnosed: string[] = []) {
  return createWorkflowTriggerSupervisor({
    fire: async () => undefined,
    diagnose: (message) => void diagnosed.push(message),
    storage,
  });
}

describe('the state a workflow trigger keeps for its file (COR-2164)', () => {
  it('hands start the workflow id and a storage that writes only under the narrowed prefix', async () => {
    const backing = new MemoryStorage();
    await backing.put('plugin:x:setup-state', encoded('theirs'));
    await backing.put('plugin:x:trigger:cursor:b:cursor', encoded('b'));
    await backing.put('plugin:y:trigger:cursor:a:cursor', encoded('other plugin'));
    const contexts: PluginTriggerContext[] = [];
    const supervisor = supervisorOver(backing);

    await supervisor.reconcile(wantedKind(stateKind(contexts), { a: {} }), new Set());
    const [context] = contexts;
    expect(context?.workflowId).toBe('a');
    await context!.storage.put('cursor', encoded('42'));
    await context!.storage.put('deep:key', encoded('7'));

    expect(await keysOf(backing)).toEqual([
      'plugin:x:setup-state',
      'plugin:x:trigger:cursor:a:cursor',
      'plugin:x:trigger:cursor:a:deep:key',
      'plugin:x:trigger:cursor:b:cursor',
      'plugin:y:trigger:cursor:a:cursor',
    ]);
    // It reads nothing outside its prefix: its own two keys, not `b`'s, the plugin's or `y`'s.
    expect(await keysOf(context!.storage)).toEqual(['cursor', 'deep:key']);
    expect(await context!.storage.get('setup-state')).toBeNull();
    await supervisor.close();
  });

  it('gives two files of one kind disjoint keys, and a plugin file its own, whose id has a colon', async () => {
    const backing = new MemoryStorage();
    const contexts: PluginTriggerContext[] = [];
    const supervisor = supervisorOver(backing);

    await supervisor.reconcile(
      wantedKind(stateKind(contexts), { first: {}, second: {}, foo: {}, 'foo:bar': {} }),
      new Set(),
    );
    for (const context of contexts) {
      await context.storage.put('cursor', encoded(context.workflowId));
    }

    expect(await keysOf(backing)).toEqual([
      'plugin:x:trigger:cursor:first:cursor',
      'plugin:x:trigger:cursor:foo:cursor',
      'plugin:x:trigger:cursor:foo__bar:cursor',
      'plugin:x:trigger:cursor:second:cursor',
    ]);
    for (const context of contexts) {
      expect(await keysOf(context.storage)).toEqual(['cursor']);
      expect(new TextDecoder().decode((await context.storage.get('cursor'))!)).toBe(
        context.workflowId,
      );
    }
    await supervisor.close();
  });

  it('keeps the keys across a restart', async () => {
    const backing = new MemoryStorage();
    const first: PluginTriggerContext[] = [];
    const before = supervisorOver(backing);
    await before.reconcile(wantedKind(stateKind(first), { a: {} }), new Set());
    await first[0]!.storage.put('cursor', encoded('42'));
    await before.close();

    const second: PluginTriggerContext[] = [];
    const after = supervisorOver(backing);
    await after.reconcile(wantedKind(stateKind(second), { a: {} }), new Set());

    expect(new TextDecoder().decode((await second[0]!.storage.get('cursor'))!)).toBe('42');
    await after.close();
  });

  it('keeps the keys across a pause', async () => {
    const backing = new MemoryStorage();
    const contexts: PluginTriggerContext[] = [];
    const kind = stateKind(contexts);
    const supervisor = supervisorOver(backing);
    await supervisor.reconcile(wantedKind(kind, { a: {} }), new Set());
    await contexts[0]!.storage.put('cursor', encoded('42'));

    // A paused file is not desired: its trigger stops, and nothing deletes its state.
    await supervisor.reconcile(new Map(), new Set());
    expect(contexts[0]!.signal.aborted).toBe(true);
    await supervisor.reconcile(wantedKind(kind, { a: {} }), new Set());

    expect(contexts).toHaveLength(2);
    expect(new TextDecoder().decode((await contexts[1]!.storage.get('cursor'))!)).toBe('42');
    await supervisor.close();
  });

  it('keeps the keys across a configuration edit', async () => {
    const backing = new MemoryStorage();
    const contexts: PluginTriggerContext[] = [];
    const kind = stateKind(contexts);
    const supervisor = supervisorOver(backing);
    await supervisor.reconcile(wantedKind(kind, { a: { account: 'one' } }), new Set());
    await contexts[0]!.storage.put('cursor', encoded('42'));

    await supervisor.reconcile(wantedKind(kind, { a: { account: 'two' } }), new Set());

    expect(contexts.map((context) => context.configuration)).toEqual([
      { account: 'one' },
      { account: 'two' },
    ]);
    expect(new TextDecoder().decode((await contexts[1]!.storage.get('cursor'))!)).toBe('42');
    await supervisor.close();
  });

  it('keeps the keys across a plugin version bump', async () => {
    const backing = new MemoryStorage();
    const contexts: PluginTriggerContext[] = [];
    const supervisor = supervisorOver(backing);
    await supervisor.reconcile(wantedKind(stateKind(contexts), { a: {} }), new Set());
    await contexts[0]!.storage.put('cursor', encoded('42'));

    await supervisor.reconcile(
      wantedKind(stateKind(contexts, { version: '2' }), { a: {} }),
      new Set(),
    );

    // The version is part of what restarts the listener, and not of where its state lives.
    expect(contexts).toHaveLength(2);
    expect(new TextDecoder().decode((await contexts[1]!.storage.get('cursor'))!)).toBe('42');
    await supervisor.close();
  });

  it('leaves a trigger stopped, and says so, when its kind is not named for a valid plugin', async () => {
    const contexts: PluginTriggerContext[] = [];
    const diagnosed: string[] = [];
    const supervisor = supervisorOver(new MemoryStorage(), diagnosed);

    await supervisor.reconcile(
      wantedKind(stateKind(contexts, { plugin: 'Bad_Plugin' }), { a: {} }),
      new Set(),
    );

    expect(contexts).toEqual([]);
    expect(diagnosed).toHaveLength(1);
    expect(diagnosed[0]).toContain('its storage');
    await supervisor.close();
  });
});
