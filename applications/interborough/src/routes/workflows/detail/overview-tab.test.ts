import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { PaginatedResult, WorkflowState, WorkflowSummary } from '@lostgradient/weft';

import { quietFor } from '@lostgradient/testing/wait-until';
import type { WorkflowCatalogActivePointerLike } from '../../../lib/workflow-revision.ts';
import OverviewTabHarness from './overview-tab.test-harness.svelte';

function workflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: 'wf_1',
    type: 'order-fulfillment',
    status: 'running',
    input: { orderId: 'ord-1' },
    versionTuple: { workflowVersion: '1' },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function emptyPage(): PaginatedResult<WorkflowSummary> {
  return { items: [], total: 0, offset: 0, limit: 5 };
}

function baseClient() {
  return {
    addTags: async () => {},
    removeTags: async () => {},
    get: async (): Promise<WorkflowState | null> => null,
    list: async (): Promise<PaginatedResult<WorkflowSummary>> => emptyPage(),
    operations: {
      'weft.workflows.active.get': async (_input: { name: string }) => null,
      'weft.workflows.scheduleprovenance.get': async () => null,
    },
  };
}

describe('OverviewTab', () => {
  test('running workflow shows the pending-result message, not a result panel', async () => {
    const { getByText, queryByText } = render(OverviewTabHarness, {
      props: { client: baseClient(), workflow: workflow({ status: 'running' }) },
    });

    expect(getByText(/Result pending — workflow still running/)).not.toBeNull();
    expect(queryByText('Result')).toBeNull();
  });

  test('shows a distinct Revision row when the workflow has one', async () => {
    const { getByText } = render(OverviewTabHarness, {
      props: {
        client: baseClient(),
        workflow: workflow({ revision: 'sha256:deadbeef', versionTuple: { workflowVersion: '1' } }),
      },
    });

    expect(getByText('Revision')).not.toBeNull();
    expect(getByText('sha256:deadbeef')).not.toBeNull();
  });

  test('sets the type, version, and revision in monospace, and lets a long revision wrap', async () => {
    const { container } = render(OverviewTabHarness, {
      props: {
        client: baseClient(),
        workflow: workflow({
          type: 'order-fulfillment',
          revision: `sha256:${'f'.repeat(64)}`,
          versionTuple: { workflowVersion: '2' },
        }),
      },
    });

    const code = [...container.querySelectorAll('dd code.ib-identifier')].map(
      (element) => element.textContent,
    );
    expect(code).toEqual(['order-fulfillment', 'wf 2', `sha256:${'f'.repeat(64)}`]);
    expect(container.querySelector('dd code.weft-overview-tab__code')).not.toBeNull();
  });

  /** The text of the Revision row's definition: the hash, and the words that compare it to the active one. */
  function revisionText(container: HTMLElement): string | undefined {
    const term = [...container.querySelectorAll('dt')].find(
      (element) => element.textContent?.trim() === 'Revision',
    );
    return term?.nextElementSibling?.textContent?.trim();
  }

  describe('Revision row active-comparison text (WFT-117)', () => {
    const ACTIVE: WorkflowCatalogActivePointerLike = {
      revision: 'sha256:deadbeef',
      generation: 2,
      activatedAt: 500,
    };

    test('reads "Unpinned (pre-revision record)" for a legacy workflow with no persisted revision — the row is never omitted', async () => {
      const { getByText } = render(OverviewTabHarness, {
        props: { client: baseClient(), workflow: workflow(), activeRevision: ACTIVE },
      });

      expect(getByText('Revision')).not.toBeNull();
      expect(getByText('Unpinned (pre-revision record)')).not.toBeNull();
    });

    test('reads "— active" when workflow.revision matches the active pointer', async () => {
      const { container } = render(OverviewTabHarness, {
        props: {
          client: baseClient(),
          workflow: workflow({ revision: ACTIVE.revision }),
          activeRevision: ACTIVE,
        },
      });

      expect(revisionText(container)).toBe(`${ACTIVE.revision} — active`);
    });

    test('reads "— differs from active" when workflow.revision differs from the active pointer', async () => {
      const { container } = render(OverviewTabHarness, {
        props: {
          client: baseClient(),
          workflow: workflow({ revision: 'sha256:stale000' }),
          activeRevision: ACTIVE,
        },
      });

      expect(revisionText(container)).toBe('sha256:stale000 — differs from active');
    });

    test('reads "— active revision unknown" when activeRevision is null (never activated)', async () => {
      const { container } = render(OverviewTabHarness, {
        props: {
          client: baseClient(),
          workflow: workflow({ revision: ACTIVE.revision }),
          activeRevision: null,
        },
      });

      expect(revisionText(container)).toBe(`${ACTIVE.revision} — active revision unknown`);
    });

    test('reads "— active revision unknown" when activeRevision is omitted (denied/loading)', async () => {
      const { container } = render(OverviewTabHarness, {
        props: {
          client: baseClient(),
          workflow: workflow({ revision: ACTIVE.revision }),
        },
      });

      expect(revisionText(container)).toBe(`${ACTIVE.revision} — active revision unknown`);
    });
  });

  test('completed workflow shows a Result panel', async () => {
    const { getByText } = render(OverviewTabHarness, {
      props: {
        client: baseClient(),
        workflow: workflow({ status: 'completed', result: { ok: true } }),
      },
    });

    expect(getByText('Result')).not.toBeNull();
  });

  test('failed workflow shows the failure-category badge and plain-language explanation', async () => {
    const { getByText } = render(OverviewTabHarness, {
      props: {
        client: baseClient(),
        workflow: workflow({
          status: 'failed',
          failureCategory: 'timeout',
          error: 'the activity took too long',
        }),
      },
    });

    expect(getByText('timeout')).not.toBeNull();
    expect(getByText(/exceeded its configured deadline/)).not.toBeNull();
    expect(getByText('the activity took too long')).not.toBeNull();
  });

  test('cancelled workflow shows a neutral no-result message', async () => {
    const { getByText } = render(OverviewTabHarness, {
      props: { client: baseClient(), workflow: workflow({ status: 'cancelled' }) },
    });

    expect(getByText(/no result value/)).not.toBeNull();
  });

  test('renders existing tags', async () => {
    const { getByText } = render(OverviewTabHarness, {
      props: { client: baseClient(), workflow: workflow({ tags: ['prod', 'tier-1'] }) },
    });

    expect(getByText('prod')).not.toBeNull();
    expect(getByText('tier-1')).not.toBeNull();
  });

  test('adding a tag calls client.addTags with the trimmed value', async () => {
    const added: { tag: string | null } = { tag: null };
    const client = {
      ...baseClient(),
      addTags: async (_id: string, tag: string) => {
        added.tag = tag;
      },
    };

    const { getByPlaceholderText } = render(OverviewTabHarness, {
      props: { client, workflow: workflow() },
    });

    const input = getByPlaceholderText('Add tag');
    await fireEvent.input(input, { target: { value: '  urgent  ' } });
    await fireEvent.keyDown(input, { key: 'Enter' });

    expect(added.tag).toBe('urgent');
  });

  test('two edits before the engine answers each send their own write, and a tag added then removed is removed', async () => {
    const writes: string[] = [];
    const client = {
      ...baseClient(),
      addTags: async (_id: string, tag: string) => {
        writes.push(`add ${tag}`);
      },
      removeTags: async (_id: string, tag: string) => {
        writes.push(`remove ${tag}`);
      },
    };
    const { getByPlaceholderText, getByRole } = render(OverviewTabHarness, {
      props: { client, workflow: workflow() },
    });

    const input = getByPlaceholderText('Add tag');
    await fireEvent.input(input, { target: { value: 'one' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await fireEvent.input(input, { target: { value: 'two' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await fireEvent.click(getByRole('button', { name: 'Remove one' }));

    await waitFor(() => expect(writes).toEqual(['add one', 'add two', 'remove one']));
  });

  test('a tag removed before its add has settled stays removed: the writes reach the engine one at a time, in edit order', async () => {
    // The engine applies a write when its request lands. The add is slow and the remove is quick, so
    // sent independently the remove would land first, do nothing, and the add would then restore the tag.
    const stored = new Set<string>();
    let releaseAdd!: () => void;
    const addLanded = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    const calls: string[] = [];
    const client = {
      ...baseClient(),
      addTags: async (_id: string, tag: string) => {
        calls.push(`add ${tag}`);
        await addLanded;
        stored.add(tag);
      },
      removeTags: async (_id: string, tag: string) => {
        calls.push(`remove ${tag}`);
        stored.delete(tag);
      },
    };
    const { getByPlaceholderText, getByRole } = render(OverviewTabHarness, {
      props: { client, workflow: workflow() },
    });

    const input = getByPlaceholderText('Add tag');
    await fireEvent.input(input, { target: { value: 'one' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await fireEvent.click(getByRole('button', { name: 'Remove one' }));
    await quietFor(20);

    // The remove waits for the add; it has not been sent.
    expect(calls).toEqual(['add one']);

    releaseAdd();
    await waitFor(() => expect(calls).toEqual(['add one', 'remove one']));
    await waitFor(() => expect([...stored]).toEqual([]));
  });

  test('a failed tag write does not hold back the writes behind it', async () => {
    const stored = new Set<string>(['old']);
    const client = {
      ...baseClient(),
      addTags: async () => {
        throw new Error('refused');
      },
      removeTags: async (_id: string, tag: string) => {
        stored.delete(tag);
      },
    };
    const { getByPlaceholderText, getByRole } = render(OverviewTabHarness, {
      props: { client, workflow: workflow({ tags: ['old'] }) },
    });

    const input = getByPlaceholderText('Add tag');
    await fireEvent.input(input, { target: { value: 'new' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await fireEvent.click(getByRole('button', { name: 'Remove old' }));

    await waitFor(() => expect([...stored]).toEqual([]));
  });

  test('timed-out workflow shows a neutral no-result message', async () => {
    const { getByText } = render(OverviewTabHarness, {
      props: { client: baseClient(), workflow: workflow({ status: 'timed-out' }) },
    });

    expect(getByText(/timed out/)).not.toBeNull();
  });

  test('a failed workflow with no failure category shows neither the badge nor the explanation', async () => {
    const { getByText, queryByText } = render(OverviewTabHarness, {
      props: {
        client: baseClient(),
        workflow: workflow({ status: 'failed', error: 'boom' }),
      },
    });

    expect(getByText('Failed')).not.toBeNull();
    expect(getByText('boom')).not.toBeNull();
    expect(queryByText(/could not be classified/)).toBeNull();
  });

  test('a failed workflow with an error stack renders a collapsible trigger for it', async () => {
    // Cinder's `Collapsible` toggles via a `transition:` directive whose
    // lifecycle event dispatch happy-dom can't construct cross-realm — no
    // test in this repo drives a transitioning Cinder trigger via
    // `fireEvent.click` (see `advanced-options.test.ts`'s identical note).
    // This only asserts the trigger itself renders (the `errorStack.length >
    // 0` branch), not the post-expand content.
    const { getByRole } = render(OverviewTabHarness, {
      props: {
        client: baseClient(),
        workflow: workflow({
          status: 'failed',
          error: 'boom',
          errorStack: 'Error: boom\n    at doThing (file.ts:1:1)',
        }),
      },
    });

    expect(getByRole('button', { name: 'Show full stack trace' })).not.toBeNull();
  });

  test('removing a tag calls client.removeTags', async () => {
    const removed: { tag: string | null } = { tag: null };
    const client = {
      ...baseClient(),
      removeTags: async (_id: string, tag: string) => {
        removed.tag = tag;
      },
    };

    const { getByRole } = render(OverviewTabHarness, {
      props: { client, workflow: workflow({ tags: ['prod'] }) },
    });

    await fireEvent.click(getByRole('button', { name: 'Remove prod' }));

    expect(removed.tag).toBe('prod');
  });

  test('pressing Enter in the Add tag input submits it, and a blank tag is a no-op', async () => {
    const added: string[] = [];
    const client = {
      ...baseClient(),
      addTags: async (_id: string, tag: string) => {
        added.push(tag);
      },
    };

    const { getByPlaceholderText } = render(OverviewTabHarness, {
      props: { client, workflow: workflow() },
    });

    const input = getByPlaceholderText('Add tag');
    await fireEvent.input(input, { target: { value: '   ' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(added).toEqual([]);

    await fireEvent.input(input, { target: { value: 'urgent' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(added).toEqual(['urgent']);
  });

  test('the Definition list includes a Deadline row when the workflow has an execution deadline', async () => {
    const { getByText } = render(OverviewTabHarness, {
      props: {
        client: baseClient(),
        workflow: workflow({ executionDeadline: Date.UTC(2026, 0, 1) }),
      },
    });

    expect(getByText('Deadline')).not.toBeNull();
  });

  test('the version summary includes agent and tool-version counts when present', async () => {
    const { getByText } = render(OverviewTabHarness, {
      props: {
        client: baseClient(),
        workflow: workflow({
          versionTuple: {
            workflowVersion: '2',
            agentVersion: 'gpt-5',
            toolVersions: ['search@1', 'browse@2'],
          },
        }),
      },
    });

    expect(getByText(/agent gpt-5/)).not.toBeNull();
    expect(getByText(/tools 2/)).not.toBeNull();
  });

  test('disables adding and removing tags when the principal lacks tags:write', async () => {
    const { getByPlaceholderText, getByText, queryByRole } = render(OverviewTabHarness, {
      props: {
        client: baseClient(),
        workflow: workflow({ tags: ['vip'] }),
        tagGate: { disabled: true, title: 'Requires tags:write' },
      },
    });

    // The tag is still shown, but it cannot be removed and nothing can be added.
    expect(getByText('vip')).not.toBeNull();
    expect(queryByRole('button', { name: 'Remove vip' })).toBeNull();
    expect(getByPlaceholderText('Add tag').hasAttribute('disabled')).toBe(true);
  });
});
