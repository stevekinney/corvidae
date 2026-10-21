import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, jest, test } from 'bun:test';
import { tick } from 'svelte';

import { HttpClientError, type WorkflowState } from '@lostgradient/weft';
import { QueryClient } from '@tanstack/svelte-query';

import { RUN_DETAIL_COPY } from '../../../app/copy.ts';
import UpdatesTabHarness from './updates-tab.test-harness.svelte';
import type { UpdateHistoryEntry } from './updates/updates-data.ts';

function workflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: 'wf_1',
    type: 'order-fulfillment',
    status: 'running',
    input: {},
    versionTuple: { workflowVersion: '1' },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

/** The entry's place in the history, as the real key tail orders it. */
function positionKey(item: UpdateHistoryEntry): string {
  return `${String(item.receivedAt).padStart(16, '0')}:${item.updateId}`;
}

type Stored = { result: unknown } | 'swept';

/**
 * A fake server holding a run's update history and the answers still kept. `submit` can be replaced
 * to model a timeout or a refusal; the history it lists is newest first, as the real operation's.
 */
function fakeServer(initial: UpdateHistoryEntry[] = [], pageSize = 50) {
  const entries = [...initial];
  const answers = new Map<string, Stored>();
  const calls = {
    list: [] as Array<{ cursor?: string }>,
    result: [] as string[],
    submit: [] as Array<Record<string, unknown>>,
  };
  const server = {
    entries,
    answers,
    calls,
    submit: undefined as
      | undefined
      | ((name: string, payload: unknown) => Promise<{ updateId: string; result: unknown }>),
    client: {
      operations: {
        'weft.workflows.update': async (input: {
          workflowId: string;
          updateName: string;
          payload?: unknown;
          timeout?: unknown;
          idempotencyKey?: unknown;
        }) => {
          calls.submit.push({ ...input });
          if (server.submit !== undefined) return server.submit(input.updateName, input.payload);
          const updateId = `u-${entries.length + 1}`;
          entries.unshift({
            updateId,
            name: input.updateName,
            receivedAt: 5_000 + entries.length,
            outcome: 'completed',
          });
          answers.set(updateId, { result: { echoed: input.payload ?? null } });
          return { updateId, result: { echoed: input.payload ?? null } };
        },
        // Pages by position, as `weft.workflows.updates.list` does: the cursor is the key of the last entry a
        // page returned (`<receivedAt>:<updateId>`), and the next page is what sorts strictly before it. A fake that
        // paged by offset could not show an entry falling between two pages.
        'weft.workflows.updates.list': async (input: { cursor?: string }) => {
          calls.list.push(input.cursor === undefined ? {} : { cursor: input.cursor });
          const sorted = entries.toSorted((left, right) =>
            positionKey(right).localeCompare(positionKey(left)),
          );
          const older =
            input.cursor === undefined
              ? sorted
              : sorted.filter((item) => positionKey(item) < (input.cursor ?? ''));
          const items = older.slice(0, pageSize);
          const last = items.at(-1);
          return {
            items,
            ...(older.length > pageSize && last !== undefined
              ? { nextCursor: positionKey(last) }
              : {}),
          };
        },
        'weft.updates.result.get': async (input: { updateId: string }) => {
          calls.result.push(input.updateId);
          const stored = answers.get(input.updateId);
          return stored === undefined || stored === 'swept'
            ? { status: 'pending' as const }
            : { status: 'completed' as const, result: stored.result };
        },
      },
    },
  };
  return server;
}

function entry(
  overrides: { updateId: string } & Partial<Omit<UpdateHistoryEntry, 'updateId'>>,
): UpdateHistoryEntry {
  return {
    name: 'applyDiscount',
    receivedAt: 1_000,
    outcome: 'completed',
    completedAt: 1_100,
    ...overrides,
  };
}

/** An update the run has received and not answered: it has no `completedAt`. */
function pendingEntry(overrides: {
  updateId: string;
  name?: string;
  receivedAt?: number;
}): UpdateHistoryEntry {
  return {
    name: 'applyDiscount',
    receivedAt: 1_000,
    ...overrides,
    outcome: 'pending',
  };
}

function renderTab(
  server: ReturnType<typeof fakeServer>,
  props: {
    canSend?: boolean;
    status?: WorkflowState['status'];
    queryClient?: QueryClient;
  } = {},
) {
  return render(UpdatesTabHarness, {
    props: {
      client: server.client,
      workflow: workflow({ status: props.status ?? 'running' }),
      canSend: props.canSend ?? true,
      ...(props.queryClient === undefined ? {} : { queryClient: props.queryClient }),
    },
  });
}

