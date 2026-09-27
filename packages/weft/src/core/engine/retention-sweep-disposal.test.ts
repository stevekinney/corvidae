import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { ActivityRegistry } from '../activity-registry.ts';
import { Engine } from '../engine.ts';
import { CleanupWarningEvent } from '../events.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { workflowSource } from '../source/index.ts';
import { workflow } from '../types.ts';
import { copyWorkflowDefinition } from './construction.ts';
import { getInternals } from './internals.ts';
import { buildRegistrationEntry } from './registration.ts';

/**
 * A `MemoryStorage` whose `get` of one armed key parks until the test releases
 * it, so a retention sweep can be held at an exact point while the test
 * disposes the engine underneath it.
 */
class GatedGetStorage extends MemoryStorage {
  #armedKey: string | null = null;
  #reached = Promise.withResolvers<void>();
  #release = Promise.withResolvers<void>();

  arm(key: string): void {
    this.#armedKey = key;
  }

  get reached(): Promise<void> {
    return this.#reached.promise;
  }

  release(): void {
    this.#armedKey = null;
    this.#release.resolve();
  }

  override async get(key: string): Promise<Uint8Array | null> {
    if (key === this.#armedKey) {
      this.#reached.resolve();
      await this.#release.promise;
    }
    return super.get(key);
  }
}

const TYPE = 'retention-sweep-disposal';
const WORKFLOW_ID = 'retention-sweep-disposal-run';

/**
 * An engine with a 1s completed-run retention and a live 10ms sweep, holding
 * one completed run that becomes purge-eligible once `clock.now` advances.
 */
async function createEngineWithCompletedRun(storage: GatedGetStorage) {
  const clock = { now: 5_000 };
  const engine = new Engine({
    storage,
    getNow: () => clock.now,
    retention: { completed: '1s' },
    retentionSweepInterval: '10ms',
  });
  engine.register(
    workflow({ name: TYPE }).execute(async function* () {
      return 'done';
    }),
  );
  const warnings: CleanupWarningEvent[] = [];
  engine.addEventListener(CleanupWarningEvent.type, (event) => {
    warnings.push(event);
  });
  const handle = await engine.start(TYPE, null, { id: WORKFLOW_ID });
  await handle.result();
  return { clock, engine, warnings };
}

async function holdSweepAt(storage: GatedGetStorage, clock: { now: number }, key: string) {
  storage.arm(key);
  clock.now += 1_500; // past the 1s retention window: the next sweep purges the run
  await storage.reached;
}

