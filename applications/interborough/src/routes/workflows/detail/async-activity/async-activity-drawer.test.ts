import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { type HttpClient, HttpClientError } from '@lostgradient/weft';

import AsyncActivityDrawerHarness from './async-activity-drawer.test-harness.svelte';
import type { AttachedPendingActivity } from './async-activity-matching.ts';

function activity(overrides: Partial<AttachedPendingActivity> = {}): AttachedPendingActivity {
  return {
    token: 'async-act:v1:wf-1:0:1',
    operationId: 'op-1',
    activityName: 'printShippingLabel',
    attempt: 1,
    observedAt: 1_000,
    stepId: 'step-1',
    ...overrides,
  };
}

type ActivityOperations = Pick<
  HttpClient['operations'],
  'weft.activities.complete' | 'weft.activities.fail'
>;

function activityClient(overrides: Partial<ActivityOperations> = {}) {
  const acknowledge = async () => ({ ok: true as const });
  return {
    operations: {
      'weft.activities.complete': acknowledge,
      'weft.activities.fail': acknowledge,
      ...overrides,
    },
  };
}

describe('AsyncActivityDrawer', () => {
  test('shows the token and the "not a secret" label', async () => {
    const client = activityClient();
    const { getByText } = render(AsyncActivityDrawerHarness, {
      props: { client, open: true, activity: activity(), onClose: () => {}, onResolved: () => {} },
    });

    expect(getByText('async-act:v1:wf-1:0:1')).not.toBeNull();
    expect(getByText(/deterministic identifier, not a secret/)).not.toBeNull();
  });

  test('completing calls the generated operation with the parsed JSON result and fires onResolved', async () => {
    const received: unknown[] = [];
    const client = activityClient({
      'weft.activities.complete': async (input) => {
        received.push(input);
        return { ok: true };
      },
    });
    const resolved: { token: string | null } = { token: null };

    const { getByLabelText, getByRole } = render(AsyncActivityDrawerHarness, {
      props: {
        client,
        open: true,
        activity: activity(),
        onClose: () => {},
        onResolved: (token: string) => {
          resolved.token = token;
        },
      },
    });

    await fireEvent.input(getByLabelText(/Result/), { target: { value: '{"printed":true}' } });
    await fireEvent.click(getByRole('button', { name: 'Complete activity' }));

    await waitFor(() => {
      expect(received).toEqual([{ token: 'async-act:v1:wf-1:0:1', result: { printed: true } }]);
    });
    expect(resolved.token).toBe('async-act:v1:wf-1:0:1');
  });

  test('failing calls the generated operation with the plain-text error message', async () => {
    const received: unknown[] = [];
    const client = activityClient({
      'weft.activities.fail': async (input) => {
        received.push(input);
        return { ok: true };
      },
    });

    const { getByLabelText, getByRole } = render(AsyncActivityDrawerHarness, {
      props: { client, open: true, activity: activity(), onClose: () => {}, onResolved: () => {} },
    });

    await fireEvent.click(getByRole('radio', { name: 'Fail' }));
    await fireEvent.input(getByLabelText('Error message'), {
      target: { value: 'printer offline' },
    });
    await fireEvent.click(getByRole('button', { name: 'Fail activity' }));

    await waitFor(() => {
      expect(received).toEqual([
        { token: 'async-act:v1:wf-1:0:1', error: { message: 'printer offline' } },
      ]);
    });
  });

  test('a late acknowledgement settles the submitted token after the drawer switches', async () => {
    const sent: unknown[] = [];
    const settled: string[] = [];
    const { promise: result, resolve: acknowledge } = Promise.withResolvers<{ ok: true }>();
    const client = activityClient({
      'weft.activities.complete': (input) => {
        sent.push(input);
        return result;
      },
    });
    const props = {
      client,
      open: true,
      activity: activity(),
      onClose: () => {},
      onResolved: (token: string) => settled.push(token),
    };
    const view = render(AsyncActivityDrawerHarness, { props });
    await fireEvent.click(view.getByRole('button', { name: 'Complete activity' }));
    await waitFor(() => expect(sent).toEqual([{ token: props.activity.token }]));
    await view.rerender({ ...props, activity: activity({ token: 'async-act:v1:wf-1:0:2' }) });
    acknowledge({ ok: true });
    await waitFor(() => expect(settled).toEqual([props.activity.token]));
  });

  test('a NotFound fault shows the spent-token treatment and hides the form', async () => {
    const client = activityClient({
      'weft.activities.complete': async () => {
        throw new HttpClientError(404, 'token not found or already used');
      },
    });

    const { getByRole, getByText, queryByRole } = render(AsyncActivityDrawerHarness, {
      props: { client, open: true, activity: activity(), onClose: () => {}, onResolved: () => {} },
    });

    await fireEvent.click(getByRole('button', { name: 'Complete activity' }));

    await waitFor(() => {
      expect(getByText('This token has been used.')).not.toBeNull();
    });
    expect(queryByRole('button', { name: 'Complete activity' })).toBeNull();
  });

  test('rejects invalid JSON in complete mode without calling the client', async () => {
    let called = false;
    const client = activityClient({
      'weft.activities.complete': async () => {
        called = true;
        return { ok: true };
      },
    });

    const { getByLabelText, getByRole, getByText } = render(AsyncActivityDrawerHarness, {
      props: { client, open: true, activity: activity(), onClose: () => {}, onResolved: () => {} },
    });

    await fireEvent.input(getByLabelText(/Result/), { target: { value: '{not json' } });
    await fireEvent.click(getByRole('button', { name: 'Complete activity' }));

    expect(called).toBe(false);
    expect(getByText(/Result must be valid JSON/)).not.toBeNull();
  });
});