afterEach(() => {
  jest.useRealTimers();
});

/** The page's fault banner: the editor's own validation also uses `role="alert"`, so the role alone is not enough. */
async function faultBanner(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const banner = container.querySelector<HTMLElement>('.weft-workflow-detail__fault');
    expect(banner).not.toBeNull();
    return banner as HTMLElement;
  });
}

describe('UpdatesTab history', () => {
  test('says so when the run has received no update', async () => {
    const { findByText } = renderTab(fakeServer());
    expect(await findByText(RUN_DETAIL_COPY.updates.empty)).not.toBeNull();
  });

  test('lists every update the run has received, newest first, including those sent before the page loaded', async () => {
    const server = fakeServer([
      pendingEntry({ updateId: 'u-3', name: 'cancelOrder', receivedAt: 3_000 }),
      entry({
        updateId: 'u-2',
        name: 'refund',
        receivedAt: 2_000,
        outcome: 'failed',
        error: 'insufficient balance',
      }),
      entry({ updateId: 'u-1', name: 'applyDiscount', receivedAt: 1_000 }),
    ]);
    server.answers.set('u-1', { result: { discounted: true } });
    const { container, findByText } = renderTab(server);

    await findByText('cancelOrder');
    const names = [...container.querySelectorAll<HTMLElement>('[data-update-id]')].map(
      (row) => row.dataset['updateId'],
    );
    expect(names).toEqual(['u-3', 'u-2', 'u-1']);
    expect(container.textContent).toContain('refund');
    expect(container.textContent).toContain('applyDiscount');
  });

  test('shows a completed update’s result from weft.updates.result.get', async () => {
    const server = fakeServer([entry({ updateId: 'u-1' })]);
    server.answers.set('u-1', { result: { discounted: true } });
    const { findByText } = renderTab(server);

    expect(await findByText(/"discounted":\s*true/)).not.toBeNull();
    expect(server.calls.result).toEqual(['u-1']);
  });

  test('says a completed update’s result is no longer kept once it has been swept', async () => {
    const server = fakeServer([entry({ updateId: 'u-1' })]);
    server.answers.set('u-1', 'swept');
    const { container, findByText } = renderTab(server);

    await findByText(RUN_DETAIL_COPY.updates.resultSwept);
    const row = container.querySelector('[data-update-id="u-1"]');
    expect(row?.getAttribute('data-display')).toBe('swept');
  });

  test('shows a failed update’s stored message, without reading a result', async () => {
    const server = fakeServer([
      entry({ updateId: 'u-1', outcome: 'failed', error: 'insufficient balance' }),
    ]);
    const { container, findByText } = renderTab(server);

    await findByText('insufficient balance');
    expect(container.querySelector('[data-update-id="u-1"]')?.getAttribute('data-display')).toBe(
      'failed',
    );
    expect(server.calls.result).toEqual([]);
  });

  test('shows a pending update on a run that has ended as never answered', async () => {
    const server = fakeServer([pendingEntry({ updateId: 'u-1' })]);
    const { container, findByText, queryByText } = renderTab(server, { status: 'completed' });

    await findByText(RUN_DETAIL_COPY.updates.neverAnswered);
    expect(queryByText(RUN_DETAIL_COPY.updates.awaiting)).toBeNull();
    expect(container.querySelector('[data-update-id="u-1"]')?.getAttribute('data-display')).toBe(
      'never-answered',
    );
  });

  test('shows a pending update on a running run as awaiting its result', async () => {
    const server = fakeServer([pendingEntry({ updateId: 'u-1' })]);
    const { findByText, queryByText } = renderTab(server, { status: 'running' });

    await findByText(RUN_DETAIL_COPY.updates.awaiting);
    expect(queryByText(RUN_DETAIL_COPY.updates.neverAnswered)).toBeNull();
  });

  test('loads older updates with the cursor the last page returned', async () => {
    const server = fakeServer(
      [
        entry({ updateId: 'u-3', name: 'third', receivedAt: 3_000 }),
        entry({ updateId: 'u-2', name: 'second', receivedAt: 2_000 }),
        entry({ updateId: 'u-1', name: 'first', receivedAt: 1_000 }),
      ],
      2,
    );
    server.answers.set('u-3', { result: 3 });
    server.answers.set('u-2', { result: 2 });
    server.answers.set('u-1', { result: 1 });
    const { container, findByText, getByRole, queryByRole } = renderTab(server);

    await findByText('second');
    expect(container.textContent).not.toContain('first');
    await fireEvent.click(getByRole('button', { name: RUN_DETAIL_COPY.updates.loadMore }));

    await findByText('first');
    // The first read, then both pages again: the newest from the start, the next from the cursor it returned.
    expect(server.calls.list).toEqual([{}, {}, { cursor: '0000000000002000:u-2' }]);
    expect(queryByRole('button', { name: RUN_DETAIL_COPY.updates.loadMore })).toBeNull();
    const ids = [...container.querySelectorAll<HTMLElement>('[data-update-id]')].map(
      (row) => row.dataset['updateId'],
    );
    expect(ids).toEqual(['u-3', 'u-2', 'u-1']);
  });

  test('chains the pages by cursor, so sending an update after loading older ones loses none', async () => {
    const server = fakeServer(
      [1, 2, 3, 4, 5].map((n) =>
        entry({ updateId: `u-${n}`, name: `update-${n}`, receivedAt: n * 1_000 }),
      ),
      3,
    );
    for (const n of [1, 2, 3, 4, 5]) server.answers.set(`u-${n}`, { result: n });
    const { container, findByText, getByRole, getByLabelText } = renderTab(server);
    const listed = () =>
      [...container.querySelectorAll<HTMLElement>('[data-update-id]')].map(
        (row) => row.dataset['updateId'],
      );

    await findByText('update-3');
    await fireEvent.click(getByRole('button', { name: RUN_DETAIL_COPY.updates.loadMore }));
    await findByText('update-1');
    expect(listed()).toEqual(['u-5', 'u-4', 'u-3', 'u-2', 'u-1']);

    // One more update shifts the newest page by one; the entry it pushes out must not fall between the
    // newest page and the older one already loaded.
    await fireEvent.input(getByLabelText('Update name'), { target: { value: 'update-6' } });
    await fireEvent.click(getByRole('button', { name: 'Send update' }));

    await waitFor(() => expect(listed()).toEqual(['u-6', 'u-5', 'u-4', 'u-3', 'u-2', 'u-1']));
  });

  test('refreshes a pending update that sits on an older page', async () => {
    jest.useFakeTimers();
    const server = fakeServer(
      [
        entry({ updateId: 'u-1', name: 'update-1', receivedAt: 1_000, outcome: 'pending' }),
        ...[2, 3, 4, 5].map((n) =>
          entry({ updateId: `u-${n}`, name: `update-${n}`, receivedAt: n * 1_000 }),
        ),
      ],
      3,
    );
    delete (server.entries[0] as { completedAt?: number }).completedAt;
    for (const n of [2, 3, 4, 5]) server.answers.set(`u-${n}`, { result: n });
    const { container, findByText, getByRole } = renderTab(server);

    await findByText('update-3');
    await fireEvent.click(getByRole('button', { name: RUN_DETAIL_COPY.updates.loadMore }));
    await findByText(RUN_DETAIL_COPY.updates.awaiting);

    // The handler answers: the entry and the stored result change together, as the server writes them.
    server.entries[0] = entry({ updateId: 'u-1', name: 'update-1', receivedAt: 1_000 });
    server.answers.set('u-1', { result: 'late' });
    jest.advanceTimersByTime(2_000);
    for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();

    await findByText(/late/);
    expect(container.textContent).not.toContain(RUN_DETAIL_COPY.updates.awaiting);
  });

  test('keeps the pages it has, and says why, when loading older updates fails', async () => {
    const server = fakeServer(
      [1, 2, 3, 4].map((n) =>
        entry({ updateId: `u-${n}`, name: `update-${n}`, receivedAt: n * 1_000 }),
      ),
      3,
    );
    for (const n of [1, 2, 3, 4]) server.answers.set(`u-${n}`, { result: n });
    const read = server.client.operations['weft.workflows.updates.list'];
    server.client.operations['weft.workflows.updates.list'] = async (input: {
      cursor?: string;
    }) => {
      if (input.cursor !== undefined) throw new HttpClientError(500, 'Internal server error');
      return read(input);
    };
    const { container, findByText, getByRole } = renderTab(server);

    await findByText('update-4');
    await fireEvent.click(getByRole('button', { name: RUN_DETAIL_COPY.updates.loadMore }));

    const banner = await faultBanner(container);
    expect(banner.textContent).toContain('Internal server error');
    expect(container.textContent).toContain('update-4');
    expect(container.textContent).toContain('update-2');
  });

  test('shows a fault reading the history in the fault banner', async () => {
    const server = fakeServer();
    server.client.operations['weft.workflows.updates.list'] = async () => {
      throw new HttpClientError(500, 'Internal server error');
    };
    const { container } = renderTab(server);

    const alert = await faultBanner(container);
    expect(alert.querySelector('.weft-workflow-detail__fault-banner')).not.toBeNull();
  });
});

