/**
 * COR-1874 — which revision a contributed trigger's `fire` judges its payload against and starts,
 * whenever it lands. A fire takes one snapshot of the revision the engine has applied, judges the
 * payload with that revision's `inputSchema`, and starts that same revision. It never waits for a
 * change to the files that is queued or in progress, so it can never wait on an apply that is itself
 * waiting for the trigger to stop.
 *
 * Outcome matrix (the trigger kind's stop waits for its fires in flight, as `Bun.serve`'s
 * `server.stop()` waits for its requests):
 *
 * | fire timing                              | validated against | started | completes or refused            | hangs | red on bb6899e |
 * | ---------------------------------------- | ----------------- | ------- | ------------------------------- | ----- | -------------- |
 * | no apply pending                         | R1                | R1      | completes; R2's payload refused | never | no             |
 * | apply queued that changes this workflow  | R1                | R1      | completes; R2's payload refused | never | yes            |
 * | apply queued that stops this trigger     | R1                | R1      | fire, apply and stop complete   | never | yes (hung)     |
 * | trigger still starting, its file changes | R1                | R1      | completes; R2's payload refused | never | yes            |
 * | close in progress                        | R1                | R1      | fire and close complete         | never | no             |
 * | the apply failed                         | none              | nothing | refused with WorkflowApplyError | never | no             |
 *
 * R1 is the revision the engine has applied when the fire lands, R2 the one the queued change
 * registers (in the first row, a schema it would not accept). The last two rows need the engine
 * itself (a gated `engine.start`, a failing `pauseSchedule` or `registerSource`), so they are in
 * `workflow-runtime.test.ts`: "a contributed trigger that fires while the Bureau closes" and "a
 * contributed trigger that fires while an earlier change has not reached the engine".
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';

import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';
import {
  activityAnswer,
  contributionCatalog,
  createTickerController,
  type TickerController,
} from './testing/workflow-contributions.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';
import { WorkflowInputInvalidError } from './workflow-schema';

const harnesses: WorkflowBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
});

async function start(ticker: TickerController): Promise<WorkflowBureauHarness> {
  const harness = await startWorkflowBureau({
    overrides: {
      contributionCatalog: contributionCatalog({ activityVersion: '1', ticker }),
      onDiagnostic: () => undefined,
    },
  });
  harnesses.push(harness);
  return harness;
}

/** R1's schema: an issue key. */
const issueSchema = {
  type: 'object',
  required: ['issue'],
  properties: { issue: { type: 'string' } },
};

/** R2's schema: a ticket number. A payload one accepts, the other refuses. */
const ticketSchema = {
  type: 'object',
  required: ['ticket'],
  properties: { ticket: { type: 'number' } },
};

const ticking = (overrides: Record<string, unknown> = {}) =>
  workflowFileText('pipeline', {
    trigger: { kind: 'x:ticker', channel: 'alerts' },
    steps: [{ kind: 'activity', handler: 'x:y', input: 'hello' }],
    inputSchema: issueSchema,
    ...overrides,
  });

/** The version of the pipeline's file the catalog holds now, without a rescan. */
function catalogVersion(harness: WorkflowBureauHarness): string | undefined {
  return harness.bureau.workflows?.list().find((entry) => entry.id === 'pipeline')?.version;
}

async function runsOf(harness: WorkflowBureauHarness) {
  const page = await harness.bureau.workflows?.listRuns({
    workflow: 'pipeline',
    limit: 10,
    offset: 0,
  });
  return page?.runs ?? [];
}

/** Every run of the pipeline once each has completed. */
async function completedRuns(harness: WorkflowBureauHarness, count: number) {
  await waitUntil(
    async () => {
      const runs = await runsOf(harness);
      return runs.length === count && runs.every((run) => run.status === 'completed');
    },
    { message: `${count} pipeline run(s) to complete` },
  );
  return runsOf(harness);
}

/**
 * Hold an apply open: another file's trigger whose `start` does not resolve until the returned
 * function is called. A change to the files after this queues behind it.
 */
async function holdAnApply(harness: WorkflowBureauHarness, ticker: TickerController) {
  const release = ticker.hold('blocked');
  await harness.put(
    'other.json',
    workflowFileText('other', {
      trigger: { kind: 'x:ticker', channel: 'blocked' },
      steps: [{ kind: 'activity', handler: 'x:y', input: 'other' }],
    }),
  );
  const applying = harness.bureau.workflows?.refresh();
  await waitUntil(() => ticker.hasStarted('blocked'), { message: 'the held trigger to start' });
  return { release, applying };
}

/**
 * Change the pipeline's file and wait until the catalog holds it, while its apply is queued. The
 * refresh that applies it is returned unawaited.
 */
async function changeWhileQueued(
  harness: WorkflowBureauHarness,
  text: string,
  predicate: () => boolean,
) {
  await harness.put('pipeline.json', text);
  const queued = harness.bureau.workflows?.refresh();
  await waitUntil(predicate, { message: 'the catalog to hold the changed file' });
  // Wrapped: an async function that returned the refresh itself would wait for it.
  return { queued };
}

