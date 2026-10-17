/**
 * The command palette searches schedules only when the principal holds
 * `schedules:read`, which `weft.schedules.list` requires; without it the read is
 * skipped rather than sent and answered with a fault.
 */
import type { HttpClient } from '@lostgradient/weft';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import CommandPaletteLauncher from './command-palette.svelte';

function fakeClient(calls: { schedules: number }): HttpClient {
  return {
    list: async () => ({ items: [], total: 0 }),
    listSchedules: async () => {
      calls.schedules += 1;
      return { items: [{ id: 'nightly-rollup', workflowType: 'sweep' }] };
    },
    listReviews: async () => [],
    operations: { 'weft.workers.list': async () => ({ items: [] }) },
  } as unknown as HttpClient;
}

describe('CommandPaletteLauncher schedule search', () => {
  test('searches schedules with schedules:read', async () => {
    const calls = { schedules: 0 };
    const { getByRole, findByText } = render(CommandPaletteLauncher, {
      props: { open: true, client: fakeClient(calls) },
    });

    await fireEvent.input(getByRole('combobox'), { target: { value: 'nightly' } });

    expect(await findByText('nightly-rollup')).not.toBeNull();
    expect(calls.schedules).toBeGreaterThan(0);
  });

  test('skips the schedule read, and lists no schedules, without schedules:read', async () => {
    const calls = { schedules: 0 };
    const { getByRole, queryByText } = render(CommandPaletteLauncher, {
      props: {
        open: true,
        client: fakeClient(calls),
        scheduleReadGate: { disabled: true, title: 'Requires schedules:read' },
      },
    });

    await fireEvent.input(getByRole('combobox'), { target: { value: 'nightly' } });
    // The search is debounced; wait past it before asserting nothing happened.
    await waitFor(() => expect(calls.schedules).toBe(0), { timeout: 600 });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(calls.schedules).toBe(0);
    expect(queryByText('nightly-rollup')).toBeNull();
  });
});
