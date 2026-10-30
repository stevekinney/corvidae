/**
 * COR-1927 — a host that cannot parse a workflow file because it holds a key this host does not
 * know (a file written by a newer Bureau, which is what a rolling deploy shows an older one) must
 * leave that file's shared state alone: its schedule, and the instances in flight on its revisions.
 * Treating the file as "unknown to me" is what makes the next file-format change safe to roll out.
 *
 * Hosts older than this behavior still cancel what they cannot parse; nothing here can change them.
 *
 * The matrix: the file is parseable or carries an unrecognized key, crossed with what the file owns
 * in the shared store (a schedule, an instance in flight, neither). A parseable file behaves as it
 * always did, and so does one that is invalid for any other reason; an unrecognized key never
 * cancels, deletes, or rewrites the file's state, and is reported.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import type { BureauDiagnostic } from './types';
import { startWorkflowBureau } from './testing/workflow-bureau.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';
import { createSqliteStorageFixture } from './test/storage-fixtures';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const HOURLY = { trigger: { kind: 'schedule', spec: '1h' } };
const SCHEDULE_ID = 'bureau-workflow-schedule:digest:1';

/** The ways a file can carry a key this host does not know. */
const UNRECOGNIZED: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['a top-level key', { ...HOURLY, futureOption: { anything: true } }],
  [
    'a key on a step',
    {
      ...HOURLY,
      steps: [{ kind: 'sleep', duration: 1, futureOption: true }],
    },
  ],
  [
    'a key on an agent step’s input',
    {
      ...HOURLY,
      steps: [
        {
          kind: 'activity',
          handler: 'agent',
          input: { agent: 'writer', message: 'Write it', futureOption: true },
        },
      ],
    },
  ],
];

async function schedulesOf(
  bureau: Awaited<ReturnType<typeof startWorkflowBureau>>['bureau'],
): Promise<Array<{ id: string; status: string }>> {
  const page = await bureau.schedules.list();
  return (page?.items ?? []).map((entry) => ({ id: entry.id, status: entry.status }));
}

