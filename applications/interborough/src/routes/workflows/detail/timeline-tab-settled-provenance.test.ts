/**
 * Worker provenance for an activity that has settled (COR-281): the run page offers it from the
 * activity's row, not only from the in-flight completion drawer. The row carries the ledger task
 * identity Weft recorded on the timeline entry (`taskOperationId`); the page reads that record and
 * never rebuilds the id from the step.
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
import { openStepNumber } from './steps/open-step.test-support.ts';
import TimelineTabHarness from './timeline-tab.test-harness.svelte';
import { WorkflowLiveObservations } from './timeline/workflow-live-observations.svelte.ts';

const WORKFLOW_ID = 'wf-settled';

function workflow(): WorkflowState {
  return {
    id: WORKFLOW_ID,
    type: 'order-processing',
    status: 'completed',
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
    taskOperationId: 'task-chargeCard',
    ...overrides,
  };
}

const IDENTITY = {
  workerId: 'worker-a',
  manifestDigest: 'sha256:manifest',
  sdkVersion: '1.0.0',
  runtimeName: 'bun',
  runtimeVersion: '1.3.0',
  deploymentName: 'payments',
  buildId: 'build-1',
  artifactDigest: 'sha256:artifact-1',
  workflowType: 'order-processing',
  workflowRevision: 'rev-7',
  activityName: 'chargeCard',
  activityContractHash: 'sha256:contract-1',
  protocolVersion: 1,
} as const;

class InertFleet {
  caughtUp = false;
  subscribe(): () => void {
    return () => {};
  }
}

function render_(
  entries: WorkflowTimelineEntry[],
  readTask?: (input: { operationId: string }) => Promise<unknown>,
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
          'weft.workflows.activities.pending.list': async () => ({ items: [] }),
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

describe('TimelineTab — worker provenance for a settled activity', () => {
  test('opens the task history of the record the entry names', async () => {
    const reads: string[] = [];
    const view = render_([entry({})], async ({ operationId }) => {
      reads.push(operationId);
      return {
        ...taskLedgerDetailFixture(),
        operationId,
        attempt: 2,
        attempts: [
          {
            attempt: 1,
            attemptTokenDigest: 'sha256:token-1',
            claimedAt: 1_700_000_000_000,
            disposition: 'requeued',
            dispositionAt: 1_700_000_010_000,
            executionIdentity: IDENTITY,
          },
          {
            attempt: 2,
            attemptTokenDigest: 'sha256:token-2',
            claimedAt: 1_700_000_020_000,
            disposition: 'leased',
            dispositionAt: 1_700_000_020_000,
            executionIdentity: { ...IDENTITY, buildId: 'build-2' },
          },
        ],
      };
    });

    await waitFor(() => expect(view.getByText('chargeCard')).not.toBeNull());
    expect(reads).toEqual([]);
    await openStepNumber(view.container, 3);
    await fireEvent.click(
      await view.findByRole('button', { name: 'Worker provenance for chargeCard' }),
    );

    expect(await view.findByText('Crossed build')).not.toBeNull();
    expect(reads).toEqual(['task-chargeCard']);
    expect(view.getByText('Open the full task ledger')).not.toBeNull();
  });

  test('each of two activities reads its own record, whatever the steps are', async () => {
    const reads: string[] = [];
    const view = render_(
      [
        entry({ step: 1, operationLabel: 'first', taskOperationId: 'task-for-first' }),
        entry({ step: 2, operationLabel: 'second', taskOperationId: 'task-for-second' }),
      ],
      async ({ operationId }) => {
        reads.push(operationId);
        return { ...taskLedgerDetailFixture(), operationId, attempts: [] };
      },
    );
    await waitFor(() => expect(view.getByText('second')).not.toBeNull());
    await openStepNumber(view.container, 2);
    await fireEvent.click(
      await view.findByRole('button', { name: 'Worker provenance for second' }),
    );
    await waitFor(() => expect(reads).toEqual(['task-for-second']));
    await openStepNumber(view.container, 1);
    await fireEvent.click(await view.findByRole('button', { name: 'Worker provenance for first' }));
    await waitFor(() => expect(reads).toEqual(['task-for-second', 'task-for-first']));
  });

  test('says no worker task is recorded when the ledger has no such record', async () => {
    const view = render_([entry({})], async () => {
      throw new HttpClientError(404, 'no such task');
    });
    await waitFor(() => expect(view.getByText('chargeCard')).not.toBeNull());
    await openStepNumber(view.container, 3);
    await fireEvent.click(
      await view.findByRole('button', { name: 'Worker provenance for chargeCard' }),
    );
    expect(await view.findByText('No worker task recorded')).not.toBeNull();
    // A record can also have been reaped after the retention window, so the copy claims no more.
    expect(view.queryByText(/no worker has run it/)?.textContent ?? null).toBeNull();
  });

  test('offers it only for a settled activity that names a ledger record', async () => {
    const view = render_(
      [
        entry({ step: 1, operationLabel: 'failedCharge', status: 'failed' }),
        entry({ step: 2, operationLabel: 'runningCharge', status: 'running' }),
        entry({ step: 3, operationType: 'sleep', operationLabel: 'sleepFor' }),
      ],
      async () => {
        throw new HttpClientError(404, 'no such task');
      },
    );
    await waitFor(() => expect(view.getByText('failedCharge')).not.toBeNull());
    await openStepNumber(view.container, 1);
    expect(await view.findAllByRole('button', { name: /^Worker provenance for / })).toHaveLength(1);
    expect(view.getByRole('button', { name: 'Worker provenance for failedCharge' })).not.toBeNull();
    for (const step of [2, 3]) {
      await openStepNumber(view.container, step);
      expect(view.queryAllByRole('button', { name: /^Worker provenance for / })).toHaveLength(0);
    }
  });

  test('omits it for an in-process activity, whose entry names no record', async () => {
    const { taskOperationId: _omitted, ...inProcess } = entry({});
    const view = render_([inProcess], async () => {
      throw new HttpClientError(404, 'no such task');
    });
    await waitFor(() => expect(view.getByText('chargeCard')).not.toBeNull());
    await openStepNumber(view.container, 3);
    expect(view.queryAllByRole('button', { name: /^Worker provenance for / })).toHaveLength(0);
  });

  test('omits the action when the client cannot read tasks', async () => {
    const view = render_([entry({})]);
    await waitFor(() => expect(view.getByText('chargeCard')).not.toBeNull());
    await openStepNumber(view.container, 3);
    expect(view.queryAllByRole('button', { name: /^Worker provenance for / })).toHaveLength(0);
  });

  test('names a denied read', async () => {
    const view = render_([entry({})], async () => {
      throw new HttpClientError(403, 'forbidden');
    });
    await waitFor(() => expect(view.getByText('chargeCard')).not.toBeNull());
    await openStepNumber(view.container, 3);
    await fireEvent.click(
      await view.findByRole('button', { name: 'Worker provenance for chargeCard' }),
    );
    expect(await view.findByText('Worker provenance is locked')).not.toBeNull();
  });
});
