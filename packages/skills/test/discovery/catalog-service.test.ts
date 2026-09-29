import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createManualRuntimeServices } from '@lostgradient/lifecycle';

import { findRecord } from '../../src/discovery/catalog';
import {
  createSkillCatalogService,
  type SkillCatalogRefreshSnapshot,
} from '../../src/discovery/catalog-service';
import type { RemoteSkillSource } from '../../src/discovery/remote';
import type { SkillSource, SkillTrustPolicy } from '../../src/discovery/source';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'corvidae-skill-catalog-'));
  roots.push(root);
  return root;
}

async function writeSkill(root: string, name: string, description?: string): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: ${description ?? `Description for ${name}`}`,
      '---',
      '',
      'Body.',
      '',
    ].join('\n'),
  );
}

const trustEverything: SkillTrustPolicy = {
  decide: () => ({ state: 'trusted', reason: 'test policy' }),
};

function sourcesFor(root: string): SkillSource[] {
  return [{ id: 'user', kind: 'user', location: root, precedence: 20 }];
}

let tick = 0;
const now = (): string => {
  tick += 1;
  return new Date(Date.UTC(2026, 8, 19, 0, 0, tick)).toISOString();
};

describe('createSkillCatalogService', () => {
  it('starts empty at revision 0 and starts no work to be read', async () => {
    const root = await scratch();
    await writeSkill(root, 'present');

    const service = createSkillCatalogService({ sources: sourcesFor(root), now });

    // A pure read: no scan has happened, so the skill on disk is deliberately not in the catalog
    // yet. Reading a catalog must never be what causes a filesystem walk.
    expect(service.catalog().revision).toBe(0);
    expect(service.catalog().records).toEqual([]);
    expect(service.catalog()).toBe(service.catalog());
  });

  it('commits a new revision and returns it by identity until the next commit', async () => {
    const root = await scratch();
    await writeSkill(root, 'first');

    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: trustEverything,
      now,
    });

    const result = await service.refresh().result();
    expect(result.outcome).toBe('committed');
    expect(result.previousRevision).toBe(0);
    expect(result.newRevision).toBe(1);

    const committed = service.catalog();
    expect(committed.revision).toBe(1);
    expect(findRecord(committed, 'first')?.available).toBe(true);
    // Identity, not equality: a caller diffs revisions by reference rather than entry by entry.
    expect(service.catalog()).toBe(committed);
  });

  it('keeps a bound revision unchanged when the filesystem changes underneath it', async () => {
    const root = await scratch();
    await writeSkill(root, 'original');

    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: trustEverything,
      now,
    });
    await service.refresh().result();

    // What a run holds.
    const bound = service.catalog();

    await writeSkill(root, 'added-later');
    await service.refresh().result();

    // This is the guarantee the whole revision model exists for: instructions already admitted to
    // a conversation cannot be rewritten underneath it by someone editing a file.
    expect(bound.revision).toBe(1);
    expect(bound.records.map((record) => record.name)).toEqual(['original']);
    expect(findRecord(bound, 'added-later')).toBeUndefined();

    expect(service.catalog().revision).toBe(2);
    expect(findRecord(service.catalog(), 'added-later')).toBeDefined();
  });

  it('commits nothing when a refresh finds the same content', async () => {
    const root = await scratch();
    await writeSkill(root, 'stable');

    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: trustEverything,
      now,
    });
    await service.refresh().result();
    const committed = service.catalog();

    const second = await service.refresh().result();

    expect(second.outcome).toBe('unchanged');
    expect(second.newRevision).toBeUndefined();
    // No new object on a poll that found no change, so a caller diffing by identity sees nothing.
    expect(service.catalog()).toBe(committed);
    expect(service.catalog().revision).toBe(1);
  });

  it('exposes a cached snapshot that starts nothing', async () => {
    const root = await scratch();
    await writeSkill(root, 'snapshotted');

    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: trustEverything,
      now,
    });
    const handle = service.refresh({ id: 'refresh-1' });

    const pending = handle.snapshot();
    expect(pending.id).toBe('refresh-1');
    expect(pending.kind).toBe('skill-catalog-refresh');
    expect(pending.status).toBe('pending');
    expect(pending.revision).toBe(1);
    expect(pending.previousRevision).toBe(0);
    expect(pending.cancellable).toBe(true);
    expect(pending.ownership).toBe('independent');
    expect(pending.projection).toBe('privileged');
    expect(pending.durability).toBe('process-local');
    expect(pending.detached).toBe(false);
    expect(pending.result).toBeUndefined();
    // Repeated reads of an unchanged state return one identical object.
    expect(handle.snapshot()).toBe(pending);

    await handle.result();

    const settled = handle.snapshot();
    expect(settled.status).toBe('settled');
    // This handle's own transition counter, deliberately not the catalog revision it committed.
    expect(settled.revision).toBe(2);
    expect(settled.result?.outcome).toBe('committed');
    expect(settled.result?.newRevision).toBe(1);
  });

  it('delivers the current snapshot to a subscriber before returning', async () => {
    const root = await scratch();
    await writeSkill(root, 'observed');

    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: trustEverything,
      now,
    });
    const handle = service.refresh();

    const seen: SkillCatalogRefreshSnapshot[] = [];
    handle.subscribeSnapshot((snapshot) => seen.push(snapshot));

    // Synchronously, before any await: a subscriber must never wait for the next transition to
    // learn the current state.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.status).toBe('pending');

    await handle.result();

    expect(seen).toHaveLength(2);
    expect(seen[1]?.status).toBe('settled');
  });

  it('delivers immediately and does not retain a subscriber added after settlement', async () => {
    const root = await scratch();
    await writeSkill(root, 'late');

    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: trustEverything,
      now,
    });
    const handle = service.refresh();
    await handle.result();

    const seen: SkillCatalogRefreshSnapshot[] = [];
    const unsubscribe = handle.subscribeSnapshot((snapshot) => seen.push(snapshot));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.status).toBe('settled');
    expect(() => unsubscribe()).not.toThrow();
  });

  it('cancels idempotently and commits nothing', async () => {
    const root = await scratch();
    await writeSkill(root, 'cancelled-skill');

    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: trustEverything,
      now,
    });
    const handle = service.refresh();
    handle.abort('test');
    handle.abort('test again');

    const result = await handle.result();

    expect(result.outcome).toBe('cancelled');
    expect(result.newRevision).toBeUndefined();
    expect(service.catalog().revision).toBe(0);
  });

  it('honours an externally supplied abort signal', async () => {
    const root = await scratch();
    await writeSkill(root, 'external');

    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: trustEverything,
      now,
    });

    const controller = new AbortController();
    controller.abort();
    const result = await service.refresh({ signal: controller.signal }).result();

    expect(result.outcome).toBe('cancelled');
  });

  it('acknowledges cleanup without claiming work it never did', async () => {
    const root = await scratch();
    await writeSkill(root, 'clean');

    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: trustEverything,
      now,
    });

    const uncancelled = service.refresh();
    await uncancelled.result();
    // Nothing was asked to stop and nothing outlives the scan.
    expect(await uncancelled.closed()).toBe('not-required');

    const cancelled = service.refresh();
    cancelled.abort();
    await cancelled.result();
    // A cancellation request disqualifies the `not-required` fast path: something was asked to
    // stop, so the acknowledgement reports on that.
    expect(await cancelled.closed()).toBe('completed');
  });

  it('memoizes the cleanup acknowledgement rather than re-deriving it', async () => {
    const root = await scratch();
    await writeSkill(root, 'memoized');

    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: trustEverything,
      now,
    });
    const handle = service.refresh();
    await handle.result();

    // Comparing two acknowledgement *strings* proves nothing — they would be equal whether or not
    // anything is memoized. The promise identity is the observable fact.
    const first = handle.closed();
    const second = handle.closed();
    expect(first).toBe(second);
    expect(await first).toBe('not-required');
  });

  it('never reports `not-required` for a cancellation that was actually requested', async () => {
    const root = await scratch();
    await writeSkill(root, 'raced');

    // Through an external signal, because `discoverSkills` resolves trust synchronously — before
    // `refresh()` has returned a handle there would be anything to call `abort()` on.
    const controller = new AbortController();
    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: {
        decide: () => {
          // Requested while the scan is genuinely in flight.
          controller.abort();
          return { state: 'trusted', reason: 'test policy' };
        },
      },
      now,
    });

    const handle = service.refresh({ signal: controller.signal });
    const result = await handle.result();

    // Honoured, that is `completed`; too late to take effect, `unresolved`. Never `not-required`,
    // which would claim there was nothing to stop.
    expect(['completed', 'unresolved']).toContain(await handle.closed());
    expect(['cancelled', 'committed']).toContain(result.outcome);
  });

  it('treats an abort after settlement as the documented no-op', async () => {
    const root = await scratch();
    await writeSkill(root, 'already-done');

    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: trustEverything,
      now,
    });
    const handle = service.refresh();
    await handle.result();

    handle.abort();

    // It cannot retroactively make cleanup something other than what it was: nothing was running
    // to stop, so claiming `unresolved` would invent a loose end.
    expect(await handle.closed()).toBe('not-required');
  });

  it('coalesces overlapping refreshes instead of losing one', async () => {
    const root = await scratch();
    await writeSkill(root, 'contended');

    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: trustEverything,
      now,
    });

    const first = service.refresh();
    const second = service.refresh();

    // Two refreshes reading the same `previousRevision` would both commit revision 1, putting two
    // different catalogs under one number and letting the slower silently overwrite the faster.
    const [a, b] = await Promise.all([first.result(), second.result()]);
    expect(a).toBe(b);
    expect(service.catalog().revision).toBe(1);
  });

  it('refuses to let a joiner cancel work it did not start', async () => {
    const root = await scratch();
    await writeSkill(root, 'not-yours');

    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: trustEverything,
      now,
    });

    const owner = service.refresh();
    const joiner = service.refresh();

    // Truthful at construction, which is exactly what the contract asks for: this capability is
    // genuinely unavailable on a joined handle, so `abort()` is its documented no-op.
    expect(joiner.snapshot().cancellable).toBe(false);
    expect(owner.snapshot().cancellable).toBe(true);

    joiner.abort();

    // The owner, who never cancelled, still gets their scan.
    const result = await owner.result();
    expect(result.outcome).toBe('committed');
    expect(service.catalog().revision).toBe(1);
  });

  it('abandons a refresh that never settles rather than wedging the service', async () => {
    const root = await scratch();
    await writeSkill(root, 'hung');

    const hungSource: RemoteSkillSource = {
      id: 'registry',
      kind: 'remote',
      location: 'https://example.invalid',
      precedence: 30,
      names: ['hung'],
      integrity: { publicKey: 'PEM' },
    };

    const runtime = createManualRuntimeServices({ origin: '2026-09-19T00:00:00.000Z' });
    const service = createSkillCatalogService({
      sources: [hungSource],
      // A transport that ignores its signal entirely.
      remote: {
        fetch: ((_input: RequestInfo | URL) =>
          new Promise<Response>(() => undefined)) as typeof globalThis.fetch,
      },
      refreshTimeoutMilliseconds: 50,
      runtime,
    });

    const wedged = service.refresh();
    await runtime.advance(49);
    expect(wedged.snapshot().status).toBe('pending');
    await runtime.advance(1);
    const result = await wedged.result();

    // Without a bound, this handle would hold the in-flight slot for the lifetime of the process
    // and every later refresh would join a scan that is never going to finish.
    expect(result.outcome).toBe('failed');
    expect(result.failureReason).toContain('exceeded');
    expect(result.completedAt).toBe(runtime.clock.nowISO());
    expect(runtime.pendingTimers()).toEqual([]);

    const recovered = service.refresh();
    expect(recovered.snapshot().cancellable).toBe(true);
  });

  it('starts a fresh refresh once the previous one settles', async () => {
    const root = await scratch();
    await writeSkill(root, 'sequential');

    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: trustEverything,
      now,
    });

    const first = service.refresh();
    await first.result();
    const second = service.refresh();

    expect(second).not.toBe(first);
    expect(second.snapshot().previousRevision).toBe(1);
  });

  it('keeps `result()` and `closed()` settling when an observer throws', async () => {
    const root = await scratch();
    await writeSkill(root, 'hostile-observer');

    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: trustEverything,
      now,
    });
    const handle = service.refresh();

    handle.subscribeSnapshot(() => {
      throw new Error('subscriber bug');
    });

    const later: string[] = [];
    handle.subscribeSnapshot((snapshot) => later.push(snapshot.status));

    // Both are documented never to reject, so a subscriber's bug must not become their failure.
    const result = await handle.result();
    expect(result.outcome).toBe('committed');
    // The remaining observer is still told.
    expect(later).toEqual(['pending', 'settled']);
    // A throw while delivering the *terminal* transition is a definite cleanup-notification
    // failure, and the acknowledgement says so.
    expect(await handle.closed()).toBe('failed');
  });

  it('does not propagate a throwing observer into subscribeSnapshot itself', async () => {
    const root = await scratch();
    await writeSkill(root, 'immediate-throw');

    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: trustEverything,
      now,
    });
    const handle = service.refresh();

    expect(() =>
      handle.subscribeSnapshot(() => {
        throw new Error('subscriber bug');
      }),
    ).not.toThrow();

    await handle.result();
  });

  it('reports a failed discovery rather than rejecting', async () => {
    const root = await scratch();
    await writeSkill(root, 'doomed');

    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      // A policy bug is a policy bug, not an untrusted source — but it must not become a rejected
      // promise out of an API documented never to reject.
      trustPolicy: {
        decide: () => {
          throw new Error('trust policy exploded');
        },
      },
      now,
    });

    const handle = service.refresh();
    const result = await handle.result();
    expect(result.outcome).toBe('failed');
    expect(result.failureReason).toContain('trust policy exploded');
    // Asserted on the handle under test, not a second refresh. A *refresh* that failed is not a
    // *teardown* that failed: the scan produced nothing, and this handle's own cleanup still
    // completed normally, so reporting `failed` would send a caller hunting leaks that do not exist.
    expect(await handle.closed()).toBe('not-required');
  });

  it('freezes a revision all the way down', async () => {
    const root = await scratch();
    await writeSkill(root, 'deeply-frozen');

    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: trustEverything,
      now,
    });
    await service.refresh().result();

    const revision = service.catalog();
    const record = revision.records[0]!;

    // `Object.freeze` is shallow. Freezing only the revision and its arrays left every record and
    // every nested diagnostics array writable, so one holder could mutate an entry and change what
    // every other holder saw — while the digest still attested to the original.
    expect(Object.isFrozen(revision)).toBe(true);
    expect(Object.isFrozen(revision.records)).toBe(true);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.compatibility)).toBe(true);
    expect(Object.isFrozen(record.compatibility.diagnostics)).toBe(true);
    expect(Object.isFrozen(revision.sourceDiagnostics)).toBe(true);
  });

  it('resolves result() to the same terminal object for every caller', async () => {
    const root = await scratch();
    await writeSkill(root, 'shared-result');

    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: trustEverything,
      now,
    });
    const handle = service.refresh();

    const [first, second] = await Promise.all([handle.result(), handle.result()]);
    expect(first).toBe(second);
  });

  it('starts from a supplied revision', async () => {
    const root = await scratch();
    await writeSkill(root, 'seeded');

    const service = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: trustEverything,
      now,
    });
    await service.refresh().result();

    const resumed = createSkillCatalogService({
      sources: sourcesFor(root),
      trustPolicy: trustEverything,
      initial: service.catalog(),
      now,
    });

    // Cloned, not adopted by reference: the service's immutability guarantee must not depend on
    // the caller never touching the revision it handed in.
    expect(resumed.catalog()).not.toBe(service.catalog());
    expect(resumed.catalog().revision).toBe(1);
    expect(resumed.catalog().digest).toBe(service.catalog().digest);
    // A refresh continues the numbering rather than restarting it.
    const result = await resumed.refresh().result();
    expect(result.previousRevision).toBe(1);
  });
});
