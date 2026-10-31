/**
 * The run's tags, edited in place: each change is one write, the writes reach the engine one at a
 * time in the order they were made, and a caller without `tags:write` cannot change them.
 */
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { WorkflowState } from '@lostgradient/weft';

import { quietFor } from '@lostgradient/testing/wait-until';
import RunTagsHarness from './run-tags.test-harness.svelte';

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

function baseClient() {
  return {
    addTags: async () => {},
    removeTags: async () => {},
  };
}

describe('the run’s tags', () => {
  test('renders existing tags', async () => {
    const { getByText } = render(RunTagsHarness, {
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

    const { getByPlaceholderText } = render(RunTagsHarness, {
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
    const { getByPlaceholderText, getByRole } = render(RunTagsHarness, {
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
    const { getByPlaceholderText, getByRole } = render(RunTagsHarness, {
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
    const { getByPlaceholderText, getByRole } = render(RunTagsHarness, {
      props: { client, workflow: workflow({ tags: ['old'] }) },
    });

    const input = getByPlaceholderText('Add tag');
    await fireEvent.input(input, { target: { value: 'new' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await fireEvent.click(getByRole('button', { name: 'Remove old' }));

    await waitFor(() => expect([...stored]).toEqual([]));
  });

  test('removing a tag calls client.removeTags', async () => {
    const removed: { tag: string | null } = { tag: null };
    const client = {
      ...baseClient(),
      removeTags: async (_id: string, tag: string) => {
        removed.tag = tag;
      },
    };

    const { getByRole } = render(RunTagsHarness, {
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

    const { getByPlaceholderText } = render(RunTagsHarness, {
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

  test('disables adding and removing tags when the principal lacks tags:write', async () => {
    const { getByPlaceholderText, getByText, queryByRole } = render(RunTagsHarness, {
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
