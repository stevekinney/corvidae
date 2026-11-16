/**
 * COR-2164 — the per-file state of a contributed trigger, through a Bureau that reads workflow
 * files: a trigger's `storage` is confined to its prefix, and the next reconcile deletes the state
 * of a file that is gone or whose trigger became another kind, while a restart, a pause, a
 * configuration edit, a plugin version bump and an `invalid` file keep it, and the state of a
 * plugin that is not loaded stays until it loads.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  defineTrigger,
  definePlugin,
  type PluginTriggerContext,
} from '@lostgradient/interborough-plugin';
import { MemoryStorage, storageKeys, type Storage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

import { workflowFileDirectory } from './sources/workflow-file-directory';
import { createMemoryStorageFixture } from './test/storage-fixtures';
import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
  type WorkflowBureauOptions,
} from './testing/workflow-bureau.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';
import { createVersionedCatalog, type VersionedCatalog } from './versioned-catalog';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const encoded = (value: string) => new TextEncoder().encode(value);
const decoded = (value: Uint8Array | null) =>
  value === null ? null : new TextDecoder().decode(value);

/** `hold` delays the `start` of a trigger whose configuration names the account `hold`. */
function triggerOf(name: string, contexts: PluginTriggerContext[], hold?: Promise<void>) {
  return defineTrigger({
    name,
    description: `Keeps a ${name}.`,
    configuration: z.object({ account: z.string().optional() }),
    start: async (context) => {
      contexts.push(context);
      if (context.configuration.account === 'hold') await hold;
      return () => undefined;
    },
  });
}

/** The host catalog of plugin `x` with two trigger kinds, `x:cursor` and `x:other`, at `version`. */
function catalogOf(
  contexts: PluginTriggerContext[],
  version = '1',
  hold?: Promise<void>,
): VersionedCatalog {
  const catalog = createVersionedCatalog();
  for (const name of ['cursor', 'other']) {
    catalog.register({
      kind: 'trigger',
      name: `x:${name}`,
      version,
      value: triggerOf(name, contexts, hold),
      source: { name: 'x', version },
    });
  }
  return catalog;
}

/** The file `watcher`, whose trigger is `trigger` and which `overrides` may change further. */
const watching = (trigger: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
  workflowFileText('watcher', {
    trigger,
    steps: [{ kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'go' } }],
    ...overrides,
  });

async function keysOf(storage: Storage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of storageKeys(storage, prefix)) keys.push(key);
  return keys.toSorted();
}

