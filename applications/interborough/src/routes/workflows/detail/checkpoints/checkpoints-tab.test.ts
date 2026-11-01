import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { CheckpointSummary, WorkflowReplay } from '@lostgradient/weft';
import { HttpClientError } from '@lostgradient/weft';
import { QueryClient } from '@tanstack/svelte-query';

import { AUTHORIZATION_SCOPES, type Principal } from '../../../../lib/scopes.svelte.ts';
import CheckpointsTabHarness from './checkpoints-tab.test-harness.svelte';

function allScopesPrincipal(): Principal {
  return { scopes: AUTHORIZATION_SCOPES, unauthenticatedAccess: null };
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function baseClient(
  checkpoints: CheckpointSummary[] = [
    { step: 3, timestamp: 3_000, sizeBytes: 512 },
    { step: 2, timestamp: 2_000, sizeBytes: 256 },
  ],
) {
  return {
    operations: {
      'weft.workflows.checkpoints.list': async (): Promise<CheckpointSummary[]> => checkpoints,
      'weft.workflows.checkpoints.get': async () => ({
        step: 0,
        locals: {},
        searchAttributes: {},
        version: '1',
        createdAt: 0,
      }),
      'weft.workflows.revisions.list': async () => [],
    },
    replayTo: async (): Promise<WorkflowReplay | null> => null,
    fork: async () => ({ id: 'wf-forked-1' }),
    getTimeline: async () => [],
  };
}

describe('CheckpointsTab', () => {
  test('renders the checkpoint list', async () => {
    const { getByText } = render(CheckpointsTabHarness, {
      props: {
        client: baseClient(),
        workflowId: 'wf-1',
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    await waitFor(() => {
      expect(getByText('step 3')).not.toBeNull();
      expect(getByText('step 2')).not.toBeNull();
    });
  });

  test('shows an empty state when no checkpoints are retained', async () => {
    const { getByText } = render(CheckpointsTabHarness, {
      props: {
        client: baseClient([]),
        workflowId: 'wf-1',
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    await waitFor(() => {
      expect(getByText('No checkpoint history retained')).not.toBeNull();
    });
  });

  test('selecting a checkpoint shows the Replay panel by default, and Fork after clicking the Fork tab', async () => {
    const { getByText, getByRole } = render(CheckpointsTabHarness, {
      props: {
        client: baseClient(),
        workflowId: 'wf-1',
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    await waitFor(() => expect(getByText('step 3')).not.toBeNull());
    await fireEvent.click(getByText('step 3'));

    await waitFor(() => {
      expect(
        getByText('This is a replay of step 3. It is read-only and does not change the live run.'),
      ).not.toBeNull();
    });

    await fireEvent.click(getByRole('radio', { name: 'Fork' }));

    await waitFor(() => {
      expect(getByText('Target step')).not.toBeNull();
    });
  });

  test('Replay and Fork are one segmented control, and the replay notice is an Alert inside the frame', async () => {
    const { getByText, getByRole, getAllByRole, container } = render(CheckpointsTabHarness, {
      props: {
        client: baseClient(),
        workflowId: 'wf-1',
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    await waitFor(() => expect(getByText('step 3')).not.toBeNull());
    await fireEvent.click(getByText('step 3'));

    await waitFor(() => expect(getByRole('radio', { name: 'Replay' })).not.toBeNull());
    expect(getByRole('radio', { name: 'Replay' }).getAttribute('aria-checked')).toBe('true');
    expect(getAllByRole('radio').map((radio) => radio.textContent?.trim())).toEqual([
      'Replay',
      'Fork',
    ]);
    const frame = container.querySelector('.weft-replay-view');
    const notice = frame?.querySelector('[role="alert"]');
    expect(notice?.textContent).toContain('This is a replay of step 3');
  });

  test('forking a checkpoint shows the success link and reveals the divergence view', async () => {
    const { getByText, getByRole } = render(CheckpointsTabHarness, {
      props: {
        client: baseClient(),
        workflowId: 'wf-1',
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    await waitFor(() => expect(getByText('step 3')).not.toBeNull());
    await fireEvent.click(getByText('step 3'));
    await fireEvent.click(getByRole('radio', { name: 'Fork' }));
    await waitFor(() => expect(getByText('Target step')).not.toBeNull());
    await fireEvent.click(getByRole('button', { name: 'Create fork' }));

    await waitFor(() => {
      expect(getByText('wf-forked-1')).not.toBeNull();
    });
    await waitFor(() => {
      expect(getByText('Divergence from the forked run')).not.toBeNull();
    });
  });

  test('the default fork path sends only {fromStep} — no revision — to client.fork (WFT-117)', async () => {
    const forkCalls: unknown[] = [];
    const client = {
      ...baseClient(),
      fork: async (_id: string, options?: unknown) => {
        forkCalls.push(options);
        return { id: 'wf-forked-1' };
      },
    };

    const { getByText, getByRole } = render(CheckpointsTabHarness, {
      props: {
        client,
        workflowId: 'wf-1',
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
        workflowType: 'order-processing',
        sourceRevision: 'order-processing-rev-a',
      },
    });

    await waitFor(() => expect(getByText('step 3')).not.toBeNull());
    await fireEvent.click(getByText('step 3'));
    await fireEvent.click(getByRole('radio', { name: 'Fork' }));
    await waitFor(() => expect(getByText('Target step')).not.toBeNull());
    await fireEvent.click(getByRole('button', { name: 'Create fork' }));

    await waitFor(() => {
      expect(forkCalls).toEqual([{ fromStep: 3 }]);
    });
  });

  test("the Fork panel threads workflowType/sourceRevision into ForkDialog's retention line", async () => {
    const { getByText, getByRole } = render(CheckpointsTabHarness, {
      props: {
        client: baseClient(),
        workflowId: 'wf-1',
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
        workflowType: 'order-processing',
        sourceRevision: 'order-processing-rev-a',
      },
    });

    await waitFor(() => expect(getByText('step 3')).not.toBeNull());
    await fireEvent.click(getByText('step 3'));
    await fireEvent.click(getByRole('radio', { name: 'Fork' }));

    await waitFor(() => {
      expect(getByText(/^Retains/)).not.toBeNull();
    });
  });

  test('ReplayView renders replay.revision when present', async () => {
    const client = {
      ...baseClient(),
      replayTo: async () => ({
        checkpoint: { step: 3, locals: {}, searchAttributes: {}, version: '1', createdAt: 0 },
        accumulatedResults: [],
        events: [],
        revision: 'order-processing-rev-a',
      }),
    };

    const { getByText } = render(CheckpointsTabHarness, {
      props: {
        client,
        workflowId: 'wf-1',
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    await waitFor(() => expect(getByText('step 3')).not.toBeNull());
    await fireEvent.click(getByText('step 3'));

    await waitFor(() => {
      // The definition text also carries the revision hedge (Codex review, PR #978, round 3) — the
      // same caveat as the header, Overview row, and fork surfaces, so replay output can't be
      // attributed to the wrong executable artifact after a redeploy. It says what can happen
      // and leaves the engine's registration modes out of it.
      expect(
        getByText(
          /^order-processing-rev-a\. A recovery or a default fork may use a different revision/,
        ),
      ).not.toBeNull();
      expect(document.body.textContent).not.toMatch(/eager|loaded code/i);
    });
  });

  test('ReplayView says nothing was stored for an empty state, instead of an empty inspector', async () => {
    const client = {
      ...baseClient(),
      replayTo: async () => ({
        checkpoint: { step: 3, locals: {}, searchAttributes: {}, version: '1', createdAt: 0 },
        accumulatedResults: [],
        events: [],
      }),
    };
    const { getByText, getAllByText, container } = render(CheckpointsTabHarness, {
      props: {
        client,
        workflowId: 'wf-1',
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    await waitFor(() => expect(getByText('step 3')).not.toBeNull());
    await fireEvent.click(getByText('step 3'));

    await waitFor(() => expect(getAllByText('Nothing was stored at this step.')).toHaveLength(2));
    expect(container.querySelector('.cinder-payload-inspector')).toBeNull();
  });

  test('ReplayView explains an unknown revision when replay.revision is absent', async () => {
    const client = {
      ...baseClient(),
      replayTo: async () => ({
        checkpoint: { step: 3, locals: {}, searchAttributes: {}, version: '1', createdAt: 0 },
        accumulatedResults: [],
        events: [],
      }),
    };

    const { getByText } = render(CheckpointsTabHarness, {
      props: {
        client,
        workflowId: 'wf-1',
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    await waitFor(() => expect(getByText('step 3')).not.toBeNull());
    await fireEvent.click(getByText('step 3'));

    await waitFor(() => {
      expect(getByText(/^Not known\./)).not.toBeNull();
      // The explanation covers every reason `resolveReplayRevision()` omits a revision (Codex
      // review, PR #978, round 6): the record is gone, it predates revision tracking, or the ID
      // has been reused by a different run.
      expect(getByText(/predates revision tracking/)).not.toBeNull();
      expect(getByText(/reused by a different run/)).not.toBeNull();
    });
  });

  test('a query fault (e.g. a 404 from the checkpoints operation) shows the real fault treatment, not a fabricated "no checkpoints" empty state', async () => {
    const client = baseClient();
    const failingClient = {
      ...client,
      operations: {
        ...client.operations,
        'weft.workflows.checkpoints.list': async () => {
          throw new HttpClientError(404, 'Not found: POST /jsonrpc');
        },
      },
    };

    const { getByText, queryByText } = render(CheckpointsTabHarness, {
      props: {
        client: failingClient,
        workflowId: 'wf-1',
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    await waitFor(() => {
      expect(getByText('Not found: POST /jsonrpc')).not.toBeNull();
    });
    expect(queryByText('No checkpoint history retained')).toBeNull();
  });

  test('a principal missing workflows:read sees the disabled replay gate, not a fabricated view', async () => {
    const { getByText } = render(CheckpointsTabHarness, {
      props: {
        client: baseClient(),
        workflowId: 'wf-1',
        principal: { scopes: [], unauthenticatedAccess: null },
        queryClient: newQueryClient(),
      },
    });

    await waitFor(() => expect(getByText('step 3')).not.toBeNull());
    await fireEvent.click(getByText('step 3'));

    await waitFor(() => {
      expect(getByText('Replay unavailable')).not.toBeNull();
    });
  });
});
