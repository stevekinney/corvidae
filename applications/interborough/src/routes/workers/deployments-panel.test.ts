import { QueryClient } from '@tanstack/svelte-query';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { queryKeys } from '../../lib/query.ts';
import type { AuthorizationScope } from '../../lib/scopes.svelte.ts';
import DeploymentsPanel from './deployments-panel.svelte';
import { diagnosticsBody, NOW, routing, version } from './deployments-test-support.test-support.ts';
import TaskEvidenceHarness from './task-evidence-harness.test-harness.svelte';
import {
  parseJsonObject,
  realClient,
  ScriptedFetch,
  type FetchCall,
} from './workers-route-test-support.test-support.ts';

let scripted: ScriptedFetch | undefined;
afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

const VERSIONS = [
  version('build-a', { firstSeenAt: NOW - 300 }),
  version('build-b', { firstSeenAt: NOW - 200 }),
  version('build-c', { firstSeenAt: NOW - 100 }),
];
const POINTER = routing({ currentBuildId: 'build-b', generation: 5 });

function renderPanel(
  principalScopes: readonly AuthorizationScope[] = ['system:read', 'system:admin'],
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const view = render(TaskEvidenceHarness, {
    props: {
      client: realClient(),
      queryClient,
      component: DeploymentsPanel,
      componentProps: { workers: [], now: NOW },
      principalScopes,
    },
  });
  return { ...view, queryClient };
}

/** Routes the overview reads: the unscoped read names the deployment, the named read adds the pointer. */
function routeOverview(script: ScriptedFetch, pointer = POINTER, versions = VERSIONS) {
  script.routeJsonRpcMethodBy('weft.worker.deployments.diagnostics', (params) =>
    diagnosticsBody(versions, params['deploymentName'] === undefined ? null : pointer),
  );
}

/** Every JSON-RPC call made so far, as `[method, params]`. */
function calls(script: ScriptedFetch): [string, Record<string, unknown>][] {
  return script.calls.flatMap((call: FetchCall) => {
    if (typeof call.init?.body !== 'string') return [];
    const body = parseJsonObject(call.init.body);
    const method = body?.['method'];
    const params = body?.['params'];
    return typeof method === 'string'
      ? [[method, typeof params === 'object' && params !== null ? { ...params } : {}]]
      : [];
  });
}

function callsTo(script: ScriptedFetch, method: string) {
  return calls(script).filter(([name]) => name === method);
}