describe('UpdatesTab sending', () => {
  test('renders no send form without updates:write, and still lists the history', async () => {
    const server = fakeServer([entry({ updateId: 'u-1', name: 'applyDiscount' })]);
    server.answers.set('u-1', { result: 1 });
    const { findByText, queryByLabelText, queryByRole } = renderTab(server, { canSend: false });

    await findByText('applyDiscount');
    expect(queryByLabelText('Update name')).toBeNull();
    expect(queryByRole('button', { name: 'Send update' })).toBeNull();
  });

  test('sends an update and then lists it, with its result from a fresh read of the history', async () => {
    const server = fakeServer();
    const { getByLabelText, getByRole, findByText } = renderTab(server);

    await fireEvent.input(getByLabelText('Update name'), { target: { value: 'applyDiscount' } });
    await fireEvent.input(getByLabelText('Payload'), { target: { value: '{"code":"SAVE10"}' } });
    await fireEvent.click(getByRole('button', { name: 'Send update' }));

    await findByText(/"code":\s*"SAVE10"/);
    expect(server.calls.submit).toEqual([
      {
        workflowId: 'wf_1',
        updateName: 'applyDiscount',
        payload: { code: 'SAVE10' },
        timeout: 30_000,
      },
    ]);
  });

  test('rejects invalid JSON payloads without calling the client', async () => {
    const server = fakeServer();
    const { getByLabelText, getByRole, getByText } = renderTab(server);

    await fireEvent.input(getByLabelText('Update name'), { target: { value: 'applyDiscount' } });
    await fireEvent.input(getByLabelText('Payload'), { target: { value: '{not json' } });
    await fireEvent.click(getByRole('button', { name: 'Send update' }));

    expect(server.calls.submit).toEqual([]);
    expect(getByText(/Payload must be valid JSON/)).not.toBeNull();
  });

  test('passes a trimmed idempotency key and a custom timeout through to the client', async () => {
    const server = fakeServer();
    const { getByLabelText, getByRole } = renderTab(server);

    await fireEvent.input(getByLabelText('Update name'), { target: { value: 'applyDiscount' } });
    await fireEvent.input(getByLabelText('Idempotency key'), { target: { value: '  key-123  ' } });
    await fireEvent.input(getByLabelText('Timeout (s)'), { target: { value: '5' } });
    await fireEvent.click(getByRole('button', { name: 'Send update' }));

    await waitFor(() =>
      expect(server.calls.submit[0]).toMatchObject({ timeout: 5_000, idempotencyKey: 'key-123' }),
    );
  });

  test('ignores an invalid timeout, leaving the default in effect', async () => {
    const server = fakeServer();
    const { getByLabelText, getByRole } = renderTab(server);

    await fireEvent.input(getByLabelText('Update name'), { target: { value: 'applyDiscount' } });
    await fireEvent.input(getByLabelText('Timeout (s)'), { target: { value: '-5' } });
    await fireEvent.click(getByRole('button', { name: 'Send update' }));

    await waitFor(() => expect(server.calls.submit[0]?.['timeout']).toBe(30_000));
    expect(server.calls.submit[0]).not.toHaveProperty('idempotencyKey');
  });

  test('keeps Send disabled while the name is blank, and while an update is in flight', async () => {
    const server = fakeServer();
    const settle: { resolve: ((value: { updateId: string; result: unknown }) => void) | null } = {
      resolve: null,
    };
    server.submit = () =>
      new Promise<{ updateId: string; result: unknown }>((resolve) => {
        settle.resolve = resolve;
      });
    const { getByLabelText, getByRole } = renderTab(server);

    expect(getByRole('button', { name: 'Send update' }).hasAttribute('disabled')).toBe(true);
    await fireEvent.input(getByLabelText('Update name'), { target: { value: 'applyDiscount' } });
    await fireEvent.click(getByRole('button', { name: 'Send update' }));

    await waitFor(() =>
      expect(getByRole('button', { name: 'Sending…' }).hasAttribute('disabled')).toBe(true),
    );
    settle.resolve?.({ updateId: 'u-1', result: 1 });
    await waitFor(() => expect(getByRole('button', { name: 'Send update' })).not.toBeNull());
  });

  test('shows a refusal before the update was queued in the fault banner', async () => {
    const server = fakeServer();
    server.submit = async () => {
      throw new HttpClientError(422, 'name must be a string', { data: { httpStatus: 422 } });
    };
    const { container, getByLabelText, getByRole } = renderTab(server);

    await fireEvent.input(getByLabelText('Update name'), { target: { value: 'rename' } });
    await fireEvent.click(getByRole('button', { name: 'Send update' }));

    const alert = await faultBanner(container);
    expect(alert.querySelector('.weft-workflow-detail__fault-banner')).not.toBeNull();
    expect(alert.textContent).toContain('name must be a string');
  });

  test('shows the thrown Error message when the client rejects with a non-fault error', async () => {
    const server = fakeServer();
    server.submit = async () => {
      throw new Error('network unreachable');
    };
    const { container, getByLabelText, getByRole } = renderTab(server);

    await fireEvent.input(getByLabelText('Update name'), { target: { value: 'rename' } });
    await fireEvent.click(getByRole('button', { name: 'Send update' }));

    const alert = await faultBanner(container);
    expect(alert.textContent).toContain('network unreachable');
  });

  test('shows a generic message when the client throws a non-Error value', async () => {
    const server = fakeServer();
    server.submit = async () => {
      throw 'boom';
    };
    const { container, getByLabelText, getByRole } = renderTab(server);

    await fireEvent.input(getByLabelText('Update name'), { target: { value: 'rename' } });
    await fireEvent.click(getByRole('button', { name: 'Send update' }));

    const banner = await faultBanner(container);
    expect(banner.textContent).toContain('The update failed.');
  });
});

