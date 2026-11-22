import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type {
  PaginatedResult,
  WorkflowScheduleProvenance,
  WorkflowState,
  WorkflowSummary,
} from '@lostgradient/weft';

import { forkOperations } from './checkpoints/fork-comparison.test-support.ts';
import LineagePanelHarness from './lineage-panel.test-harness.svelte';

function workflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: 'wf_current',
    type: 'order-fulfillment',
    status: 'running',
    input: {},
    versionTuple: { workflowVersion: '1' },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function emptyChildren(): PaginatedResult<WorkflowSummary> {
  return { items: [], total: 0, offset: 0, limit: 5 };
}

function noProvenance(): Promise<WorkflowScheduleProvenance | null> {
  return Promise.resolve(null);
}

function baseClient(
  overrides: {
    get?: (id: string) => Promise<WorkflowState | null>;
    list?: () => Promise<PaginatedResult<WorkflowSummary>>;
    scheduleProvenance?: () => Promise<WorkflowScheduleProvenance | null>;
    compare?: ReturnType<typeof forkOperations>['weft.workflows.compare'];
  } = {},
) {
  return {
    get: overrides.get ?? (async () => null),
    list: overrides.list ?? (async () => emptyChildren()),
    operations: {
      'weft.workflows.active.get': async (_input: { name: string }) => null,
      'weft.workflows.scheduleprovenance.get': overrides.scheduleProvenance ?? noProvenance,
      'weft.workflows.compare': forkOperations({ compare: overrides.compare })[
        'weft.workflows.compare'
      ],
    },
  };
}

describe('LineagePanel', () => {
  test('draws nothing for a normal run: no forked-from row, no continuation chain, no schedule, no heading', async () => {
    const { container, queryByText } = render(LineagePanelHarness, {
      props: { client: baseClient(), workflow: workflow() },
    });

    await waitFor(() =>
      expect(container.querySelector('[data-section="lineage"]')?.outerHTML ?? null).toBeNull(),
    );
    expect(queryByText('Lineage')).toBeNull();
    expect(queryByText('Forked from')).toBeNull();
    expect(queryByText('This run')).toBeNull();
    expect(queryByText('Launched by schedule')).toBeNull();
  });

  test('renders the forked-from row using the source workflow type as the link label', async () => {
    const client = baseClient({
      get: async (id) =>
        id === 'wf_source' ? workflow({ id: 'wf_source', type: 'reconcile-ledger' }) : null,
    });

    const { getByText } = render(LineagePanelHarness, {
      props: {
        client,
        workflow: workflow({ forkedFrom: { workflowId: 'wf_source', step: 12 } }),
      },
    });

    await waitFor(() => {
      expect(getByText('reconcile-ledger')).not.toBeNull();
    });
    expect(getByText('at step 12')).not.toBeNull();
  });

  // Forked-from SOURCE REVISION attribution (`sourceRevisionAttributable`)
  // has its own file, `lineage-panel-source-revision.test.ts`, split out
  // purely to stay under the implementation-file line cap — see that
  // file's module doc.

  test('falls back to a truncated-id label when the forked-from source is no longer visible', async () => {
    const client = baseClient();

    const { getByText } = render(LineagePanelHarness, {
      props: {
        client,
        workflow: workflow({
          forkedFrom: { workflowId: 'wf_purged_00000000000000000000', step: 3 },
        }),
      },
    });

    await waitFor(() => {
      expect(getByText(/run$/)).not.toBeNull();
    });
    // Purged (`client.get()`'s documented `null` 404 contract) still gets
    // an explicit revision-status badge, not silence (Codex review, PR
    // #978, round 6) — none of the three sourceRevisionAttributable-gated
    // branches ever matched a null `data`.
    expect(getByText('Revision unavailable')).not.toBeNull();
  });

  test('shows an explicit "Revision unavailable" badge — not silence — when the forked-from source lookup itself errors (Codex review, PR #978, round 6)', async () => {
    const client = baseClient({
      get: async () => {
        throw new Error('network failure');
      },
    });

    const { getByText } = render(LineagePanelHarness, {
      props: {
        client,
        workflow: workflow({
          forkedFrom: { workflowId: 'wf_source', step: 3 },
        }),
      },
    });

    await waitFor(() => {
      expect(getByText('Revision unavailable')).not.toBeNull();
    });
  });
});

describe('LineagePanel compare with source (COR-2538)', () => {
  const comparison = (input: { workflowId: string }) => ({
    workflowId: input.workflowId,
    sourceWorkflowId: 'wf_source',
    forkPoint: 12,
    steps: [
      {
        index: 11,
        shared: false,
        source: {
          operationType: 'activity',
          label: 'issueTicket',
          status: 'completed' as const,
          input: '{}',
          output: '{"ticket":1}',
        },
        fork: {
          operationType: 'activity',
          label: 'issueTicket',
          status: 'completed' as const,
          input: '{}',
          output: '{"ticket":2}',
        },
      },
    ],
  });

  test('a run that is not a fork has no compare action', async () => {
    const { queryByRole, container } = render(LineagePanelHarness, {
      props: { client: baseClient(), workflow: workflow() },
    });
    await waitFor(() =>
      expect(container.querySelector('[data-section="lineage"]')?.outerHTML ?? null).toBeNull(),
    );
    expect(queryByRole('button', { name: 'Compare with source' })).toBeNull();
  });

  test('a fork opens its comparison from its own id alone, as it would after a reload', async () => {
    const asked: string[] = [];
    const { getByRole, getByText, container } = render(LineagePanelHarness, {
      props: {
        client: baseClient({
          compare: async (input) => {
            asked.push(input.workflowId);
            return comparison(input);
          },
        }),
        workflow: workflow({ id: 'wf_fork', forkedFrom: { workflowId: 'wf_source', step: 12 } }),
      },
    });

    // Nothing is asked until the owner opens the comparison.
    await waitFor(() =>
      expect(getByRole('button', { name: 'Compare with source' })).not.toBeNull(),
    );
    expect(asked).toEqual([]);

    await fireEvent.click(getByRole('button', { name: 'Compare with source' }));

    await waitFor(() =>
      expect(container.querySelector('[data-compared-step="11"]')).not.toBeNull(),
    );
    expect(asked).toEqual(['wf_fork']);
    expect(getByText(/Forked from checkpoint step 12/)).not.toBeNull();
    expect(getByRole('button', { name: 'Hide comparison' }).getAttribute('aria-expanded')).toBe(
      'true',
    );

    await fireEvent.click(getByRole('button', { name: 'Hide comparison' }));
    expect(container.querySelector('[data-section="fork-comparison"]')).toBeNull();
  });
});