/** A store and a directory that outlive the Bureaus started over them. */
async function storeAndFiles() {
  const fixture = createMemoryStorageFixture();
  cleanups.push(() => fixture.dispose());
  const directory = await mkdtemp(join(tmpdir(), 'bureau-trigger-state-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const bureauOver = async (overrides: NonNullable<WorkflowBureauOptions['overrides']>) => {
    const harness = await startWorkflowBureau({
      directory,
      overrides: { storage: fixture.storage, onDiagnostic: () => undefined, ...overrides },
    });
    cleanups.push(() => harness.dispose());
    return harness;
  };
  return { storage: fixture.storage, directory, bureauOver };
}

/** Rescan, and wait until `contexts` holds `count` starts. */
async function started(
  harness: WorkflowBureauHarness,
  contexts: PluginTriggerContext[],
  count: number,
) {
  await harness.bureau.workflows?.refresh();
  await waitUntil(() => contexts.length === count, { message: `${count} trigger start(s)` });
}

const cursorKey = 'plugin:x:trigger:cursor:watcher:cursor';

/** A Bureau with `watcher` listening on `x:cursor`, which has written its cursor. */
async function withCursor() {
  const files = await storeAndFiles();
  const contexts: PluginTriggerContext[] = [];
  const harness = await files.bureauOver({ contributionCatalog: catalogOf(contexts) });
  await harness.put('watcher.json', watching({ kind: 'x:cursor' }));
  await started(harness, contexts, 1);
  await contexts[0]!.storage.put('cursor', encoded('42'));
  return { ...files, harness, contexts };
}

describe('the state a contributed trigger keeps, through a Bureau', () => {
  it('gives start the file id and storage under the narrowed prefix, then deletes it with the file', async () => {
    const { harness, contexts, storage, directory } = await withCursor();
    expect(contexts[0]!.workflowId).toBe('watcher');
    expect(await keysOf(storage, 'plugin:x:')).toEqual([cursorKey]);

    await rm(join(directory, 'watcher.json'));
    await harness.bureau.workflows?.refresh();

    const gone = async () => {
      const remaining = await keysOf(storage, 'plugin:x:');
      return remaining.length === 0;
    };
    await waitUntil(gone, { message: 'the state of the deleted file to go' });
  });

  it('keeps the state across a restart', async () => {
    const { harness, storage, bureauOver } = await withCursor();
    await harness.bureau.dispose();

    const contexts: PluginTriggerContext[] = [];
    const restarted = await bureauOver({ contributionCatalog: catalogOf(contexts) });
    await started(restarted, contexts, 1);

    expect(decoded(await contexts[0]!.storage.get('cursor'))).toBe('42');
    expect(await keysOf(storage, 'plugin:x:')).toEqual([cursorKey]);
  });

  it('keeps the state across a pause', async () => {
    const { harness, contexts, storage } = await withCursor();

    await harness.put('watcher.json', watching({ kind: 'x:cursor' }, { paused: true }));
    await harness.bureau.workflows?.refresh();
    await waitUntil(() => contexts[0]!.signal.aborted, { message: 'the paused trigger to stop' });
    expect(await keysOf(storage, 'plugin:x:')).toEqual([cursorKey]);

    await harness.put('watcher.json', watching({ kind: 'x:cursor' }));
    await started(harness, contexts, 2);
    expect(decoded(await contexts[1]!.storage.get('cursor'))).toBe('42');
  });

  it('keeps the state across a configuration edit', async () => {
    const { harness, contexts } = await withCursor();

    await harness.put('watcher.json', watching({ kind: 'x:cursor', account: 'two' }));
    await started(harness, contexts, 2);

    expect(contexts[1]!.configuration).toEqual({ account: 'two' });
    expect(decoded(await contexts[1]!.storage.get('cursor'))).toBe('42');
  });

  it('keeps the state across a plugin version bump', async () => {
    const { harness, storage, bureauOver } = await withCursor();
    await harness.bureau.dispose();

    const contexts: PluginTriggerContext[] = [];
    const upgraded = await bureauOver({ contributionCatalog: catalogOf(contexts, '2') });
    await started(upgraded, contexts, 1);

    expect(decoded(await contexts[0]!.storage.get('cursor'))).toBe('42');
    expect(await keysOf(storage, 'plugin:x:')).toEqual([cursorKey]);
  });

  it('keeps the state of a file that stopped being valid', async () => {
    const { harness, storage } = await withCursor();

    await harness.put('watcher.json', '{ not json');
    await harness.bureau.workflows?.refresh();

    expect(harness.bureau.workflows?.list().find((entry) => entry.id === 'watcher')?.state).toBe(
      'invalid',
    );
    expect(await keysOf(storage, 'plugin:x:')).toEqual([cursorKey]);
  });

  it('starts a file whose trigger became another kind of the same plugin with empty state', async () => {
    const { harness, contexts, storage } = await withCursor();

    await harness.put('watcher.json', watching({ kind: 'x:other' }));
    await started(harness, contexts, 2);

    expect(await keysOf(contexts[1]!.storage, '')).toEqual([]);
    expect(await keysOf(storage, 'plugin:x:')).toEqual([]);
    // Back to the first kind, it does not find what it wrote before.
    await harness.put('watcher.json', watching({ kind: 'x:cursor' }));
    await started(harness, contexts, 3);
    expect(await keysOf(contexts[2]!.storage, '')).toEqual([]);
  });

  it('leaves the state of a plugin that is not loaded until it loads and a sweep runs', async () => {
    const { storage, directory, bureauOver } = await storeAndFiles();
    const contexts: PluginTriggerContext[] = [];
    const plugin = definePlugin({
      name: 'x',
      version: '1.0.0',
      description: 'Contributes a trigger that keeps a cursor.',
      setup: () => ({ triggers: [triggerOf('cursor', contexts)] }),
    });
    const entry = { descriptor: plugin, source: 'package' as const, location: '@example/x' };

    const first = await bureauOver({ plugins: [entry] });
    await first.put('watcher.json', watching({ kind: 'x:cursor' }));
    await started(first, contexts, 1);
    await contexts[0]!.storage.put('cursor', encoded('42'));
    await first.bureau.dispose();
    await rm(join(directory, 'watcher.json'));

    // The file is gone, and the plugin is not loaded: its state stays.
    const without = await bureauOver({});
    await without.bureau.workflows?.refresh();
    expect(await keysOf(storage, 'plugin:x:')).toEqual([cursorKey]);
    await without.bureau.dispose();

    // The plugin loads, and the first sweep deletes what no file owns.
    const loaded = await bureauOver({ plugins: [entry] });
    await loaded.bureau.workflows?.refresh();
    expect(await keysOf(storage, 'plugin:x:')).toEqual([]);
  });

  describe('a file another plugin ships, whose trigger is a kind of a plugin that is running', () => {
    const shippedKey = 'plugin:cron:trigger:tick:shipper__digest:cursor';

    /** Plugin `cron` contributes `cron:tick`; plugin `shipper` ships `shipper:digest` that uses it. */
    async function shipping(mode: 'disabled' | 'setup-throws') {
      const { storage, bureauOver } = await storeAndFiles();
      const content = await mkdtemp(join(tmpdir(), 'bureau-trigger-state-content-'));
      cleanups.push(() => rm(content, { recursive: true, force: true }));
      await mkdir(join(content, 'workflows'));
      const digest = join(content, 'workflows', 'digest.json');
      await writeFile(
        digest,
        workflowFileText('shipper:digest', {
          trigger: { kind: 'cron:tick' },
          steps: [
            { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'go' } },
          ],
        }),
      );
      const contexts: PluginTriggerContext[] = [];
      const cron = definePlugin({
        name: 'cron',
        version: '1.0.0',
        description: 'Ticks.',
        setup: () => ({ triggers: [triggerOf('tick', contexts)] }),
      });
      const shipperOf = (failing: boolean) =>
        definePlugin({
          name: 'shipper',
          version: '1.0.0',
          description: 'Ships a workflow.',
          content: pathToFileURL(`${content}/`),
          setup: () => {
            if (failing) throw new Error('transient');
            return {};
          },
        });
      /** A boot in which `shipper` runs, or does not, in the way `mode` names. */
      const boot = (shipperRuns: boolean) =>
        bureauOver({
          pluginWorkflowSource: (plugin, url) =>
            workflowFileDirectory(join(fileURLToPath(url), 'workflows'), { plugin, watch: false }),
          plugins: [
            { descriptor: cron, source: 'package', location: '@example/cron' },
            {
              descriptor: shipperOf(mode === 'setup-throws' && !shipperRuns),
              source: 'package',
              location: '@example/shipper',
            },
          ],
          pluginConfiguration: { shipper: { enabled: mode === 'disabled' ? shipperRuns : true } },
        });
      return { storage, contexts, boot, digest };
    }

    for (const mode of ['disabled', 'setup-throws'] as const) {
      it(`keeps the state of its file for a boot in which the shipping plugin is ${mode}`, async () => {
        const { storage, contexts, boot } = await shipping(mode);
        const first = await boot(true);
        await started(first, contexts, 1);
        expect(contexts[0]!.workflowId).toBe('shipper:digest');
        await contexts[0]!.storage.put('cursor', encoded('42'));
        await first.bureau.dispose();

        // `shipper` does not run, so its file is not listed; `cron` runs and is swept.
        const second = await boot(false);
        await second.bureau.workflows?.refresh();
        expect(second.bureau.workflows?.list().map((entry) => entry.id)).toEqual([]);
        expect(await keysOf(storage, 'plugin:cron:')).toEqual([shippedKey]);
        await second.bureau.dispose();

        // `shipper` is back: its file starts with the cursor it left.
        const third = await boot(true);
        await started(third, contexts, 2);
        expect(decoded(await contexts[1]!.storage.get('cursor'))).toBe('42');
      });
    }

    it('deletes the state of its file once the plugin that ships it runs and ships it no more', async () => {
      const { storage, contexts, boot, digest } = await shipping('disabled');
      const first = await boot(true);
      await started(first, contexts, 1);
      await contexts[0]!.storage.put('cursor', encoded('42'));
      await first.bureau.dispose();
      await rm(digest);

      const second = await boot(true);
      await second.bureau.workflows?.refresh();
      expect(await keysOf(storage, 'plugin:cron:')).toEqual([]);
    });
  });

  it('never deletes the state of a trigger the reconcile left running, whatever changes meanwhile', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    /** Records, for each prefix deleted, whether the first trigger had been stopped by then. */
    const deletions: { readonly prefix: string; readonly stopped: boolean }[] = [];
    const contexts: PluginTriggerContext[] = [];
    class RecordingStorage extends MemoryStorage {
      override async deletePrefix(prefix: string): Promise<number> {
        deletions.push({ prefix, stopped: contexts[0]!.signal.aborted });
        return super.deletePrefix(prefix);
      }
    }
    const storage = new RecordingStorage();
    const { bureauOver } = await storeAndFiles();
    const harness = await bureauOver({
      storage,
      contributionCatalog: catalogOf(contexts, '1', held),
    });
    await harness.put('watcher.json', watching({ kind: 'x:cursor' }));
    await started(harness, contexts, 1);
    await contexts[0]!.storage.put('cursor', encoded('42'));

    // A reconcile is in flight, held inside the start of another file's trigger.
    await harness.put(
      'blocker.json',
      workflowFileText('blocker', {
        trigger: { kind: 'x:cursor', account: 'hold' },
        steps: [{ kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'go' } }],
      }),
    );
    const applying = harness.bureau.workflows?.refresh();
    await waitUntil(() => contexts.length === 2, { message: 'the held trigger to start' });

    // The watcher's file becomes another kind while that reconcile waits.
    const before = harness.bureau.workflows
      ?.list()
      .find((entry) => entry.id === 'watcher')?.version;
    await harness.put('watcher.json', watching({ kind: 'x:other' }));
    const queued = harness.bureau.workflows?.refresh();
    await waitUntil(
      () =>
        harness.bureau.workflows?.list().find((entry) => entry.id === 'watcher')?.version !==
        before,
      { message: 'the catalog to hold the changed file' },
    );
    release();
    await applying;
    await queued;

    const gone = async () => {
      const remaining = await keysOf(storage, 'plugin:x:trigger:cursor:watcher:');
      return remaining.length === 0;
    };
    await waitUntil(gone, { message: 'the state of the changed file to go' });
    // It went only after the trigger that wrote it had stopped.
    expect(deletions.filter(({ prefix }) => prefix.includes(':cursor:watcher:'))).toEqual([
      { prefix: 'plugin:x:trigger:cursor:watcher:', stopped: true },
    ]);
  });
});
