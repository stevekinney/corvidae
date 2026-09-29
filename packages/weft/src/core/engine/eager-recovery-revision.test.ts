/**
 * Eager-registered type recovery re-stamps (or refuses) `WorkflowState.revision`
 * (COR-13). Every case restarts a fresh `Engine` on the same `MemoryStorage`
 * with a redeployed eager definition and drives `resume()` / `recoverAll()`.
 */
import { describe, expect, it } from 'bun:test';

import { z } from 'zod';
import { WORKFLOW_CATALOG_KEYS } from '../../storage/catalog-keys.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { OWNERSHIP_CLAIM_KEYS } from '../../storage/ownership-keys.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';

import { decode, encode } from '../codec.ts';
import { workflow, type WorkflowContext, type WorkflowState } from '../types.ts';
import { VersionMismatchError } from '../versioning.ts';
import { ensureWorkflowCatalogReady } from './catalog-readiness.ts';
import { getWorkflowRevisionDiagnostics } from './catalog-removal.ts';
import { Engine } from './index.ts';
import { prepareResumeState } from './lifecycle/persist.ts';
import { EagerRecoveryRevisionRefusedError } from './revision-errors.ts';

const TYPE = 'eager-restamp';

type Variant = 'a' | 'b' | 'incompatible' | 'version-bump';

function definitionFor(variant: Variant) {
  const body = async function* (ctx: WorkflowContext) {
    const value = yield* ctx.waitForSignal<string>('continue');
    yield* ctx.run(async function afterSignal() {
      return value;
    });
    return `done:${value}`;
  };
  switch (variant) {
    case 'a':
      return workflow({ name: TYPE, version: '1.0.0' }).execute(body);
    case 'b':
      return workflow({ name: TYPE, version: '1.0.0', description: 'revision-b' }).execute(body);
    case 'incompatible':
      return workflow({ name: TYPE, version: '1.0.0', outputSchema: z.string() }).execute(body);
    case 'version-bump':
      return workflow({ name: TYPE, version: '1.1.0' }).execute(body);
  }
}

async function readState(storage: MemoryStorage, id: string): Promise<WorkflowState> {
  const bytes = await storage.get(KEYS.workflow(id));
  if (bytes === null) {
    throw new Error(`Expected stored workflow state for ${id}`);
  }
  return decode(bytes) as WorkflowState;
}

async function snapshot(storage: MemoryStorage, exclude: string[] = []) {
  const entries: [string, string][] = [];
  for await (const [key, value] of storage.scan('')) {
    if (!exclude.includes(key)) {
      entries.push([key, Buffer.from(value).toString('base64')]);
    }
  }
  return entries.sort(([left], [right]) => (left < right ? -1 : 1));
}

/** Starts `ids` under revision A, parks them on a signal, and returns A. */
async function seedParkedRuns(storage: MemoryStorage, ids: string[]): Promise<string> {
  await using original = new Engine({ storage });
  original.register(definitionFor('a'));
  for (const id of ids) {
    await original.start(TYPE, null, { id });
  }
  for (const id of ids) {
    await waitForCondition(async () => (await storage.get(KEYS.checkpoint(id))) !== null, {
      label: `checkpoint for ${id}`,
    });
  }
  const revision = (await readState(storage, ids[0]!)).revision;
  if (revision === undefined) {
    throw new Error('Expected the seeded run to carry a revision');
  }
  return revision;
}

async function redeployedEngine(
  storage: MemoryStorage,
  variant: Variant,
  options: { ownership?: 'workflow-lease' } = {},
) {
  const engine = new Engine({ storage, checkpointHistory: 20, ...options });
  engine.register(definitionFor(variant));
  await ensureWorkflowCatalogReady(engine);
  return engine;
}