async function restartable() {
  const root = await mkdtemp(join(tmpdir(), 'bureau-workflow-unrecognized-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'workflows');
  const database = createSqliteStorageFixture({ path: join(root, 'bureau.sqlite') });
  cleanups.push(() => database.dispose());
  const diagnostics: BureauDiagnostic[] = [];
  const overrides = {
    // A getter: each Bureau started with these overrides opens its own handle.
    get storage() {
      return database.open();
    },
    durableOwnership: { ownership: 'none' },
    onDiagnostic: (diagnostic: BureauDiagnostic) => diagnostics.push(diagnostic),
  } as const;
  return { directory, overrides, diagnostics };
}

describe('a file with an unrecognized key and a schedule', () => {
  for (const [label, future] of UNRECOGNIZED) {
    it(`leaves the schedule running when the file gains ${label}, and reports it`, async () => {
      const { directory, overrides, diagnostics } = await restartable();
      const harness = await startWorkflowBureau({ directory, overrides });
      cleanups.push(() => harness.dispose());
      await harness.putWorkflow('digest', HOURLY);
      expect(await schedulesOf(harness.bureau)).toEqual([{ id: SCHEDULE_ID, status: 'active' }]);

      await harness.put('digest.json', workflowFileText('digest', future));
      await harness.bureau.workflows?.refresh();

      expect(harness.bureau.workflows?.list().find((entry) => entry.id === 'digest')).toMatchObject(
        { state: 'invalid' },
      );
      expect(await schedulesOf(harness.bureau)).toEqual([{ id: SCHEDULE_ID, status: 'active' }]);
      expect(diagnostics.map((entry) => entry.message).join('\n')).toContain('"digest"');

      // Once this host can read the file again, it is the schedule it always was, not a new one.
      await harness.putWorkflow('digest', HOURLY);
      expect(await schedulesOf(harness.bureau)).toEqual([{ id: SCHEDULE_ID, status: 'active' }]);
    });
  }

  it('leaves the schedule running across a restart over a file it cannot parse', async () => {
    const { directory, overrides, diagnostics } = await restartable();
    const first = await startWorkflowBureau({ directory, overrides });
    await first.putWorkflow('digest', HOURLY);
    await first.dispose();
    await Bun.write(
      join(directory, 'digest.json'),
      workflowFileText('digest', { ...HOURLY, futureOption: true }),
    );

    const second = await startWorkflowBureau({ directory, overrides });
    cleanups.push(() => second.dispose());
    await second.bureau.workflows?.refresh();

    expect(await schedulesOf(second.bureau)).toEqual([{ id: SCHEDULE_ID, status: 'active' }]);
    expect(diagnostics.map((entry) => entry.message).join('\n')).toContain('"digest"');
  });

  for (const [label, broken] of [
    ['is not JSON', '{'],
    ['has a bad agent', workflowFileText('digest', { ...HOURLY, agent: 7 })],
  ] as const) {
    it(`still cancels the schedule of a file that ${label}`, async () => {
      const harness = await startWorkflowBureau();
      cleanups.push(() => harness.dispose());
      await harness.putWorkflow('digest', HOURLY);
      await harness.put('digest.json', broken);
      await harness.bureau.workflows?.refresh();
      expect(await schedulesOf(harness.bureau)).toEqual([{ id: SCHEDULE_ID, status: 'cancelled' }]);
    });
  }

  it('still updates the schedule of a file it can parse', async () => {
    const harness = await startWorkflowBureau();
    cleanups.push(() => harness.dispose());
    await harness.putWorkflow('digest', HOURLY);
    await harness.putWorkflow('digest', { ...HOURLY, paused: true });
    expect(await schedulesOf(harness.bureau)).toEqual([{ id: SCHEDULE_ID, status: 'paused' }]);
  });
});

describe('a file with an unrecognized key and no schedule', () => {
  it('creates and cancels nothing, and leaves the other workflows’ schedules alone', async () => {
    const { directory, overrides, diagnostics } = await restartable();
    const harness = await startWorkflowBureau({ directory, overrides });
    cleanups.push(() => harness.dispose());
    await harness.putWorkflow('other', HOURLY);
    await harness.put('fresh.json', workflowFileText('fresh', { ...HOURLY, futureOption: true }));
    await harness.bureau.workflows?.refresh();

    expect(await schedulesOf(harness.bureau)).toEqual([
      { id: 'bureau-workflow-schedule:other:1', status: 'active' },
    ]);
    expect(diagnostics.map((entry) => entry.message).join('\n')).toContain('"fresh"');
  });
});

const PARKED = {
  trigger: { kind: 'schedule', spec: '1h' },
  steps: [
    { kind: 'await-signal', signal: 'go' },
    { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'after the wait' } },
  ],
};

describe('an instance in flight on a revision with an unrecognized key', () => {
  it('is left as it is at startup, with the instances of the workflow’s older revisions, and no reason is written', async () => {
    const { directory, overrides, diagnostics } = await restartable();
    const first = await startWorkflowBureau({ directory, overrides });
    await first.putWorkflow('parked', PARKED);
    const engine = first.bureau.durableEngine()!;
    await engine.start('parked', null, { id: 'older-run' });
    const newer = {
      ...PARKED,
      steps: [{ kind: 'await-signal', signal: 'later' }, ...PARKED.steps],
    };
    await first.putWorkflow('parked', newer);
    await engine.start('parked', null, { id: 'newer-run' });
    // The newer revision's stored document carries a key this host does not know, as a record a
    // newer Bureau wrote does, and so does the file.
    let rewritten = 0;
    for (const key of await first.bureau.internals.kv!.list(
      'bureau-workflow-snapshot:v1:parked:',
    )) {
      const stored = JSON.parse((await first.bureau.internals.kv!.get(key)) ?? '{}');
      if (stored.document?.steps?.[0]?.signal === 'later') {
        stored.document.futureOption = true;
        await first.bureau.internals.kv!.set(key, JSON.stringify(stored));
        rewritten += 1;
      }
    }
    expect(rewritten).toBe(1);
    await first.put('parked.json', workflowFileText('parked', { ...newer, futureOption: true }));
    await first.dispose();

    const second = await startWorkflowBureau({ directory, overrides });
    cleanups.push(() => second.dispose());
    const report = await second.bureau.recovery();
    // The engine skips and reports a type it has no trace of; nothing is stranded or cancelled.
    expect(report?.perRunFailures).toEqual([]);
    expect(report?.skippedRuns.map((run) => run.runId).toSorted()).toEqual([
      'newer-run',
      'older-run',
    ]);

    const engineAgain = second.bureau.durableEngine()!;
    for (const runId of ['older-run', 'newer-run']) {
      const state = await engineAgain.get(runId);
      expect(state?.status, runId).not.toBe('cancelled');
      expect(state?.status, runId).not.toBe('failed');
    }
    expect(await second.bureau.internals.kv!.list('bureau-workflow-cancelled-run:v1:')).toEqual([]);
    expect(diagnostics.map((entry) => entry.message).join('\n')).toContain('"parked"');
  });

  it('is still cancelled, with its reason, when its stored revision is unusable for any other reason', async () => {
    const { directory, overrides } = await restartable();
    const first = await startWorkflowBureau({ directory, overrides });
    await first.putWorkflow('parked', PARKED);
    await first.bureau.durableEngine()!.start('parked', null, { id: 'parked-run' });
    await first.putWorkflow('parked', { ...PARKED, steps: [{ kind: 'sleep', duration: 1 }] });
    for (const key of await first.bureau.internals.kv!.list(
      'bureau-workflow-snapshot:v1:parked:',
    )) {
      const stored = JSON.parse((await first.bureau.internals.kv!.get(key)) ?? '{}');
      if (stored.document?.steps?.[0]?.kind === 'await-signal') {
        await first.bureau.internals.kv!.set(key, '{"schemaVersion":1}');
      }
    }
    await first.dispose();

    const second = await startWorkflowBureau({ directory, overrides });
    cleanups.push(() => second.dispose());
    const run = await second.bureau.workflows?.getRun('parked-run');
    expect(run?.status).toBe('cancelled');
    expect(run?.error).toContain('cannot be used');
  });
});
