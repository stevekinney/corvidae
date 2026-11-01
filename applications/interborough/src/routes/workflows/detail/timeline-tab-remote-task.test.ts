/**
 * The remote task behind a timeline step (COR-274): a step whose entry names a ledger record
 * (`taskOperationId`) offers that record's queue, attempt, retry policy, timeouts, header keys,
 * and execution token, read with `weft.tasks.get`; a step that is not remote offers nothing; a
 * running step with no record yet says so explicitly.
 */
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import {
  HttpClientError,
  type WorkflowState,
  type WorkflowTimelineEntry,
} from '@lostgradient/weft';
import { QueryClient } from '@tanstack/svelte-query';

import { taskLedgerDetailFixture } from '../../workers/workers-route-test-support.test-support.ts';
import { REMOTE_TASK_STATE_LABELS } from './remote-task-view.ts';
import { openStepNumber } from './steps/open-step.test-support.ts';
import TimelineTabHarness from './timeline-tab.test-harness.svelte';
import { WorkflowLiveObservations } from './timeline/workflow-live-observations.svelte.ts';

const WORKFLOW_ID = 'wf-remote';

function workflow(): WorkflowState {
  return {
    id: WORKFLOW_ID,
    type: 'order-processing',
    status: 'running',
    input: {},
    versionTuple: { workflowVersion: '1' },
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

function entry(overrides: Partial<WorkflowTimelineEntry>): WorkflowTimelineEntry {
  return {
    step: 3,
    operationType: 'activity',
    operationLabel: 'chargeCard',
    inputSummary: '{}',
    timestamp: 1_000,
    status: 'completed',
    taskOperationId: 'as:wf-remote:2:1',
    ...overrides,
  };
}

/** An entry that names no ledger record, as an in-process or coordinator entry does. */
function withoutTask(overrides: Partial<WorkflowTimelineEntry>): WorkflowTimelineEntry {
  const { taskOperationId: _omitted, ...rest } = entry(overrides);
  return rest;
}

class InertFleet {
  caughtUp = false;
  subscribe(): () => void {
    return () => {};
  }
}

interface PendingItem {
  token: string;
  operationId: string;
  activityName: string;
  step: number;
  attempt: number;
  createdAt: number;
}

function renderTab(
  entries: WorkflowTimelineEntry[],
  readTask?: (input: { operationId: string }) => Promise<unknown>,
  pending: PendingItem[] = [],
) {
  const liveObservations = new WorkflowLiveObservations(
    new InertFleet(),
    new QueryClient(),
    WORKFLOW_ID,
  );
  return render(TimelineTabHarness, {
    props: {
      client: {
        getTimeline: async () => entries,
        operations: {
          'weft.workflows.activities.pending.list': async () => ({ items: pending }),
          ...(readTask === undefined ? {} : { 'weft.tasks.get': readTask }),
        },
        activity: { complete: async () => {}, completeExceptionally: async () => {} },
        // A scripted fake: `weft.tasks.get` answers with a hand-built record, typed `unknown` here.
      } as never,
      workflow: workflow(),
      liveObservations,
      finalizerStatus: null,
    },
  });
}

/** Opens a step's detail, where the step's own affordances are. */
async function openStep(view: ReturnType<typeof renderTab>, name: RegExp): Promise<void> {
  await fireEvent.click(await view.findByRole('button', { name }));
}

function definitionFor(term: HTMLElement): string {
  return (term.nextElementSibling?.textContent ?? '').trim();
}

describe('TimelineTab remote task', () => {
  test('a remote step shows its ledger facts, read by the id its entry names', async () => {
    const reads: string[] = [];
    const view = renderTab([entry({})], async ({ operationId }) => {
      reads.push(operationId);
      return { ...taskLedgerDetailFixture(), operationId };
    });

    await waitFor(() => expect(view.getByText('chargeCard')).not.toBeNull());
    expect(reads).toEqual([]);
    await openStep(view, /Charge card/);
    await fireEvent.click(view.getByRole('button', { name: 'Remote task for chargeCard' }));

    expect(await view.findByText(REMOTE_TASK_STATE_LABELS.queued)).not.toBeNull();
    expect(reads).toEqual(['as:wf-remote:2:1']);
    expect(definitionFor(view.getByText('Queue'))).toBe('payments');
    expect(definitionFor(view.getByText('Retry policy'))).toContain('Up to 3 attempts');
    expect(definitionFor(view.getByText('Execution token'))).toBe('token_route');
  });

  test('a running remote step that already names its record offers it too', async () => {
    const view = renderTab([entry({ status: 'running' })], async ({ operationId }) => ({
      ...taskLedgerDetailFixture(),
      operationId,
    }));

    await waitFor(() => expect(view.getByText('chargeCard')).not.toBeNull());
    await openStep(view, /Charge card/);

    expect(await view.findByRole('button', { name: 'Remote task for chargeCard' })).not.toBeNull();
  });

  test('each remote step reads its own record, whatever the steps are', async () => {
    const reads: string[] = [];
    const view = renderTab(
      [
        entry({ step: 1, operationLabel: 'first', taskOperationId: 'task-for-first' }),
        entry({ step: 2, operationLabel: 'second', taskOperationId: 'task-for-second' }),
      ],
      async ({ operationId }) => {
        reads.push(operationId);
        return { ...taskLedgerDetailFixture(), operationId };
      },
    );
    await waitFor(() => expect(view.getByText('second')).not.toBeNull());
    await openStep(view, /Second/);

    await fireEvent.click(await view.findByRole('button', { name: 'Remote task for second' }));

    await waitFor(() => expect(reads).toEqual(['task-for-second']));
  });

  test('a step that is not remote shows none of it', async () => {
    const { taskOperationId: _omitted, ...inProcess } = entry({});
    const view = renderTab(
      [
        inProcess,
        entry({ step: 4, operationType: 'sleep', operationLabel: 'sleepFor' }),
        withoutTask({ step: 5, operationType: 'all', operationLabel: 'fanOut' }),
      ],
      async () => {
        throw new HttpClientError(404, 'no such task');
      },
    );
    await waitFor(() => expect(view.getByText('chargeCard')).not.toBeNull());

    for (const step of [3, 4, 5]) {
      await openStepNumber(view.container, step);
      expect(view.queryAllByRole('button', { name: /^Remote task for / })).toHaveLength(0);
    }
    expect(view.queryByText(/Dispatch record not yet available/)).toBeNull();
  });

  test('omits the action when the client cannot read tasks', async () => {
    const view = renderTab([entry({})]);
    await waitFor(() => expect(view.getByText('chargeCard')).not.toBeNull());
    await openStep(view, /Charge card/);

    expect(view.queryAllByRole('button', { name: /^Remote task for / })).toHaveLength(0);
  });

  test('says no task record exists when the ledger has none', async () => {
    const view = renderTab([entry({})], async () => {
      throw new HttpClientError(404, 'no such task');
    });
    await waitFor(() => expect(view.getByText('chargeCard')).not.toBeNull());
    await openStep(view, /Charge card/);

    await fireEvent.click(await view.findByRole('button', { name: 'Remote task for chargeCard' }));

    expect(await view.findByText('No task record')).not.toBeNull();
  });

  describe('a running step, whose entry names no record', () => {
    // The ledger key of a remote activity is the pending record's `token`. Its `operationId` is the
    // workflow operation's own id, which names no ledger record, so the two differ here.
    const TOKEN = 'async-act:v1:wf-remote:0:1';
    const PENDING: PendingItem = {
      token: TOKEN,
      operationId: 'workflow-operation-id',
      activityName: 'chargeCard',
      step: 3,
      attempt: 1,
      createdAt: 1_000,
    };

    function ledgerKnowing(token: string, reads: string[]) {
      return async ({ operationId }: { operationId: string }) => {
        reads.push(operationId);
        if (operationId !== token) throw new HttpClientError(404, 'no such task');
        return { ...taskLedgerDetailFixture(), operationId };
      };
    }

    test('a running remote step offers its queued record, read by the pending token', async () => {
      const reads: string[] = [];
      const view = renderTab([withoutTask({ status: 'running' })], ledgerKnowing(TOKEN, reads), [
        PENDING,
      ]);

      await openStep(view, /Charge card/);
      await fireEvent.click(
        await view.findByRole('button', { name: 'Remote task for chargeCard' }),
      );

      expect(await view.findByText(REMOTE_TASK_STATE_LABELS.queued)).not.toBeNull();
      expect(reads).toContain(TOKEN);
      expect(reads).not.toContain('workflow-operation-id');
    });

    test('a running step whose pending activity the ledger does not know offers nothing', async () => {
      // A local `completeAsync()` deferral, or any pending activity that is not remote.
      const reads: string[] = [];
      const view = renderTab(
        [withoutTask({ status: 'running' })],
        ledgerKnowing('some-other-token', reads),
        [PENDING],
      );

      // The ledger is asked when the step is opened, since its record is part of the step's detail.
      await waitFor(() => expect(view.getByText('chargeCard')).not.toBeNull());
      await openStep(view, /Charge card/);
      await waitFor(() => expect(reads).toEqual([TOKEN]));

      expect(view.queryAllByRole('button', { name: /^Remote task for / })).toHaveLength(0);
      expect(view.queryByText(/Dispatch record not yet available/)).toBeNull();
      expect(view.queryByText('No task record')).toBeNull();
    });

    test('a running step offers nothing when the ledger read is refused', async () => {
      const view = renderTab(
        [withoutTask({ status: 'running' })],
        async () => {
          throw new HttpClientError(403, 'forbidden');
        },
        [PENDING],
      );

      await waitFor(() => expect(view.getByText('chargeCard')).not.toBeNull());
      await openStep(view, /Charge card/);

      expect(view.queryAllByRole('button', { name: /^Remote task for / })).toHaveLength(0);
    });

    test('a running step with no pending activity is not asked about at all', async () => {
      const reads: string[] = [];
      const view = renderTab([withoutTask({ status: 'running' })], ledgerKnowing(TOKEN, reads), []);

      await waitFor(() => expect(view.getByText('chargeCard')).not.toBeNull());
      await openStep(view, /Charge card/);

      expect(reads).toEqual([]);
      expect(view.queryAllByRole('button', { name: /^Remote task for / })).toHaveLength(0);
    });
  });
});
