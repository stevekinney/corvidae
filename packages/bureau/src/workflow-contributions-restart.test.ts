/**
 * COR-1874 — the outcome matrix of a workflow revision that pins a contributed activity, for a new
 * run and for a run waiting across a restart, when the pinned version is loaded, another version
 * is, or none is.
 *
 * | pinned `x:y@1`        | new run                                  | waiting run after a restart                          |
 * | --------------------- | ---------------------------------------- | ---------------------------------------------------- |
 * | loaded                | runs on 1                                | resumes on 1                                         |
 * | another version (2)   | file floats: a new revision, runs on 2   | cancelled, `version-mismatch`; never resumes on 2    |
 * | not loaded            | the file is invalid                      | cancelled, `missing`                                 |
 *
 * On `main` a revision records no version, so the same file registered under version 1 and under
 * version 2 is one revision and a run parked under 1 resumes on 2 (see the Weft test
 * `document-activity-versions.test.ts` for the engine half).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';
import { waitUntil } from '@lostgradient/testing/wait-until';

import { createSqliteStorageFixture } from './test/storage-fixtures';
import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';
import {
  activityAnswer,
  contributionCatalog,
  createTickerController,
} from './testing/workflow-contributions.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';

/** The engine a Bureau composes, as `durableEngine()` hands it out. */
type DurableEngine = NonNullable<ReturnType<WorkflowBureauHarness['bureau']['durableEngine']>>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const pipeline = (overrides: Record<string, unknown> = {}) =>
  workflowFileText('pipeline', {
    trigger: { kind: 'schedule', spec: '1h' },
    steps: [
      { kind: 'await-signal', signal: 'go' },
      { kind: 'activity', handler: 'x:y', input: 'hello' },
    ],
    ...overrides,
  });

