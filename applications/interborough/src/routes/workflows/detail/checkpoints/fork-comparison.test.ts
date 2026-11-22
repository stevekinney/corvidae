import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { HttpClientError } from '@lostgradient/weft';

import { fetchForkComparison, fetchForkPreview } from './fork-comparison-data.ts';
import ForkComparisonHarness from './fork-comparison.test-harness.svelte';
import { forkOperations, previewAnswer } from './fork-comparison.test-support.ts';

type Page = Awaited<ReturnType<ReturnType<typeof forkOperations>['weft.workflows.compare']>>;

function side(overrides: Record<string, string | undefined> = {}) {
  return {
    operationType: 'activity',
    label: 'issueTicket',
    status: 'completed' as const,
    input: '{"order":"ord_1"}',
    output: '{"ticket":{"id":1,"lane":"north"},"cents":4999}',
    ...overrides,
  };
}

/** A fork of `wf-1` at checkpoint step 2: step 0 is shared, step 1 differs in its output, step 2 is the same. */
function comparisonPage(overrides: Partial<Page> = {}): Page {
  return {
    workflowId: 'wf-fork',
    sourceWorkflowId: 'wf-1',
    forkPoint: 2,
    steps: [
      {
        index: 0,
        shared: true,
        source: side({ label: 'reserveStock' }),
        fork: side({ label: 'reserveStock' }),
      },
      {
        index: 1,
        shared: false,
        source: side(),
        fork: side({ output: '{"ticket":{"id":2,"lane":"north"},"cents":4999}' }),
      },
      {
        index: 2,
        shared: false,
        source: side({ label: 'notify' }),
        fork: side({ label: 'notify' }),
      },
    ],
    ...overrides,
  };
}

function client(
  compare: (input: { workflowId: string; limit?: number; cursor?: string }) => Promise<Page>,
) {
  return { operations: forkOperations({ compare }) };
}

describe('ForkComparison', () => {
  test('shows the shared steps collapsed and the steps the fork ran again, marked by kind', async () => {
    const { getByText, getByRole, container, queryByText } = render(ForkComparisonHarness, {
      props: { client: client(async () => comparisonPage()), workflowId: 'wf-fork' },
    });

    await waitFor(() => expect(getByText('1 step shared with the source')).not.toBeNull());
    expect(
      getByText(/Forked from checkpoint step 2\. The steps before it keep the source’s results/),
    ).not.toBeNull();
    // The shared step is behind the collapsed disclosure, not among the steps the fork ran again.
    expect(container.querySelector('[data-compared-step="0"]')).toBeNull();
    expect(queryByText('Step 1, reserveStock')).toBeNull();
    await fireEvent.click(getByRole('button', { name: '1 step shared with the source' }));
    expect(getByText('Step 1, reserveStock')).not.toBeNull();
    expect(container.querySelector('[data-shared-step="0"]')?.textContent).toContain('Shared');

    const changed = container.querySelector('[data-compared-step="1"]');
    expect(changed?.getAttribute('data-kind')).toBe('changed');
    expect(changed?.textContent).toContain('Step 2, issueTicket');
    expect(changed?.textContent).toContain('Changed');
    expect(changed?.textContent).toContain('Differs in output');
    expect(container.querySelector('[data-compared-step="2"]')?.getAttribute('data-kind')).toBe(
      'unchanged',
    );
  });

  test('selecting a changed step shows its output difference in the diff viewer', async () => {
    const { getByText, getByRole, container } = render(ForkComparisonHarness, {
      props: { client: client(async () => comparisonPage()), workflowId: 'wf-fork' },
    });
    await waitFor(() => expect(container.querySelector('[data-compared-step="1"]')).not.toBeNull());
    expect(getByText('Select a step')).not.toBeNull();

    await fireEvent.click(getByRole('button', { name: /Step 2, issueTicket/ }));

    const detail = container.querySelector('[data-compared-detail="1"]');
    expect(detail).not.toBeNull();
    // The input is the same in both runs and says so; the output is a structural diff.
    expect(getByText('The input is the same in both runs.')).not.toBeNull();
    const diff = detail?.querySelector('[role="group"][aria-label="Output differences, step 2"]');
    expect(diff).not.toBeNull();
    // The changed value is read at its depth: `ticket` holds an `id` that went from 1 to 2.
    const changed = [...(diff?.querySelectorAll('[data-cinder-diff-kind="changed"]') ?? [])];
    expect(
      changed.map((row) => row.querySelector('.cinder-json-diff-viewer__key')?.textContent),
    ).toContain('id');
    expect(diff?.textContent).toContain('1 → 2');
    // The unchanged `cents` entry sits behind the viewer's collapsed control, not among the changes.
    expect(diff?.querySelector('[data-cinder-diff-kind="unchanged"]')).toBeNull();
  });

  test('reads an input and an output that are not JSON as the text they are', async () => {
    const page = comparisonPage({
      steps: [
        {
          index: 1,
          shared: false,
          source: side({ input: 'undefined', output: undefined }),
          fork: side({ input: '[Redacted]', output: '"done"' }),
        },
      ],
    });
    const { getByRole, getByText, container } = render(ForkComparisonHarness, {
      props: { client: client(async () => page), workflowId: 'wf-fork' },
    });
    await waitFor(() => expect(container.querySelector('[data-compared-step="1"]')).not.toBeNull());

    await fireEvent.click(getByRole('button', { name: /Step 2/ }));

    expect(
      container.querySelector('[role="group"][aria-label="Input differences, step 2"]')
        ?.textContent,
    ).toContain('[Redacted]');
    expect(getByText('The source has not recorded an output for this step.')).not.toBeNull();
  });

  test('a step only one run has says which run reached it', async () => {
    const page = comparisonPage({
      steps: [
        { index: 1, shared: false, source: side() },
        { index: 2, shared: false, fork: side({ label: 'extra' }) },
      ],
    });
    const { getByRole, getByText, container } = render(ForkComparisonHarness, {
      props: { client: client(async () => page), workflowId: 'wf-fork' },
    });
    await waitFor(() => expect(container.querySelector('[data-compared-step="1"]')).not.toBeNull());
    expect(container.querySelector('[data-compared-step="1"]')?.getAttribute('data-kind')).toBe(
      'source-only',
    );
    expect(container.querySelector('[data-compared-step="2"]')?.getAttribute('data-kind')).toBe(
      'fork-only',
    );

    await fireEvent.click(getByRole('button', { name: /Step 2/ }));
    expect(getByText('The fork has not reached this step.')).not.toBeNull();
    await fireEvent.click(getByRole('button', { name: /Step 3/ }));
    expect(getByText('The source never reached this step.')).not.toBeNull();
  });

  test('shows the server’s refusal, with a retry, instead of an empty comparison', async () => {
    let attempts = 0;
    const { getByText, getByRole } = render(ForkComparisonHarness, {
      props: {
        client: client(async () => {
          attempts += 1;
          if (attempts === 1) throw new HttpClientError(422, 'Workflow wf-fork is not a fork');
          return comparisonPage();
        }),
        workflowId: 'wf-fork',
      },
    });

    await waitFor(() => expect(getByText('The comparison could not be read')).not.toBeNull());
    expect(getByText(/not a fork/)).not.toBeNull();

    await fireEvent.click(getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(getByText('1 step shared with the source')).not.toBeNull());
  });
});