describe('retention sweep disposal', () => {
  it('a sweep still scanning when the engine is disposed purges nothing afterwards and reports no cleanup warning', async () => {
    const storage = new GatedGetStorage();
    const { clock, engine, warnings } = await createEngineWithCompletedRun(storage);
    // The sweep's terminal-index scan reads each candidate's state record
    // before deciding whether to purge it.
    await holdSweepAt(storage, clock, KEYS.workflow(WORKFLOW_ID));
    const sweep = getInternals(engine).retentionSweepInFlight;
    expect(sweep).not.toBeNull();

    engine[Symbol.dispose]();
    storage.release();
    await sweep;

    expect(await storage.get(KEYS.workflow(WORKFLOW_ID))).not.toBeNull();
    expect(warnings).toEqual([]);
  });

  it('a sweep already collecting a purge when the engine is disposed does not commit it', async () => {
    const storage = new GatedGetStorage();
    const { clock, engine, warnings } = await createEngineWithCompletedRun(storage);
    // Reading the run's attribute record is the purge's own delete-set
    // collection, after eligibility is decided and before the commit.
    await holdSweepAt(storage, clock, KEYS.attribute(WORKFLOW_ID));
    const sweep = getInternals(engine).retentionSweepInFlight;
    expect(sweep).not.toBeNull();

    engine[Symbol.dispose]();
    storage.release();
    await sweep;

    expect(await storage.get(KEYS.workflow(WORKFLOW_ID))).not.toBeNull();
    expect(warnings).toEqual([]);
  });

  it('async disposal resolves only after an in-flight sweep has settled', async () => {
    const storage = new GatedGetStorage();
    const { clock, engine } = await createEngineWithCompletedRun(storage);
    await holdSweepAt(storage, clock, KEYS.workflow(WORKFLOW_ID));

    let disposalSettled = false;
    const disposal = engine[Symbol.asyncDispose]().then(() => {
      disposalSettled = true;
    });
    // The held storage read is the sweep's only pending work, so nothing but
    // the release below can let it, and therefore disposal, finish.
    await Bun.sleep(0);
    expect(disposalSettled).toBe(false);

    storage.release();
    await disposal;

    expect(getInternals(engine).retentionSweepInFlight).toBeNull();
    expect(await storage.get(KEYS.workflow(WORKFLOW_ID))).not.toBeNull();
  });

  it('async disposal after a synchronous disposal still waits for the in-flight sweep', async () => {
    const storage = new GatedGetStorage();
    const { clock, engine } = await createEngineWithCompletedRun(storage);
    await holdSweepAt(storage, clock, KEYS.workflow(WORKFLOW_ID));

    engine[Symbol.dispose]();
    let disposalSettled = false;
    const disposal = engine[Symbol.asyncDispose]().then(() => {
      disposalSettled = true;
    });
    await Bun.sleep(0);
    expect(disposalSettled).toBe(false);

    storage.release();
    await disposal;

    expect(getInternals(engine).retentionSweepInFlight).toBeNull();
    expect(await storage.get(KEYS.workflow(WORKFLOW_ID))).not.toBeNull();
  });

  it('a sweep checking an orphaned terminal-index entry when the engine is disposed leaves the entry in place', async () => {
    // The scan deletes a terminal-index entry whose state record is gone. That
    // self-heal is still a storage write, so it must not land after disposal.
    const storage = new GatedGetStorage();
    const now = 5_000;
    const engine = new Engine({
      storage,
      getNow: () => now,
      retention: { completed: '1s' },
      retentionSweepInterval: '10ms',
    });
    const warnings: CleanupWarningEvent[] = [];
    engine.addEventListener(CleanupWarningEvent.type, (event) => {
      warnings.push(event);
    });
    const orphanId = 'retention-sweep-disposal-orphan';
    const orphanIndexKey = KEYS.terminalWorkflow(1_000, orphanId); // past the 1s window
    storage.arm(KEYS.workflow(orphanId));
    await storage.put(orphanIndexKey, new Uint8Array());
    await storage.reached;
    const sweep = getInternals(engine).retentionSweepInFlight;
    expect(sweep).not.toBeNull();

    engine[Symbol.dispose]();
    storage.release();
    await sweep;

    expect(await storage.get(orphanIndexKey)).not.toBeNull();
    expect(warnings).toEqual([]);
  });

  it('a sweep resolving a dynamic source when the engine is disposed reports no cleanup warning', async () => {
    // Disposal aborts the sweep's in-flight source load with an
    // `EngineDisposedError`. That is the engine shutting down as asked, not a
    // cleanup failure, so it must not surface as a `retentionSweep` warning.
    const storage = new MemoryStorage();
    const type = 'retention-sweep-disposal-dynamic';
    const definition = workflow({ name: type }).execute(async function* () {
      return 'done';
    });
    const manifest = await buildWorkflowManifestFromDefinition(
      copyWorkflowDefinition(type, buildRegistrationEntry(type, definition)),
      new ActivityRegistry().listDefinitions(),
    );
    const descriptor = {
      name: type,
      location: './only.ts',
      exportName: 'only' as const,
      revision: manifest.revision,
    };
    const workflowId = 'retention-sweep-disposal-dynamic-run';
    let now = 5_000;

    {
      // Seed the run from a separate engine, so the sweeping engine below has
      // the revision registered but never resolved and must load it.
      await using seedingEngine = new Engine({ storage, getNow: () => now });
      seedingEngine.registerSource(workflowSource(descriptor, async () => ({ only: definition })));
      const handle = await seedingEngine.start(type, null, { id: workflowId });
      await handle.result();
    }

    const loadStarted = Promise.withResolvers<void>();
    const releaseLoad = Promise.withResolvers<{ only: typeof definition }>();
    const engine = new Engine({
      storage,
      getNow: () => now,
      retention: { completed: '1s' },
      retentionSweepInterval: '10ms',
    });
    const warnings: CleanupWarningEvent[] = [];
    engine.addEventListener(CleanupWarningEvent.type, (event) => {
      warnings.push(event);
    });
    engine.registerSource(
      workflowSource(descriptor, () => {
        loadStarted.resolve();
        return releaseLoad.promise;
      }),
    );

    now += 1_500;
    await loadStarted.promise;
    const sweep = getInternals(engine).retentionSweepInFlight;
    expect(sweep).not.toBeNull();

    engine[Symbol.dispose]();
    await sweep;
    releaseLoad.resolve({ only: definition });

    expect(warnings).toEqual([]);
    expect(await storage.get(KEYS.workflow(workflowId))).not.toBeNull();
  });
});