describe('a contributed trigger that fires', () => {
  it('with no apply pending, judges the payload by the applied revision and starts it', async () => {
    const ticker = createTickerController();
    const harness = await start(ticker);
    await harness.put('pipeline.json', ticking());
    await harness.bureau.workflows?.refresh();
    const applied = catalogVersion(harness);

    expect(await rejectionOf(ticker.fire({ ticket: 1 }))).toBeInstanceOf(WorkflowInputInvalidError);
    await ticker.fire({ issue: 'COR-1' });

    const runs = await completedRuns(harness, 1);
    expect(runs.map((run) => run.workflowVersion)).toEqual([applied!]);
  });

  it('while an apply that changes its inputSchema is queued, judges by and starts the applied revision', async () => {
    const ticker = createTickerController();
    const harness = await start(ticker);
    await harness.put('pipeline.json', ticking());
    await harness.bureau.workflows?.refresh();
    const r1 = catalogVersion(harness);
    const trigger = ticker.contexts[0]!;

    const held = await holdAnApply(harness, ticker);
    const { queued } = await changeWhileQueued(
      harness,
      ticking({ inputSchema: ticketSchema }),
      () => catalogVersion(harness) !== r1,
    );
    const r2 = catalogVersion(harness);

    // Both land before the queued apply registers R2: R1's schema judges both.
    const accepted = trigger.fire({ issue: 'COR-2' });
    const refused = trigger.fire({ ticket: 2 });
    held.release();
    const [acceptedOutcome, refusedOutcome] = await Promise.allSettled([accepted, refused]);
    await held.applying;
    await queued;

    expect(acceptedOutcome.status).toBe('fulfilled');
    expect(refusedOutcome.status === 'rejected' ? refusedOutcome.reason : undefined).toBeInstanceOf(
      WorkflowInputInvalidError,
    );
    const runs = await completedRuns(harness, 1);
    expect(runs.map((run) => run.workflowVersion)).toEqual([r1!]);
    expect(r2).not.toBe(r1);

    // Once the apply has landed, R2 judges and runs.
    await ticker.contexts[0]!.fire({ ticket: 3 });
    const after = await completedRuns(harness, 2);
    expect(after.map((run) => run.workflowVersion).toSorted()).toEqual([r1!, r2!].toSorted());
  });

  it('while an apply that stops the trigger is queued, completes, and so do the apply and the stop', async () => {
    const ticker = createTickerController();
    const harness = await start(ticker);
    await harness.put('pipeline.json', ticking());
    await harness.bureau.workflows?.refresh();
    const r1 = catalogVersion(harness);
    const trigger = ticker.contexts[0]!;

    const held = await holdAnApply(harness, ticker);
    const { queued } = await changeWhileQueued(
      harness,
      ticking({ paused: true }),
      () =>
        harness.bureau.workflows?.list().find((entry) => entry.id === 'pipeline')?.paused === true,
    );

    // The queued apply stops this trigger, and the trigger's stop waits for this fire. A fire that
    // waited for that apply would wait for itself.
    const fired = trigger.fire({ issue: 'COR-4' });
    held.release();
    await fired;
    await held.applying;
    await queued;

    expect(ticker.stopped).toBe(1);
    expect(trigger.signal.aborted).toBe(true);
    const runs = await completedRuns(harness, 1);
    expect(runs.map((run) => run.workflowVersion)).toEqual([r1!]);
  });

  it('while it is still starting and its file changes, judges by and starts the revision that started it', async () => {
    const ticker = createTickerController();
    const harness = await start(ticker);
    const release = ticker.hold('alerts');
    await harness.put('pipeline.json', ticking());
    const applying = harness.bureau.workflows?.refresh();
    await waitUntil(() => ticker.hasStarted('alerts'), {
      message: 'the trigger to begin starting',
    });
    const r1 = catalogVersion(harness);
    const starting = ticker.contexts[0]!;

    let queued: Promise<void> | undefined;
    // Released however the assertions go, so a failure reports itself instead of holding the
    // apply open until the Bureau's disposal times out.
    try {
      ({ queued } = await changeWhileQueued(
        harness,
        ticking({ inputSchema: ticketSchema }),
        () => catalogVersion(harness) !== r1,
      ));

      // The apply that registered R1 is still starting this trigger; R2 is only in the catalog.
      expect(await rejectionOf(starting.fire({ ticket: 5 }))).toBeInstanceOf(
        WorkflowInputInvalidError,
      );
      await starting.fire({ issue: 'COR-5' });
    } finally {
      release();
    }
    await applying;
    await queued;

    const runs = await completedRuns(harness, 1);
    expect(runs.map((run) => run.workflowVersion)).toEqual([r1!]);
    const detail = await harness.bureau.workflows?.getRun(runs[0]!.id);
    expect(detail?.trigger).toEqual({ kind: 'x:ticker', payload: { issue: 'COR-5' } });
    expect(detail?.result).toBe(activityAnswer('1', 'hello'));
  });
});
