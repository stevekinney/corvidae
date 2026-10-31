/**
 * COR-1874 — the supervisor that keeps the contributed triggers equal to the workflow files'. It
 * never starts a trigger once it is closed, however far into a reconcile the close lands.
 */
import { describe, expect, it } from 'bun:test';
import type { PluginTriggerKind } from '@lostgradient/interborough-plugin';
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
): VersionedCatalogEntry<PluginTriggerKind> {
  return {
    kind: 'trigger-kind',
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
  kind: VersionedCatalogEntry<PluginTriggerKind>,
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
