/**
 * Worker provenance in the async-activity drawer (COR-281): the run page shows
 * the task ledger's per-attempt history for the activity's operation id.
 */
import { render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { HttpClientError } from '@lostgradient/weft';

import { taskLedgerDetailFixture } from '../../../workers/workers-route-test-support.test-support.ts';
import AsyncActivityDrawerHarness from './async-activity-drawer.test-harness.svelte';
import type { AttachedPendingActivity } from './async-activity-matching.ts';

const IDENTITY = {
  workerId: 'worker-a',
  manifestDigest: 'sha256:manifest',
  sdkVersion: '1.0.0',
  runtimeName: 'bun',
  runtimeVersion: '1.3.0',
  deploymentName: 'payments',
  buildId: 'build-1',
  artifactDigest: 'sha256:artifact-1',
  workflowType: 'orders',
  workflowRevision: 'rev-7',
  activityName: 'charge',
  activityContractHash: 'sha256:contract-1',
  protocolVersion: 1,
} as const;

const activity: AttachedPendingActivity = {
  token: 'async-act:v1:wf-1:0:1',
  operationId: 'op-remote-1',
  activityName: 'charge',
  attempt: 2,
  observedAt: 1_000,
  stepId: 'step-1',
};

function drawerClient(readTask: (input: { operationId: string }) => Promise<unknown>) {
  return {
    activity: { complete: async () => {}, completeExceptionally: async () => {} },
    operations: { 'weft.tasks.get': readTask },
  };
}

function renderDrawer(client: ReturnType<typeof drawerClient>) {
  return render(AsyncActivityDrawerHarness, {
    props: {
      client: client as never,
      open: true,
      activity,
      onClose: () => {},
      onResolved: () => {},
    },
  });
}

describe('activity worker provenance', () => {
  test('reads the ledger by the activity token, which is the task’s operation id, and shows a cross-build retry', async () => {
    const reads: string[] = [];
    const { findByText, getByText } = renderDrawer(
      drawerClient(async ({ operationId }) => {
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
      }),
    );

    expect(await findByText('Crossed build')).not.toBeNull();
    // A remote `ctx.run()` enqueues its task under the pending token; the pending record's own
    // `operationId` is the workflow operation's, which names no ledger record.
    expect(reads).toEqual([activity.token]);
    expect(getByText('Worker provenance')).not.toBeNull();
    const link = getByText('Open the full task ledger');
    expect(link.getAttribute('href')).toBe(
      `/workers?tab=diagnostics&task=${encodeURIComponent(activity.token)}`,
    );
  });

  test('says no worker task is recorded when the ledger has no such operation', async () => {
    const { findByText } = renderDrawer(
      drawerClient(async () => {
        throw new HttpClientError(404, 'no such task');
      }),
    );
    expect(await findByText('No worker task recorded')).not.toBeNull();
  });

  test('names a denied read and a malformed response distinctly', async () => {
    const denied = renderDrawer(
      drawerClient(async () => {
        throw new HttpClientError(403, 'forbidden');
      }),
    );
    expect(await denied.findByText('Worker provenance is locked')).not.toBeNull();
    denied.unmount();

    const malformed = renderDrawer(drawerClient(async () => ({ state: 'queued' })));
    expect(await malformed.findByText('Malformed server response')).not.toBeNull();
  });

  test('shows a loading status, then a server fault', async () => {
    const { findByRole, findByText } = renderDrawer(
      drawerClient(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new HttpClientError(500, 'ledger offline');
      }),
    );
    expect(await findByRole('status', { name: 'Loading worker provenance' })).not.toBeNull();
    await waitFor(async () => expect(await findByText('Something went wrong')).not.toBeNull());
  });

  test('omits the panel when the client cannot read tasks', () => {
    const { queryByText } = render(AsyncActivityDrawerHarness, {
      props: {
        client: {
          activity: { complete: async () => {}, completeExceptionally: async () => {} },
        },
        open: true,
        activity,
        onClose: () => {},
        onResolved: () => {},
      },
    });
    expect(queryByText('Worker provenance')).toBeNull();
  });
});