/** A store and a workflow directory that outlive the Bureaus started over them. */
async function storeAndFiles() {
  const root = await mkdtemp(join(tmpdir(), 'bureau-contributions-restart-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const database = createSqliteStorageFixture({ path: join(root, 'bureau.sqlite') });
  cleanups.push(() => database.dispose());
  const directory = join(root, 'workflows');
  const bureauOver = async (activityVersion: string | undefined, ticker = false) => {
    const harness = await startWorkflowBureau({
      directory,
      overrides: {
        // A getter: each Bureau started with these overrides opens its own handle.
        get storage() {
          return database.open();
        },
        durableOwnership: { ownership: 'none' },
        onDiagnostic: () => undefined,
        contributionCatalog: contributionCatalog({
          activityVersion,
          ticker: ticker ? createTickerController() : undefined,
        }),
      },
    });
    cleanups.push(() => harness.dispose());
    return harness;
  };
  return { bureauOver };
}

/** Park a run of `pipeline` on its signal in a Bureau that has `x:y@1`, then close that Bureau. */
async function parkedAtVersionOne(
  bureauOver: Awaited<ReturnType<typeof storeAndFiles>>['bureauOver'],
  fileText = pipeline(),
): Promise<void> {
  const first = await bureauOver('1');
  await first.put('pipeline.json', fileText);
  await first.bureau.workflows?.refresh();
  const engine = first.bureau.durableEngine()!;
  await engine.start('pipeline', null, { id: 'waiting' });
  await waitUntil(() => waitsForGo(engine, 'waiting'), {
    message: 'the run to wait for its signal',
  });
  await first.dispose();
}

/** Whether the run `id` is parked on the signal `go`. */
async function waitsForGo(engine: DurableEngine, id: string): Promise<boolean> {
  const state = await engine.get(id);
  return state?.waitingForSignals?.includes('go') === true;
}

async function resumed(harness: WorkflowBureauHarness): Promise<unknown> {
  const engine = harness.bureau.durableEngine()!;
  await engine.signal('waiting', 'go', null);
  const handle = await engine.getHandle('waiting');
  return handle.result();
}

describe('a run waiting across a restart, on a revision that pins x:y@1', () => {
  it('resumes on version 1 when version 1 is loaded', async () => {
    const { bureauOver } = await storeAndFiles();
    await parkedAtVersionOne(bureauOver);

    const second = await bureauOver('1');
    expect(await resumed(second)).toBe(activityAnswer('1', 'hello'));
    const run = await second.bureau.workflows?.getRun('waiting');
    expect(run?.unresumable).toBeUndefined();
  });

  it('is reported version-mismatch, and never resumed on version 2, when only version 2 is loaded', async () => {
    const { bureauOver } = await storeAndFiles();
    await parkedAtVersionOne(bureauOver);

    const second = await bureauOver('2');
    const run = await second.bureau.workflows?.getRun('waiting');
    expect(run?.status).toBe('cancelled');
    expect(run?.unresumable).toEqual({
      reason: 'version-mismatch',
      activity: 'x:y@1',
      availableVersions: ['2'],
    });
    expect(run?.error).toContain('x:y@1');
    expect(second.bureau.workflows?.list().find((entry) => entry.id === 'pipeline')?.state).toBe(
      'ready',
    );
  });

  it('is reported missing when no version is loaded', async () => {
    const { bureauOver } = await storeAndFiles();
    await parkedAtVersionOne(bureauOver);

    const second = await bureauOver(undefined);
    const run = await second.bureau.workflows?.getRun('waiting');
    expect(run?.status).toBe('cancelled');
    expect(run?.unresumable).toEqual({
      reason: 'missing',
      activity: 'x:y@1',
      availableVersions: [],
    });
    expect(second.bureau.workflows?.list().find((entry) => entry.id === 'pipeline')?.state).toBe(
      'invalid',
    );
  });

  it('is reported version-mismatch when the file is gone and only version 2 is loaded', async () => {
    const { bureauOver } = await storeAndFiles();
    await parkedAtVersionOne(bureauOver);
    const first = await bureauOver('1');
    await rm(join(first.directory, 'pipeline.json'));
    await first.dispose();

    const second = await bureauOver('2');
    const run = await second.bureau.workflows?.getRun('waiting');
    expect(run?.unresumable?.reason).toBe('version-mismatch');
  });
});

describe('a new run, with the file unchanged', () => {
  it('runs on the version that is loaded now, as a new revision', async () => {
    const { bureauOver } = await storeAndFiles();
    await parkedAtVersionOne(bureauOver);
    const first = await bureauOver('1');
    const versionOne = first.bureau.workflows?.list().find((entry) => entry.id === 'pipeline');
    await first.dispose();

    const second = await bureauOver('2');
    const versionTwo = second.bureau.workflows?.list().find((entry) => entry.id === 'pipeline');
    expect(versionTwo?.version).not.toBe(versionOne?.version);

    const engine = second.bureau.durableEngine()!;
    await engine.start('pipeline', null, { id: 'fresh' });
    await waitUntil(() => waitsForGo(engine, 'fresh'), {
      message: 'the new run to wait for its signal',
    });
    await engine.signal('fresh', 'go', null);
    const handle = await engine.getHandle('fresh');
    expect(await handle.result()).toBe(activityAnswer('2', 'hello'));
    const fresh = await second.bureau.workflows?.getRun('fresh');
    expect(fresh?.workflowVersion).toBe(versionTwo?.version);
  });
});

describe('a run waiting on a revision whose trigger kind is no longer loaded', () => {
  it('still resumes: only the activity is pinned, and a started run does not need its trigger', async () => {
    const { bureauOver } = await storeAndFiles();
    const first = await bureauOver('1', true);
    await first.put(
      'pipeline.json',
      pipeline({ trigger: { kind: 'x:ticker', channel: 'alerts' } }),
    );
    await first.bureau.workflows?.refresh();
    const engine = first.bureau.durableEngine()!;
    await engine.start('pipeline', { kind: 'x:ticker', payload: null }, { id: 'waiting' });
    await waitUntil(() => waitsForGo(engine, 'waiting'), {
      message: 'the run to wait for its signal',
    });
    await first.dispose();

    const second = await bureauOver('1', false);
    expect(second.bureau.workflows?.list().find((entry) => entry.id === 'pipeline')?.state).toBe(
      'invalid',
    );
    expect(await resumed(second)).toBe(activityAnswer('1', 'hello'));
  });
});