describe('fetchForkComparison', () => {
  test('follows nextCursor so a comparison of more than one page is whole', async () => {
    const asked: Array<{ cursor?: string; limit?: number }> = [];
    const pages: Record<string, Page> = {
      first: comparisonPage({
        steps: [{ index: 0, shared: true, source: side(), fork: side() }],
        nextCursor: 'step:0',
      }),
      'step:0': comparisonPage({
        steps: [{ index: 1, shared: false, source: side(), fork: side() }],
        nextCursor: 'step:1',
      }),
      'step:1': comparisonPage({
        steps: [{ index: 2, shared: false, source: side() }],
      }),
    };

    const result = await fetchForkComparison(
      client(async (input) => {
        asked.push({ cursor: input.cursor, limit: input.limit });
        return pages[input.cursor ?? 'first']!;
      }),
      'wf-fork',
    );

    expect(result.steps.map((step) => step.index)).toEqual([0, 1, 2]);
    expect(result).not.toHaveProperty('nextCursor');
    expect(asked.map((call) => call.cursor)).toEqual([undefined, 'step:0', 'step:1']);
    expect(new Set(asked.map((call) => call.limit))).toEqual(new Set([1000]));
  });
});

describe('fetchForkPreview', () => {
  test('refuses an answer that is a created fork, not a preview', async () => {
    const operations = {
      'weft.workflows.fork': async () => ({ id: 'wf-created' }),
    };
    await expect(fetchForkPreview({ operations }, 'wf-1', { fromStep: 1 })).rejects.toThrow(
      'did not answer the dry run with a preview',
    );
  });

  test('asks for a dry run of the step and revision, and returns the preview', async () => {
    const seen: unknown[] = [];
    const operations = {
      'weft.workflows.fork': async (input: unknown) => {
        seen.push(input);
        return previewAnswer();
      },
    };

    const preview = await fetchForkPreview({ operations }, 'wf-1', {
      fromStep: 4,
      revision: 'rev-x',
    });

    expect(seen).toEqual([{ workflowId: 'wf-1', fromStep: 4, revision: 'rev-x', dryRun: true }]);
    expect(preview.keptSteps).toHaveLength(1);
  });
});
