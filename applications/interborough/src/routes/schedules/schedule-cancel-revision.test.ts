/**
 * Cancelling a schedule sends the revision the operator confirmed, on the list and on one
 * schedule's page. Both pages read the schedule again while a confirmation is open, so a cancel
 * that looked the schedule up when the operator confirmed would send the newest revision, and a
 * version the operator never saw would be canceled instead of being refused as stale.
 *
 * Driven against `installWorkflowWorld`, which refuses a Bureau write whose revision is not the
 * schedule's current one, as the Bureau does.
 */
import type { QueryClient } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { router } from '../../lib/router.svelte.ts';
import {
  codeDefinition,
  emptyWorld,
  installWorkflowWorld,
  scheduleFixture,
  type WorkflowStub,
} from '../../lib/workflow-world.test-support.ts';
import IndexHarness from './index-test-harness.test-harness.svelte';

let stub: WorkflowStub | undefined;

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const SCHEDULE = 'daily-summary';
const CONFIRMED_REVISION = 3;

function open(path: string) {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  stub = installWorkflowWorld(
    emptyWorld({
      definitions: [codeDefinition('agentRun')],
      schedules: [scheduleFixture(SCHEDULE, 'agentRun', { revision: CONFIRMED_REVISION })],
      scheduleAgents: { [SCHEDULE]: 'assistant' },
    }),
  );
  router.navigate(path, { replace: true });
  let queryClient: QueryClient | undefined;
  const view = render(IndexHarness, {
    props: {
      client: stub.client,
      externalBureau: true,
      onQueryClient: (client: QueryClient) => (queryClient = client),
    },
  });
  return { view, refetch: () => queryClient?.invalidateQueries({ queryKey: ['schedules'] }) };
}

/** Another actor changes the schedule, and the page reads it again, while the confirmation is open. */
async function changeAndRefetch(refetch: () => Promise<void> | undefined): Promise<void> {
  const schedule = stub?.world.schedules.find((candidate) => candidate.id === SCHEDULE);
  if (schedule === undefined) throw new Error('expected the seeded schedule');
  schedule.revision = CONFIRMED_REVISION + 1;
  schedule.updatedAt += 1;
  const before = stub?.calls.length ?? 0;
  await refetch();
  // The page did read it again.
  expect(stub?.calls.length ?? 0).toBeGreaterThan(before);
}

describe('cancelling from the list', () => {
  test('sends the revision the operator asked to cancel, not the newest one, and says it is stale', async () => {
    const { view, refetch } = open('/schedules');
    const body = within(view.container.ownerDocument.body);
    await waitFor(() =>
      expect(
        view.container.querySelector<HTMLElement>(`li[data-schedule="${SCHEDULE}"]`)?.dataset[
          'kind'
        ],
      ).toBe('agent-run'),
    );
    await fireEvent.click(body.getByRole('button', { name: /^Actions for / }));
    await fireEvent.click(body.getByRole('menuitem', { name: /Cancel/ }));
    const confirm = await body.findByRole('button', { name: 'Cancel schedule' });

    await changeAndRefetch(refetch);
    await fireEvent.click(confirm);

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.cancel').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.cancel')[0]?.params).toEqual({
      scheduleId: SCHEDULE,
      expectedRevision: CONFIRMED_REVISION,
    });
    // Refused as stale: nothing was canceled.
    await body.findByTestId('schedule-notice');
    expect(stub?.world.schedules[0]?.status).toBe('active');
  });
});

describe('cancelling from one schedule’s page', () => {
  test('sends the revision the operator asked to cancel, not the newest one, and says it is stale', async () => {
    const { view, refetch } = open(`/schedules/${SCHEDULE}`);
    const body = within(view.container.ownerDocument.body);
    await fireEvent.click(await body.findByRole('button', { name: 'More actions' }));
    await fireEvent.click(await body.findByRole('menuitem', { name: /Cancel/ }));
    const confirm = await body.findByRole('button', { name: 'Cancel schedule' });

    await changeAndRefetch(refetch);
    await fireEvent.click(confirm);

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.cancel').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.cancel')[0]?.params).toEqual({
      scheduleId: SCHEDULE,
      expectedRevision: CONFIRMED_REVISION,
    });
    await body.findByTestId('schedule-notice');
    expect(stub?.world.schedules[0]?.status).toBe('active');
  });
});
