import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { QueryClient } from '@tanstack/svelte-query';
import type { AuthorizationScope } from '../../lib/scopes.svelte.ts';
import ConformancePanel from './conformance-panel.svelte';
import TaskEvidenceHarness from './task-evidence-harness.test-harness.svelte';
import {
  parseJsonObject,
  realClient,
  ScriptedFetch,
} from './workers-route-test-support.test-support.ts';

let scripted: ScriptedFetch | undefined;
afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

const NOW = 1_700_000_000_000;

const TARGETS = { targets: [{ name: 'bun-worker', timeoutMs: 5_000 }] };
const REPORT = {
  target: 'bun-worker',
  startedAt: NOW,
  completedAt: NOW + 4_000,
  ok: false,
  protocolVersion: 8,
  supportedProtocolVersions: [7, 8],
  checks: [
    { name: 'register', ok: true, message: 'registered and acknowledged' },
    { name: 'heartbeat', ok: false, message: 'no heartbeat within 5s' },
  ],
};

function renderPanel(
  principalScopes: readonly AuthorizationScope[] = ['system:read', 'system:admin'],
) {
  return render(TaskEvidenceHarness, {
    props: {
      client: realClient(),
      // A plain client: the app's default mutation handler raises a toast, which needs a mounted ToastHost.
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      component: ConformancePanel,
      componentProps: { now: NOW + 10_000 },
      principalScopes,
    },
  });
}

function reportCalls(script: ScriptedFetch): string[] {
  return script.calls.flatMap((call) => {
    if (typeof call.init?.body !== 'string') return [];
    const body = parseJsonObject(call.init.body);
    if (body?.['method'] !== 'weft.conformance.report') return [];
    const params = body['params'];
    return typeof params === 'object' && params !== null && 'target' in params
      ? [String(params.target)]
      : [];
  });
}