async function revisionOfRedeploy(variant: Variant): Promise<string> {
  const scratch = new MemoryStorage();
  await using engine = new Engine({ storage: scratch });
  engine.register(definitionFor(variant));
  await engine.start(TYPE, null, { id: 'probe' });
  await waitForCondition(async () => (await scratch.get(KEYS.checkpoint('probe'))) !== null, {
    label: 'probe checkpoint',
  });
  return (await readState(scratch, 'probe')).revision!;
}

describe('eager-type recovery revision policy (COR-13)', () => {
  it('re-stamps a compatible redeploy and attributes post-recovery checkpoints to the new revision', async () => {
    const storage = new MemoryStorage();
    const revisionA = await seedParkedRuns(storage, ['restamp-run']);
    const revisionB = await revisionOfRedeploy('b');
    expect(revisionB).not.toBe(revisionA);

    await using engine = await redeployedEngine(storage, 'b');
    expect(
      (await getWorkflowRevisionDiagnostics(engine, TYPE, revisionA)).references,
    ).toMatchObject({ nonTerminalRuns: 1 });

    const handles = await engine.recoverAll();
    expect(handles.map((handle) => handle.id)).toEqual(['restamp-run']);
    expect((await readState(storage, 'restamp-run')).revision).toBe(revisionB);
    expect(
      (await getWorkflowRevisionDiagnostics(engine, TYPE, revisionA)).references.nonTerminalRuns,
    ).toBe(0);
    expect(
      (await getWorkflowRevisionDiagnostics(engine, TYPE, revisionB)).references.nonTerminalRuns,
    ).toBe(1);

    await handles[0]!.signal('continue', 'x');
    expect(await handles[0]!.result()).toBe('done:x');

    const checkpoints = await engine.listCheckpoints('restamp-run');
    const lastStep = Math.max(...checkpoints.map((checkpoint) => checkpoint.step));
    const replay = await engine.replayTo('restamp-run', lastStep);
    expect(replay?.revision).toBe(revisionB);
    // No later write reverts the re-stamp.
    expect((await readState(storage, 'restamp-run')).revision).toBe(revisionB);
  });

  it('re-stamps and reactivates a suspended run in one recovery', async () => {
    const storage = new MemoryStorage();
    await seedParkedRuns(storage, ['suspended-run']);
    const revisionB = await revisionOfRedeploy('b');
    const suspended = await readState(storage, 'suspended-run');
    suspended.status = 'suspended';
    await storage.put(KEYS.workflow('suspended-run'), encode(suspended));

    await using engine = await redeployedEngine(storage, 'b');
    await engine.resume('suspended-run');

    const persisted = await readState(storage, 'suspended-run');
    expect(persisted.status).toBe('running');
    expect(persisted.revision).toBe(revisionB);
  });

  describe('incompatible redeploy', () => {
    it('refuses resume() and rethrows from recoverAll() without writing state or invoking the hook', async () => {
      const storage = new MemoryStorage();
      const revisionA = await seedParkedRuns(storage, ['a-refused', 'b-sibling']);
      const revisionB = await revisionOfRedeploy('incompatible');

      await using engine = await redeployedEngine(storage, 'incompatible');
      const before = await snapshot(storage);

      const rejection = await throwingRejectionOf(engine.resume('a-refused'));
      expect(rejection).toBeInstanceOf(EagerRecoveryRevisionRefusedError);
      const refusal = rejection as unknown as EagerRecoveryRevisionRefusedError;
      expect(refusal.persistedRevision).toBe(revisionA);
      expect(refusal.registeredRevision).toBe(revisionB);
      expect(refusal.reason).toBe('incompatible');
      expect(refusal.compatibilityReasons).toContain('contract-hash-mismatch');
      expect(refusal.compatibilityReasons.length).toBeGreaterThan(0);

      const recovered: string[] = [];
      const batchRejection = await throwingRejectionOf(
        engine.recoverAll({
          onRecoveredWorkflow: (info) => {
            recovered.push(info.workflowId);
          },
        }),
      );
      expect(batchRejection).toBeInstanceOf(EagerRecoveryRevisionRefusedError);
      expect(recovered).toEqual([]);
      expect(await snapshot(storage)).toEqual(before);
      expect((await readState(storage, 'b-sibling')).status).toBe('running');
      expect(
        (await getWorkflowRevisionDiagnostics(engine, TYPE, revisionA)).references.nonTerminalRuns,
      ).toBe(2);
      expect(
        (await getWorkflowRevisionDiagnostics(engine, TYPE, revisionB)).references.nonTerminalRuns,
      ).toBe(0);
    });

    it('writes nothing under workflow-lease ownership other than claim churn', async () => {
      const storage = new MemoryStorage();
      {
        await using original = new Engine({ storage, ownership: 'workflow-lease' });
        original.register(definitionFor('a'));
        await original.start(TYPE, null, { id: 'leased' });
        await waitForCondition(
          async () => (await storage.get(KEYS.checkpoint('leased'))) !== null,
          {
            label: 'leased checkpoint',
          },
        );
      }
      await using engine = await redeployedEngine(storage, 'incompatible', {
        ownership: 'workflow-lease',
      });
      const exclude = [
        OWNERSHIP_CLAIM_KEYS.workflowOwnerEpoch('leased'),
        OWNERSHIP_CLAIM_KEYS.workflowOwnerHolder('leased'),
      ];
      const before = await snapshot(storage, exclude);
      expect(await throwingRejectionOf(engine.resume('leased'))).toBeInstanceOf(
        EagerRecoveryRevisionRefusedError,
      );
      expect(await snapshot(storage, exclude)).toEqual(before);
    });

    it('does not refuse a default fork', async () => {
      const storage = new MemoryStorage();
      const revisionA = await seedParkedRuns(storage, ['fork-source-incompatible']);
      await using engine = await redeployedEngine(storage, 'incompatible');
      const fork = await engine.fork('fork-source-incompatible');
      expect((await readState(storage, fork.id)).revision).toBe(revisionA);
    });
  });

  describe('unreadable persisted manifest', () => {
    it('refuses when the persisted catalog entry is absent', async () => {
      const storage = new MemoryStorage();
      const revisionA = await seedParkedRuns(storage, ['absent-entry']);
      await storage.delete(WORKFLOW_CATALOG_KEYS.catalogEntry(TYPE, revisionA));

      await using engine = await redeployedEngine(storage, 'b');
      const before = await snapshot(storage);
      const rejection = await throwingRejectionOf(engine.resume('absent-entry'));
      expect(rejection).toBeInstanceOf(EagerRecoveryRevisionRefusedError);
      expect((rejection as unknown as EagerRecoveryRevisionRefusedError).reason).toBe(
        'persisted-revision-not-installed',
      );
      expect(await snapshot(storage)).toEqual(before);
    });

    it('propagates a corrupt catalog entry unwrapped and writes nothing', async () => {
      const storage = new MemoryStorage();
      const revisionA = await seedParkedRuns(storage, ['corrupt-entry']);

      await using engine = await redeployedEngine(storage, 'b');
      await storage.put(
        WORKFLOW_CATALOG_KEYS.catalogEntry(TYPE, revisionA),
        new Uint8Array([0xff, 0x00, 0x01]),
      );
      const before = await snapshot(storage);
      const rejection = await throwingRejectionOf(engine.resume('corrupt-entry'));
      expect(rejection).not.toBeInstanceOf(EagerRecoveryRevisionRefusedError);
      expect(await snapshot(storage)).toEqual(before);
    });
  });

  describe('no-op cases', () => {
    it('leaves a legacy run with no persisted revision untouched', async () => {
      const storage = new MemoryStorage();
      await seedParkedRuns(storage, ['legacy-run']);
      const legacy = (await readState(storage, 'legacy-run')) as Record<string, unknown>;
      delete legacy['revision'];
      await storage.put(KEYS.workflow('legacy-run'), encode(legacy));
      const before = await storage.get(KEYS.workflow('legacy-run'));

      await using engine = await redeployedEngine(storage, 'incompatible');
      await engine.recoverAll();

      expect(await storage.get(KEYS.workflow('legacy-run'))).toEqual(before);
    });

    it('does not write when the persisted revision equals the registered revision', async () => {
      const storage = new MemoryStorage();
      await seedParkedRuns(storage, ['same-revision']);
      const before = await storage.get(KEYS.workflow('same-revision'));

      await using engine = await redeployedEngine(storage, 'a');
      await engine.recoverAll();

      expect(await storage.get(KEYS.workflow('same-revision'))).toEqual(before);
    });
  });

  describe('version precedence', () => {
    it('still fails the run with VersionMismatchError by default', async () => {
      const storage = new MemoryStorage();
      await seedParkedRuns(storage, ['version-run']);
      await using engine = await redeployedEngine(storage, 'version-bump');

      await engine.recoverAll();

      const summary = await engine.get('version-run');
      expect(summary?.status).toBe('failed');
      expect(summary?.failureCategory).toBe('system');
      expect(summary?.error).toContain('Version mismatch');
    });

    it("rethrows VersionMismatchError under versionMismatchPolicy 'throw'", async () => {
      const storage = new MemoryStorage();
      await seedParkedRuns(storage, ['version-throw']);
      await using engine = await redeployedEngine(storage, 'version-bump');

      expect(
        await throwingRejectionOf(engine.recoverAll({ versionMismatchPolicy: 'throw' })),
      ).toBeInstanceOf(VersionMismatchError);
    });
  });

  describe('default fork', () => {
    it('pins A for a not-yet-recovered run and B for a run recovery re-stamped', async () => {
      const storage = new MemoryStorage();
      const revisionA = await seedParkedRuns(storage, ['fork-source']);
      const revisionB = await revisionOfRedeploy('b');
      await using engine = await redeployedEngine(storage, 'b');

      const beforeRecovery = await engine.fork('fork-source');
      expect((await readState(storage, beforeRecovery.id)).revision).toBe(revisionA);

      await engine.resume('fork-source');
      const afterRecovery = await engine.fork('fork-source');
      expect((await readState(storage, afterRecovery.id)).revision).toBe(revisionB);
    });
  });

  describe('prepareResumeState() direct', () => {
    const checkpoint = { workflowId: 'unit', step: 0, version: '1', locals: {} } as never;
    const state = {
      id: 'unit',
      type: TYPE,
      revision: 'sha256:persisted',
      versionTuple: { workflowVersion: '1' },
    } as unknown as WorkflowState;
    const callbacks = {} as never;

    it("refuses with 'registered-revision-unknown' when the eager type has no registered revision", async () => {
      const internals = {
        options: { getNow: () => 0 },
        storage: new MemoryStorage(),
        registrations: new Map([[TYPE, {}]]),
        registeredCatalogRevisions: new Map<string, string>(),
        workflowCatalog: null,
      };
      const rejection = await throwingRejectionOf(
        prepareResumeState(
          internals as never,
          'unit',
          state,
          checkpoint,
          new Uint8Array(),
          { version: '1' } as never,
          callbacks,
        ),
      );
      expect(rejection).toBeInstanceOf(EagerRecoveryRevisionRefusedError);
      expect((rejection as unknown as EagerRecoveryRevisionRefusedError).reason).toBe(
        'registered-revision-unknown',
      );
    });

    it('returns without reading registrations when the state has no revision', async () => {
      const internals = {
        options: { getNow: () => 0 },
        storage: new MemoryStorage(),
        get registrations(): never {
          throw new Error('registrations must not be read for a legacy record');
        },
      };
      const prepared = await prepareResumeState(
        internals as never,
        'unit',
        { ...state, revision: undefined } as WorkflowState,
        checkpoint,
        new Uint8Array(),
        { version: '1' } as never,
        callbacks,
      );
      expect(prepared.restampRevision).toBeUndefined();
    });
  });
});
