/**
 * Component tests for `<MetricsTab>` (plan §9.7 T7.2). Covers the
 * Dashboard/Raw toggle, stat rendering from a polled snapshot, and the raw
 * Prometheus text view including its fault path.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, jest, mock, test } from 'bun:test';

import { settle, until } from '../../lib/fake-timers.test-support.ts';
import { createQueryClient } from '../../lib/query.ts';
import MetricsTab from './metrics-tab.svelte';
import SystemRouteTestHarness from './system-route-test-harness.test-harness.svelte';
import { realClient, ScriptedFetch } from './system-test-support.test-support.ts';

let scripted: ScriptedFetch | undefined;

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

async function renderMetricsTab() {
  return render(SystemRouteTestHarness, {
    props: { client: realClient(), queryClient: createQueryClient(), component: MetricsTab },
  });
}

describe('MetricsTab', () => {
  test('dashboard view renders stats from the first poll', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.system.metrics', {
      'weft.workflow.active': { type: 'gauge', value: 7 },
      'weft.workflow.completed': { type: 'counter', value: 42 },
      'weft.workflow.failed': { type: 'counter', value: 1 },
    });

    const { findAllByText, findByText } = await renderMetricsTab();

    const activeWorkflowsMatches = await findAllByText('Active workflows');
    expect(activeWorkflowsMatches.length).toBeGreaterThan(0);
    expect(await findByText('7')).not.toBeNull();
    expect(await findByText('42')).not.toBeNull();
  });

  test('switching to Raw fetches and renders the Prometheus text', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.system.metrics', {});
    scripted.routeUrlText('/v1/metrics', 'weft_workflow_active 7\n');

    const { findByRole, findByText } = await renderMetricsTab();

    await fireEvent.click(await findByRole('radio', { name: 'Raw' }));

    expect(await findByText('weft_workflow_active 7')).not.toBeNull();
  });

  test('Raw view shows the fault banner on a failed fetch', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.system.metrics', {});
    scripted.routeUrlStatus('/v1/metrics', 500, 'Internal Server Error');

    const { findByRole, findByText } = await renderMetricsTab();

    await fireEvent.click(await findByRole('radio', { name: 'Raw' }));

    expect(await findByText('Something went wrong')).not.toBeNull();
  });

  test('clicking Download in the Raw view saves the Prometheus text as a Blob', async () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = mock((_blob: Blob) => 'blob:mock-url');
    const revokeObjectURL = mock((_url: string) => undefined);
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;

    const click = mock(() => undefined);
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = click;

    try {
      scripted = new ScriptedFetch();
      scripted.routeJsonRpcMethod('weft.system.metrics', {});
      scripted.routeUrlText('/v1/metrics', 'weft_workflow_active 7\n');

      const { findByRole, findByText } = await renderMetricsTab();

      await fireEvent.click(await findByRole('radio', { name: 'Raw' }));
      // Wait for the raw text to actually land — the Download button stays
      // `disabled` (`!$rawQuery.data`) until then.
      expect(await findByText('weft_workflow_active 7')).not.toBeNull();
      await fireEvent.click(await findByRole('button', { name: 'Download' }));

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const [blob] = createObjectURL.mock.calls[0] ?? [];
      expect(blob?.type.startsWith('text/plain')).toBe(true);
      expect(click).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
      HTMLAnchorElement.prototype.click = originalClick;
    }
  });

  test('stops claiming it is updated every 15s once the polls have failed five times in a row', async () => {
    // `PollingSource` closes after `MAX_CONSECUTIVE_FAILURES` (5) failed polls, 15s apart, and then
    // its status is no longer `polling`: the indicator loses its "Updated every 15s" label. The
    // clock is faked, so the five polls take no real time.
    jest.useFakeTimers();
    try {
      scripted = new ScriptedFetch();
      scripted.routeJsonRpcError('weft.system.metrics', { code: -32000, message: 'Unavailable' });

      const { queryByText } = await renderMetricsTab();
      await until(() => expect(scripted?.calls.length).toBe(1));
      // The failure is handled, and the next poll scheduled, a few turns after the request is made.
      await settle();
      expect(queryByText('Updated every 15s')).not.toBeNull();

      for (let poll = 2; poll <= 5; poll += 1) {
        jest.advanceTimersByTime(15_000);
        await until(() => expect(scripted?.calls.length).toBe(poll));
        await settle();
      }
      await until(() => expect(queryByText('Updated every 15s')).toBeNull());
    } finally {
      jest.useRealTimers();
    }
  });
});