describe('UpdatesTab timed-out submissions', () => {
  /** Let promise continuations and Svelte's DOM flush run, without advancing the fake clock. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    await tick();
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  }

  test('keeps a timed-out update listed as awaiting, and shows its result once it is answered', async () => {
    jest.useFakeTimers();
    const server = fakeServer();
    server.submit = async (name) => {
      // The request is queued before the wait starts, so the history already lists it.
      server.entries.unshift({
        updateId: 'u-slow',
        name,
        receivedAt: 5_000,
        outcome: 'pending',
      });
      throw new HttpClientError(504, 'Update u-slow timed out after 1000ms', {
        faultCode: 'Timeout',
        data: { updateId: 'u-slow', weftCode: 'Timeout', httpStatus: 504 },
      });
    };
    const { container, getByLabelText, getByRole, findByText, queryByText } = renderTab(server);

    await fireEvent.input(getByLabelText('Update name'), { target: { value: 'slow' } });
    await fireEvent.input(getByLabelText('Timeout (s)'), { target: { value: '1' } });
    await fireEvent.click(getByRole('button', { name: 'Send update' }));

    // The update stays, awaiting; the wait ending is a notice, not a fault.
    await findByText(RUN_DETAIL_COPY.updates.awaiting);
    expect(container.querySelector('[data-update-id="u-slow"]')).not.toBeNull();
    expect(container.textContent).toContain(RUN_DETAIL_COPY.updates.timedOut('slow'));
    expect(container.querySelector('.weft-workflow-detail__fault')).toBeNull();

    // The handler finishes: the answer is stored and the history entry is replaced in one batch.
    server.entries[0] = {
      updateId: 'u-slow',
      name: 'slow',
      receivedAt: 5_000,
      outcome: 'completed',
      completedAt: 6_200,
    };
    server.answers.set('u-slow', { result: 'slow-done' });
    jest.advanceTimersByTime(2_000);
    await settle();

    await findByText(/slow-done/);
    expect(queryByText(RUN_DETAIL_COPY.updates.awaiting)).toBeNull();
  });

  test('polls the history while an update is unanswered, and stops once none is', async () => {
    jest.useFakeTimers();
    const server = fakeServer([pendingEntry({ updateId: 'u-1' })]);
    renderTab(server, { status: 'running' });
    await settle();
    expect(server.calls.list).toHaveLength(1);

    jest.advanceTimersByTime(2_000);
    await settle();
    expect(server.calls.list).toHaveLength(2);

    server.entries[0] = entry({ updateId: 'u-1' });
    server.answers.set('u-1', { result: 1 });
    jest.advanceTimersByTime(2_000);
    await settle();
    const settled = server.calls.list.length;
    jest.advanceTimersByTime(20_000);
    await settle();
    expect(server.calls.list).toHaveLength(settled);
  });

  test('does not poll a run that has ended', async () => {
    jest.useFakeTimers();
    const server = fakeServer([pendingEntry({ updateId: 'u-1' })]);
    renderTab(server, { status: 'cancelled' });
    await settle();

    jest.advanceTimersByTime(20_000);
    await settle();
    expect(server.calls.list).toHaveLength(1);
  });
});