describe('DeploymentsPanel — states', () => {
  test('shows loading, then the deployment with its builds', async () => {
    scripted = new ScriptedFetch();
    const pending = scripted.deferJsonRpcMethod('weft.worker.deployments.diagnostics');
    const view = renderPanel();
    expect(await view.findByRole('status', { name: 'Loading deployments' })).not.toBeNull();
    pending.resolve(diagnosticsBody([], null));
    expect(await view.findByText('No deployment versions')).not.toBeNull();
  });

  test('reads the deployments, then each one by name for its pointer', async () => {
    scripted = new ScriptedFetch();
    routeOverview(scripted);
    const { findByText, getByText } = renderPanel();
    expect(await findByText('build-a')).not.toBeNull();
    expect(getByText('Rollout generation').nextElementSibling?.textContent?.trim()).toBe('5');
    expect(
      callsTo(scripted, 'weft.worker.deployments.diagnostics').map(([, params]) => params),
    ).toEqual([{}, { deploymentName: 'billing' }]);
  });

  test('denied, malformed, and server-fault reads are each explicit', async () => {
    const cases: [(script: ScriptedFetch) => void, string][] = [
      [
        (s) =>
          s.routeJsonRpcMethodError('weft.worker.deployments.diagnostics', 403, 'no', 'Forbidden'),
        'Deployments are locked',
      ],
      [
        (s) => s.routeJsonRpcMethod('weft.worker.deployments.diagnostics', { versions: 'many' }),
        'Malformed server response',
      ],
      [
        (s) =>
          s.routeJsonRpcMethodError(
            'weft.worker.deployments.diagnostics',
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

  test('a failed refresh keeps the last read on screen and says it is stale', async () => {
    scripted = new ScriptedFetch();
    routeOverview(scripted);
    const view = renderPanel();
    expect(await view.findByText('build-a')).not.toBeNull();

    scripted.routeJsonRpcMethodError(
      'weft.worker.deployments.diagnostics',
      503,
      'unavailable',
      'Unavailable',
    );
    await view.queryClient.invalidateQueries({ queryKey: queryKeys.workers.deployments() });
    expect(
      await view.findByText(/Refreshing deployments failed, so this is the last successful read/),
    ).not.toBeNull();
    expect(await view.findByText('build-a')).not.toBeNull();
  });
});

describe('DeploymentsPanel — routing changes', () => {
  test('promote previews first, then applies with the generation the preview reported', async () => {
    scripted = new ScriptedFetch();
    routeOverview(scripted);
    scripted.routeJsonRpcMethod('weft.worker.deployments.preview', {
      valid: true,
      message: 'Routing targets are available.',
      currentGeneration: 5,
    });
    scripted.routeJsonRpcMethod('weft.worker.deployments.promote', {
      deploymentName: 'billing',
      currentBuildId: 'build-c',
      rampBasisPoints: 10_000,
      generation: 6,
      updatedAt: NOW,
    });
    const view = renderPanel();
    await fireEvent.click(await view.findByRole('button', { name: 'Promote' }));

    expect(await view.findByText('Routing targets are available.')).not.toBeNull();
    expect(callsTo(scripted, 'weft.worker.deployments.promote')).toEqual([]);
    const diagnosticsBefore = callsTo(scripted, 'weft.worker.deployments.diagnostics').length;

    await fireEvent.click(await view.findByRole('button', { name: 'Confirm promote build' }));

    await waitFor(() =>
      expect(callsTo(scripted!, 'weft.worker.deployments.promote')).toHaveLength(1),
    );
    expect(callsTo(scripted, 'weft.worker.deployments.preview')[0]?.[1]).toEqual({
      deploymentName: 'billing',
      currentBuildId: 'build-c',
      rampBasisPoints: 10_000,
    });
    expect(callsTo(scripted, 'weft.worker.deployments.promote')[0]?.[1]).toEqual({
      deploymentName: 'billing',
      buildId: 'build-c',
      expectedGeneration: 5,
    });
    // A successful change refetches the deployments.
    await waitFor(() =>
      expect(callsTo(scripted!, 'weft.worker.deployments.diagnostics').length).toBeGreaterThan(
        diagnosticsBefore,
      ),
    );
  });

  test('a stale generation is shown as stale, and a fresh preview is offered', async () => {
    scripted = new ScriptedFetch();
    routeOverview(scripted);
    scripted.routeJsonRpcMethod('weft.worker.deployments.preview', {
      valid: true,
      message: 'ok',
      currentGeneration: 5,
    });
    scripted.routeJsonRpcMethodError(
      'weft.worker.deployments.rollback',
      409,
      'changed',
      'Conflict',
    );
    const view = renderPanel();
    await fireEvent.click(await view.findByRole('button', { name: 'Roll back to' }));
    await fireEvent.click(await view.findByRole('button', { name: 'Confirm roll back to build' }));
    // This Conflict carries no generation, so it is shown as the fault it is, not as stale.
    expect(await view.findByText('changed')).not.toBeNull();
    expect(view.queryByText(/Routing changed since you previewed it/)).toBeNull();
  });

  test('without system:admin the routing actions are disabled', async () => {
    scripted = new ScriptedFetch();
    routeOverview(scripted);
    const view = renderPanel(['system:read']);
    expect(await view.findByText('build-a')).not.toBeNull();
    expect(view.getByRole('button', { name: 'Set routing' }).hasAttribute('disabled')).toBe(true);
    expect(view.queryByRole('button', { name: 'Promote' })).toBeNull();
    expect(callsTo(scripted, 'weft.worker.deployments.preview')).toEqual([]);
  });
});

describe('DeploymentsPanel — drain, resume, and removal', () => {
  test('drains one build with its reason, then resumes it, both scoped to the build', async () => {
    scripted = new ScriptedFetch();
    routeOverview(scripted);
    scripted.routeJsonRpcMethod('weft.worker.deployments.drain', {
      target: 'deployment',
      deploymentName: 'billing',
      buildId: 'build-a',
      affectedWorkers: 1,
      inFlight: 0,
      health: 'drained',
    });
    scripted.routeJsonRpcMethod('weft.worker.deployments.resume', {
      target: 'deployment',
      deploymentName: 'billing',
      buildId: 'build-a',
      affectedWorkers: 1,
      inFlight: 0,
      health: 'active',
    });
    const view = renderPanel();
    await view.findByText('build-a');
    const rowOf = (build: string) =>
      Array.from(view.container.querySelectorAll<HTMLElement>('tbody tr')).find((candidate) =>
        candidate.textContent?.includes(build),
      )!;
    const buttonIn = (row: HTMLElement, name: string) =>
      Array.from(row.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === name,
      )!;

    await fireEvent.click(buttonIn(rowOf('build-a'), 'Drain'));
    await fireEvent.input(await view.findByLabelText('Reason'), { target: { value: 'bad build' } });
    await fireEvent.click(await view.findByRole('button', { name: 'Drain build' }));
    await waitFor(() =>
      expect(callsTo(scripted!, 'weft.worker.deployments.drain')).toHaveLength(1),
    );
    expect(callsTo(scripted, 'weft.worker.deployments.drain')[0]?.[1]).toEqual({
      deploymentName: 'billing',
      buildId: 'build-a',
      reason: 'bad build',
    });

    await fireEvent.click(buttonIn(rowOf('build-a'), 'Resume'));
    await waitFor(() =>
      expect(callsTo(scripted!, 'weft.worker.deployments.resume')).toHaveLength(1),
    );
    expect(callsTo(scripted, 'weft.worker.deployments.resume')[0]?.[1]).toEqual({
      deploymentName: 'billing',
      buildId: 'build-a',
    });
  });

  test('removes a free build after typing its id, and refetches', async () => {
    scripted = new ScriptedFetch();
    routeOverview(scripted);
    scripted.routeJsonRpcMethod('weft.worker.deployments.remove', {
      deploymentName: 'billing',
      buildId: 'build-a',
      removed: true,
    });
    const view = renderPanel();
    await view.findByText('build-a');
    const before = callsTo(scripted, 'weft.worker.deployments.diagnostics').length;
    const row = Array.from(view.container.querySelectorAll<HTMLElement>('tbody tr')).find(
      (candidate) => candidate.textContent?.includes('build-a'),
    )!;
    await fireEvent.click(
      Array.from(row.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Remove',
      )!,
    );

    const confirm = await view.findByRole('button', { name: 'Remove build' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    await fireEvent.input(await view.findByRole('textbox', { name: /Type .*to confirm/i }), {
      target: { value: 'build-a' },
    });
    await fireEvent.click(confirm);

    await waitFor(() =>
      expect(callsTo(scripted!, 'weft.worker.deployments.remove')).toHaveLength(1),
    );
    expect(callsTo(scripted, 'weft.worker.deployments.remove')[0]?.[1]).toEqual({
      deploymentName: 'billing',
      buildId: 'build-a',
    });
    await waitFor(() =>
      expect(callsTo(scripted!, 'weft.worker.deployments.diagnostics').length).toBeGreaterThan(
        before,
      ),
    );
  });

  test('a removal the server refuses because the build became referenced says so, from the fault code', async () => {
    scripted = new ScriptedFetch();
    routeOverview(scripted);
    scripted.routeJsonRpcMethodError(
      'weft.worker.deployments.remove',
      409,
      'Deployment build billing/build-a is still referenced by 1 execution.',
      'Conflict',
      { reason: 'version-referenced' },
    );
    const view = renderPanel();
    await view.findByText('build-a');
    const row = Array.from(view.container.querySelectorAll<HTMLElement>('tbody tr')).find(
      (candidate) => candidate.textContent?.includes('build-a'),
    )!;
    await fireEvent.click(
      Array.from(row.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Remove',
      )!,
    );
    await fireEvent.input(await view.findByRole('textbox', { name: /Type .*to confirm/i }), {
      target: { value: 'build-a' },
    });
    await fireEvent.click(await view.findByRole('button', { name: 'Remove build' }));

    expect(
      await view.findByText(/That build is now referenced by an execution, so it was not removed/),
    ).not.toBeNull();
  });
});

describe('DeploymentsPanel — set routing, failures, and cancellation', () => {
  test('set routing previews the chosen change, then applies it with the previewed generation', async () => {
    scripted = new ScriptedFetch();
    routeOverview(scripted);
    scripted.routeJsonRpcMethod('weft.worker.deployments.preview', {
      valid: true,
      message: 'Routing targets are available.',
      currentGeneration: 5,
    });
    scripted.routeJsonRpcMethod('weft.worker.deployments.setrouting', {
      deploymentName: 'billing',
      currentBuildId: 'build-a',
      rampingBuildId: 'build-c',
      rampBasisPoints: 2_500,
      generation: 6,
      updatedAt: NOW,
    });
    const view = renderPanel();
    await fireEvent.click(await view.findByRole('button', { name: 'Set routing' }));

    await fireEvent.change(await view.findByLabelText('Current build'), {
      target: { value: 'build-a' },
    });
    await fireEvent.change(view.getByLabelText('Ramping build'), { target: { value: 'build-c' } });
    const share = view.getByLabelText('Traffic to the ramping build');
    await fireEvent.input(share, { target: { value: '25' } });
    await fireEvent.blur(share);
    await fireEvent.click(view.getByRole('button', { name: 'Preview change' }));
    await fireEvent.click(await view.findByRole('button', { name: 'Confirm set routing' }));

    await waitFor(() =>
      expect(callsTo(scripted!, 'weft.worker.deployments.setrouting')).toHaveLength(1),
    );
    expect(callsTo(scripted, 'weft.worker.deployments.setrouting')[0]?.[1]).toEqual({
      deploymentName: 'billing',
      currentBuildId: 'build-a',
      rampingBuildId: 'build-c',
      rampBasisPoints: 2_500,
      expectedGeneration: 5,
    });
  });

  test('a failed drain or resume is shown as the fault it is', async () => {
    scripted = new ScriptedFetch();
    routeOverview(scripted);
    scripted.routeJsonRpcMethodError(
      'weft.worker.deployments.resume',
      401,
      'authentication required',
      'Unauthorized',
    );
    const view = renderPanel();
    await view.findByText('build-a');
    const row = Array.from(view.container.querySelectorAll<HTMLElement>('tbody tr')).find(
      (candidate) => candidate.textContent?.includes('build-a'),
    )!;
    await fireEvent.click(
      Array.from(row.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Resume',
      )!,
    );
    expect(await view.findByText('authentication required')).not.toBeNull();
  });

  test('cancelling the routing, drain, and removal dialogs applies nothing', async () => {
    scripted = new ScriptedFetch();
    routeOverview(scripted);
    scripted.routeJsonRpcMethod('weft.worker.deployments.preview', {
      valid: true,
      message: 'ok',
      currentGeneration: 5,
    });
    const view = renderPanel();
    await view.findByText('build-a');
    const buttonIn = (name: string) =>
      Array.from(
        Array.from(view.container.querySelectorAll<HTMLElement>('tbody tr'))
          .find((candidate) => candidate.textContent?.includes('build-a'))!
          .querySelectorAll('button'),
      ).find((button) => button.textContent?.trim() === name)!;

    await fireEvent.click(await view.findByRole('button', { name: 'Set routing' }));
    await fireEvent.click(await view.findByRole('button', { name: 'Cancel' }));
    await fireEvent.click(buttonIn('Drain'));
    await fireEvent.click(await view.findByRole('button', { name: 'Cancel' }));
    await fireEvent.click(buttonIn('Remove'));
    await fireEvent.click(await view.findByRole('button', { name: 'Cancel' }));

    for (const method of [
      'weft.worker.deployments.setrouting',
      'weft.worker.deployments.drain',
      'weft.worker.deployments.remove',
    ]) {
      expect(callsTo(scripted, method)).toEqual([]);
    }
  });
});

describe('DeploymentsPanel — overlapping actions', () => {
  /** Resumes build-a (its call fails once released) and, optionally, build-b before it settles. */
  async function resumeFailingBuildA(alsoResumeB: boolean) {
    scripted = new ScriptedFetch();
    routeOverview(scripted);
    scripted.routeJsonRpcMethod('weft.worker.deployments.resume', {
      target: 'deployment',
      deploymentName: 'api-prod',
      buildId: 'build-b',
      affectedWorkers: 0,
      inFlight: 0,
      health: 'active',
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? parseJsonObject(init.body) : undefined;
      const params = body?.['params'];
      const buildId =
        typeof params === 'object' && params !== null && 'buildId' in params
          ? params.buildId
          : undefined;
      if (body?.['method'] === 'weft.worker.deployments.resume' && buildId === 'build-a') {
        await gate;
        return Response.json({
          jsonrpc: '2.0',
          id: 1,
          error: {
            code: -32000,
            message: 'resume exploded',
            data: { httpStatus: 500, weftCode: 'Internal' },
          },
        });
      }
      return inner(input, init);
    }) as typeof fetch;
    try {
      const view = renderPanel();
      await waitFor(() => expect(view.getAllByRole('button', { name: 'Resume' })).toHaveLength(3));
      const [resumeA, resumeB] = view.getAllByRole('button', { name: 'Resume' });
      await fireEvent.click(resumeA!);
      if (alsoResumeB) await fireEvent.click(resumeB!);
      release?.();
      await waitFor(() =>
        expect(view.queryByText(/resume exploded/)?.textContent ?? '').not.toBe(''),
      );
    } finally {
      globalThis.fetch = inner;
    }
  }

  test('control: a lone failed resume is reported', () => resumeFailingBuildA(false));

  test('a failed resume of one build is still reported when another resume follows it', () =>
    resumeFailingBuildA(true));
});