describe('ConformancePanel', () => {
  test('lists the registered targets and runs one on request, showing each check in words', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.conformance.targets', TARGETS);
    scripted.routeJsonRpcMethod('weft.conformance.report', REPORT);
    const { findByText, getByRole, getByText } = renderPanel();

    expect(await findByText('bun-worker')).not.toBeNull();
    expect(reportCalls(scripted)).toEqual([]);

    await fireEvent.click(getByRole('button', { name: 'Run conformance' }));

    expect(await findByText('Not conformant')).not.toBeNull();
    expect(getByText('1 passed · 1 failed')).not.toBeNull();
    expect(getByText('registered and acknowledged')).not.toBeNull();
    expect(getByText('no heartbeat within 5s')).not.toBeNull();
    expect(getByText('Pass')).not.toBeNull();
    expect(getByText('Fail')).not.toBeNull();
    expect(getByText('8 (server supports 7, 8)')).not.toBeNull();
    expect(reportCalls(scripted)).toEqual(['bun-worker']);
    expect(getByRole('button', { name: 'Run again' })).not.toBeNull();
  });

  test('without system:admin the run control is disabled, with the reason, and nothing runs', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.conformance.targets', TARGETS);
    const { findByText, getByRole } = renderPanel(['system:read']);

    expect(await findByText('bun-worker')).not.toBeNull();
    expect(getByRole('button', { name: 'Run conformance' }).hasAttribute('disabled')).toBe(true);
    expect(await findByText(/to run a target, because a run starts a process/)).not.toBeNull();
    expect(reportCalls(scripted)).toEqual([]);
  });

  test('a server that registers no targets says so', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.conformance.targets', { targets: [] });
    const { findByText } = renderPanel();
    expect(await findByText('No conformance targets')).not.toBeNull();
    expect(await findByText(/serve\(\{ conformanceTargets \}\)/)).not.toBeNull();
  });

  test('loading, denied, malformed, and server-fault states of the target list are explicit', async () => {
    scripted = new ScriptedFetch();
    const pending = scripted.deferJsonRpcMethod('weft.conformance.targets');
    const loading = renderPanel();
    expect(
      await loading.findByRole('status', { name: 'Loading conformance targets' }),
    ).not.toBeNull();
    pending.resolve({ targets: [] });
    scripted.restore();

    const cases: [(script: ScriptedFetch) => void, string][] = [
      [
        (s) => s.routeJsonRpcMethodError('weft.conformance.targets', 403, 'no', 'Forbidden'),
        'Conformance is locked',
      ],
      [
        (s) => s.routeJsonRpcMethod('weft.conformance.targets', { targets: 'many' }),
        'Malformed server response',
      ],
      [
        (s) =>
          s.routeJsonRpcMethodError(
            'weft.conformance.targets',
            401,
            'authentication required',
            'Unauthorized',
          ),
        'Not authorized',
      ],
    ];
    for (const [route, title] of cases) {
      scripted = new ScriptedFetch();
      route(scripted);
      const view = renderPanel();
      expect(await view.findByText(title)).not.toBeNull();
      view.unmount();
      scripted.restore();
    }
    scripted = undefined;
  });

  test('a target removed since the list was read is named, and a run failure is explicit', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.conformance.targets', TARGETS);
    scripted.routeJsonRpcMethodError('weft.conformance.report', 404, 'gone', 'NotFound');
    const gone = renderPanel();
    await fireEvent.click(await gone.findByRole('button', { name: 'Run conformance' }));
    expect(await gone.findByText('Target no longer registered')).not.toBeNull();
    gone.unmount();
    scripted.restore();

    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.conformance.targets', TARGETS);
    scripted.routeJsonRpcMethodError('weft.conformance.report', 403, 'no', 'Forbidden');
    const denied = renderPanel();
    await fireEvent.click(await denied.findByRole('button', { name: 'Run conformance' }));
    expect(await denied.findByText('Running conformance is locked')).not.toBeNull();
    denied.unmount();
    scripted.restore();

    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.conformance.targets', TARGETS);
    scripted.routeJsonRpcMethod('weft.conformance.report', { target: 'bun-worker' });
    const malformed = renderPanel();
    await fireEvent.click(await malformed.findByRole('button', { name: 'Run conformance' }));
    expect(await malformed.findByText('Malformed server response')).not.toBeNull();
    malformed.unmount();
    scripted.restore();

    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.conformance.targets', TARGETS);
    scripted.routeJsonRpcMethodError(
      'weft.conformance.report',
      401,
      'authentication required',
      'Unauthorized',
    );
    const fault = renderPanel();
    await fireEvent.click(await fault.findByRole('button', { name: 'Run conformance' }));
    expect(await fault.findByText('Not authorized')).not.toBeNull();
  });

  test('a run in progress shows a loading status and cannot be started twice', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.conformance.targets', TARGETS);
    const pending = scripted.deferJsonRpcMethod('weft.conformance.report');
    const { findByRole, getByRole } = renderPanel();
    await fireEvent.click(await findByRole('button', { name: 'Run conformance' }));
    expect(
      await findByRole('status', { name: 'Running conformance for bun-worker' }),
    ).not.toBeNull();
    await waitFor(() =>
      expect(getByRole('button', { name: 'Run conformance' }).hasAttribute('disabled')).toBe(true),
    );
    pending.resolve(REPORT);
  });

  test('a failed refresh keeps the last target list on screen and says it is stale', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.conformance.targets', TARGETS);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { findByText } = render(TaskEvidenceHarness, {
      props: {
        client: realClient(),
        queryClient,
        component: ConformancePanel,
        componentProps: { now: NOW },
        principalScopes: ['system:read', 'system:admin'],
      },
    });
    expect(await findByText('bun-worker')).not.toBeNull();

    scripted.routeJsonRpcMethodError('weft.conformance.targets', 503, 'unavailable', 'Unavailable');
    await queryClient.invalidateQueries({ queryKey: ['conformance', 'targets'] });

    expect(await findByText(/Refreshing the target list failed/)).not.toBeNull();
    expect(await findByText('bun-worker')).not.toBeNull();
  });

  test('running a second target while the first is in flight settles both, not just the latest', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.conformance.targets', {
      targets: [
        { name: 'target-a', timeoutMs: 5_000 },
        { name: 'target-b', timeoutMs: 5_000 },
      ],
    });
    const pending = scripted.deferJsonRpcMethod('weft.conformance.report');
    const view = renderPanel();
    expect(await view.findByText('target-a')).not.toBeNull();
    const [runA, runB] = view.getAllByRole('button', { name: 'Run conformance' });
    await fireEvent.click(runA!);
    await fireEvent.click(runB!);
    pending.resolve({
      ...REPORT,
      ok: true,
      checks: [{ name: 'register', ok: true, message: 'ok' }],
    });

    // Both runs answered: neither target may still read as running, and both offer another run.
    await waitFor(() => {
      expect(view.getAllByRole('button', { name: 'Run again' })).toHaveLength(2);
    });
    for (const target of ['target-a', 'target-b']) {
      const running = view.queryByRole('status', { name: `Running conformance for ${target}` });
      expect(running?.outerHTML ?? null).toBeNull();
    }
  });
});
