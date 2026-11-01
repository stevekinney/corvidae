import type { WorkflowState, WorkflowSummary } from '@lostgradient/weft';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';
import type { ComponentProps } from 'svelte';

import type { RelatedRunsClient } from './run-related-data.ts';
import RunRelatedHarness from './run-related.test-harness.svelte';

function summary(id: string, type = 'child-type'): WorkflowSummary {
  return {
    id,
    type,
    status: 'completed',
    version: '1',
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

const parentState = {
  id: 'parent-run-id-000',
  type: 'parent-type',
  status: 'running',
  input: {},
  versionTuple: { workflowVersion: '1' },
  createdAt: 500,
  updatedAt: 500,
} as WorkflowState;

/** A client over a tree: the parent started `self` and `peer`; `self` started `kid`. */
function client(
  options: {
    failList?: boolean;
    empty?: boolean;
    manyChildren?: number;
    kidRevision?: string;
  } = {},
) {
  return {
    operations: {
      'weft.workflows.active.get': async () => ({
        revision: 'rev-active',
        generation: 1,
        activatedAt: 1,
      }),
    },
    get: async () => parentState,
    list: async (filter: { parentWorkflowId?: string }) => {
      if (options.failList) throw new Error('list is down');
      if (options.empty) return { items: [], total: 0 };
      if (filter.parentWorkflowId === 'parent-run-id-000') {
        return {
          items: [
            summary('self-run-id-0001', 'self-type'),
            summary('peer-run-id-0001', 'peer-type'),
          ],
          total: 2,
        };
      }
      const count = options.manyChildren ?? 1;
      return {
        items: Array.from({ length: count }, (_, index) => ({
          ...summary(`kid-run-id-${String(index).padStart(4, '0')}`, 'kid-type'),
          ...(options.kidRevision === undefined ? {} : { revision: options.kidRevision }),
        })),
        total: count,
      };
    },
  } as unknown as RelatedRunsClient;
}

const selfRun: ComponentProps<typeof RunRelatedHarness>['workflow'] = {
  id: 'self-run-id-0001',
  type: 'self-type',
  status: 'running',
  parentWorkflowId: 'parent-run-id-000',
  createdAt: 1_000,
};

describe('RunRelated', () => {
  test('lists the run that started this one, the runs it started, and the runs started alongside it', async () => {
    const { container, findByText } = render(RunRelatedHarness, {
      props: { client: client(), workflow: selfRun },
    });
    await findByText('parent-type');
    const groups = [...container.querySelectorAll('[data-group]')].map((group) =>
      group.getAttribute('data-group'),
    );
    expect(groups).toEqual(['Started by', 'Started', 'Started alongside']);
    expect(container.querySelector('[data-group="Started by"]')?.textContent).toContain(
      'parent-type',
    );
    expect(container.querySelector('[data-group="Started"]')?.textContent).toContain('kid-type');
    const siblings = container.querySelector('[data-group="Started alongside"]');
    expect(siblings?.textContent).toContain('peer-type');
    expect(siblings?.textContent).not.toContain('self-type');
  });

  test('links each run to its own page', async () => {
    const { findByRole } = render(RunRelatedHarness, {
      props: { client: client(), workflow: selfRun },
    });
    const link = await findByRole('link', { name: 'Open run parent-type' });
    expect(link.getAttribute('href')).toContain('parent-run-id-000');
  });

  test('badges a child that ran an older revision than the active one, and one that ran the active', async () => {
    const stale = render(RunRelatedHarness, {
      props: { client: client({ kidRevision: 'rev-old' }), workflow: selfRun },
    });
    expect(await stale.findByText('Differs from active')).not.toBeNull();
    const current = render(RunRelatedHarness, {
      props: { client: client({ kidRevision: 'rev-active' }), workflow: selfRun },
    });
    expect(await current.findByText('Active')).not.toBeNull();
  });

  test('shows a few of a long list and counts the rest', async () => {
    const { container, findByText } = render(RunRelatedHarness, {
      props: { client: client({ manyChildren: 8 }), workflow: selfRun },
    });
    await findByText('3 more');
    expect(container.querySelectorAll('[data-group="Started"] li')).toHaveLength(6);
  });

  test('says a run has no relatives once, in one empty state, and offers no topology', async () => {
    const { findByText, queryByRole } = render(RunRelatedHarness, {
      props: {
        client: client({ empty: true }),
        workflow: { ...selfRun, parentWorkflowId: undefined },
      },
    });
    expect(await findByText('No related runs')).not.toBeNull();
    expect(queryByRole('button', { name: 'Topology' })).toBeNull();
  });

  test('shows an error state with a way to try again when the runs cannot be read', async () => {
    const { findByText, findByRole } = render(RunRelatedHarness, {
      props: { client: client({ failList: true }), workflow: selfRun },
    });
    expect(await findByText('Related runs could not be read')).not.toBeNull();
    expect(await findByRole('button', { name: 'Try again' })).not.toBeNull();
  });

  test('opens the topology in a drawer, with this run marked among the others', async () => {
    const { findByRole, findByTestId, getByText } = render(RunRelatedHarness, {
      props: { client: client(), workflow: selfRun },
    });
    await fireEvent.click(await findByRole('button', { name: 'Topology' }));
    const tree = await findByTestId('run-topology');
    await waitFor(() => expect(tree.querySelectorAll('li').length).toBe(4));
    expect([...tree.querySelectorAll('li')].map((item) => item.getAttribute('data-depth'))).toEqual(
      ['0', '1', '2', '1'],
    );
    expect(tree.querySelector('[data-current]')?.textContent).toContain('This run');
    expect(getByText('Run topology')).not.toBeNull();
  });
});
