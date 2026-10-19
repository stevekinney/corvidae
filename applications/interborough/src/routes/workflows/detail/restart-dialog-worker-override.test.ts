import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import {
  HttpClientError,
  type WorkerStartOverridePreview,
  type WorkflowState,
} from '@lostgradient/weft';
import { QueryClient } from '@tanstack/svelte-query';

import { AUTHORIZATION_SCOPES, type Principal } from '../../../lib/scopes.svelte.ts';
import RestartDialogHarness from './restart-dialog.test-harness.svelte';

const BINDING = {
  workflowId: 'reconcile:installation-42',
  workflowType: 'order-processing',
  deploymentName: 'orders',
  buildId: 'build-1',
  artifactDigest: 'sha256:artifact-1',
  manifestDigest: 'sha256:manifest-1',
  routingGeneration: 3,
  workflowRevision: 'rev-a',
  workflowContractHash: 'wch-1',
  activityContracts: { charge: 'ach-1' },
  activityName: 'charge',
  activityContractHash: 'ach-1',
  boundAt: 1_000,
  checkpointId: 'reconcile:installation-42',
};

const AUTO_UPGRADE = {
  mode: 'auto-upgrade',
  compatibility: {
    deploymentName: 'orders',
    buildId: 'build-2',
    artifactDigest: 'sha256:artifact-2',
    manifestDigest: 'sha256:manifest-2',
    workflowRevision: 'rev-a',
    activityContractHash: 'ach-1',
  },
};

function workflow(fields: Record<string, unknown> = {}): WorkflowState {
  return {
    id: 'reconcile:installation-42',
    type: 'order-processing',
    status: 'completed',
    input: { installationId: 42 },
    versionTuple: { workflowVersion: '1' },
    revision: 'rev-a',
    createdAt: 1_000,
    updatedAt: 2_000,
    ...fields,
  };
}

const autoUpgradeRun = () =>
  workflow({
    workerVersioningPolicy: AUTO_UPGRADE,
    workerBinding: { current: BINDING, history: [] },
  });

function principal(scopes: Principal['scopes'] = AUTHORIZATION_SCOPES): Principal {
  return { scopes, unauthenticatedAccess: null };
}

function preview(overrides: Partial<WorkerStartOverridePreview> = {}): WorkerStartOverridePreview {
  return {
    token: 'signed-token-1',
    scope: 'destructive:workflow-worker-version-binding',
    workflowId: 'reconcile:installation-42',
    previousRoutingGeneration: 3,
    targetRoutingGeneration: 4,
    targetWorkflowContractHash: 'wch-2',
    targetActivityContractsDigest: 'digest-2',
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function conflict(reason: string): HttpClientError {
  return new HttpClientError(409, 'server text', { faultCode: 'Conflict', data: { reason } });
}

interface Fakes {
  previewCalls: { workflowId: string }[];
  spendCalls: Record<string, unknown>[];
  plainCalls: number;
}

function fakeClient(
  options: {
    previews?: (() => Promise<{ preview: WorkerStartOverridePreview }>)[];
    spend?: () => Promise<{ id: string; outcome: 'started' | 'signalled' }>;
  } = {},
) {
  const fakes: Fakes = { previewCalls: [], spendCalls: [], plainCalls: 0 };
  const queue = [...(options.previews ?? [async () => ({ preview: preview() })])];
  const client = {
    startOrSignal: async () => {
      fakes.plainCalls += 1;
      return { id: 'reconcile:installation-42', outcome: 'started' as const };
    },
    operations: {
      'weft.workflows.active.get': async () => null,
      'weft.worker.startoverrides.preview': async (input: { workflowId: string }) => {
        fakes.previewCalls.push(input);
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next === undefined) throw new Error('no scripted preview');
        return next();
      },
      'weft.workflows.startorsignal': async (input: Record<string, unknown>) => {
        fakes.spendCalls.push(input);
        return (
          options.spend ??
          (async () => ({ id: 'reconcile:installation-42', outcome: 'started' as const }))
        )();
      },
    },
  };
  return { client, fakes };
}

function renderDialog(
  run: WorkflowState,
  client: ReturnType<typeof fakeClient>['client'],
  scopes: Principal['scopes'] = AUTHORIZATION_SCOPES,
  onRestarted: () => void = () => {},
) {
  return render(RestartDialogHarness, {
    props: {
      client,
      workflow: run,
      principal: principal(scopes),
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      onRestarted,
    },
  });
}

async function enterSignal(view: ReturnType<typeof renderDialog>) {
  await fireEvent.input(view.getByLabelText('Signal name'), { target: { value: 'resync' } });
}

describe('RestartDialog worker binding', () => {
  test('a run with no worker binding shows no worker section', () => {
    const { client } = fakeClient();
    const view = renderDialog(workflow(), client);
    expect(view.queryByTestId('restart-worker-override')).toBeNull();
  });

  test('a pinned run says why it cannot be overridden, states the restart rule, and offers no preview', () => {
    const { client } = fakeClient();
    const view = renderDialog(
      workflow({
        workerVersioningPolicy: { mode: 'pinned' },
        workerBinding: { current: BINDING, history: [] },
      }),
      client,
    );
    expect(view.getByTestId('restart-override-reason').textContent).toContain(
      'cannot be overridden',
    );
    expect(view.getByText('Worker binding for a restart or retry')).not.toBeNull();
    expect(view.queryByRole('button', { name: 'Preview worker upgrade' })).toBeNull();
  });

  test('a malformed binding explains that no override can be offered', () => {
    const { client } = fakeClient();
    const view = renderDialog(workflow({ workerVersioningPolicy: { mode: 'pinned' } }), client);
    expect(view.getByTestId('restart-override-reason').textContent).toContain('could not be read');
    expect(view.queryByRole('button', { name: 'Preview worker upgrade' })).toBeNull();
  });

  test('without system:admin the preview action is disabled and says why', () => {
    const { client, fakes } = fakeClient();
    const view = renderDialog(autoUpgradeRun(), client, ['workflows:write', 'signals:write']);
    const button = view.getByRole('button', { name: 'Preview worker upgrade' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(view.getByText(/needs the system:admin scope/)).not.toBeNull();
    expect(fakes.previewCalls).toHaveLength(0);
  });

  test('previewing shows what changes, and an unconfirmed preview restarts on the inherited build without the token', async () => {
    const { client, fakes } = fakeClient();
    let restarted = 0;
    const view = renderDialog(autoUpgradeRun(), client, undefined, () => (restarted += 1));

    await fireEvent.click(view.getByRole('button', { name: 'Preview worker upgrade' }));
    await waitFor(() => expect(view.getByText('3 → 4')).not.toBeNull());
    expect(fakes.previewCalls).toEqual([{ workflowId: 'reconcile:installation-42' }]);

    await enterSignal(view);
    await fireEvent.click(view.getByRole('button', { name: 'Restart workflow' }));
    await waitFor(() => expect(restarted).toBe(1));
    expect(fakes.plainCalls).toBe(1);
    expect(fakes.spendCalls).toHaveLength(0);
  });

  test('a confirmed preview is spent on the restart through the typed operation', async () => {
    const { client, fakes } = fakeClient();
    let restarted = 0;
    const view = renderDialog(autoUpgradeRun(), client, undefined, () => (restarted += 1));

    await fireEvent.click(view.getByRole('button', { name: 'Preview worker upgrade' }));
    await waitFor(() => expect(view.getByText('3 → 4')).not.toBeNull());
    await fireEvent.click(view.getByLabelText(/Restart on the build routing selects now/));
    await enterSignal(view);
    await fireEvent.click(view.getByRole('button', { name: 'Restart workflow' }));

    await waitFor(() => expect(restarted).toBe(1));
    expect(fakes.plainCalls).toBe(0);
    expect(fakes.spendCalls).toHaveLength(1);
    const call = fakes.spendCalls[0]!;
    expect(call['workerStartOverridePreview']).toEqual(
      preview({ expiresAt: expect.any(Number) as never }),
    );
    expect(call['onTerminalConflict']).toBe('start-new');
    expect(call['id']).toBe('reconcile:installation-42');
    expect(call['signalName']).toBe('resync');
  });

  test('a token the server refuses drops the preview and asks for a new one, without restarting', async () => {
    const { client, fakes } = fakeClient({
      previews: [
        async () => ({ preview: preview({ token: 'first' }) }),
        async () => ({ preview: preview({ token: 'second', targetRoutingGeneration: 5 }) }),
      ],
      spend: async () => {
        throw conflict('override-token-rejected');
      },
    });
    let restarted = 0;
    const view = renderDialog(autoUpgradeRun(), client, undefined, () => (restarted += 1));

    await fireEvent.click(view.getByRole('button', { name: 'Preview worker upgrade' }));
    await waitFor(() => expect(view.getByText('3 → 4')).not.toBeNull());
    await fireEvent.click(view.getByLabelText(/Restart on the build routing selects now/));
    await enterSignal(view);
    await fireEvent.click(view.getByRole('button', { name: 'Restart workflow' }));

    await waitFor(() =>
      expect(view.getByText(/The start refused the override preview/)).not.toBeNull(),
    );
    expect(restarted).toBe(0);
    expect(view.queryByText('3 → 4')).toBeNull();
    expect(view.queryByLabelText(/Restart on the build routing selects now/)).toBeNull();

    await fireEvent.click(view.getByRole('button', { name: 'Preview worker upgrade' }));
    await waitFor(() => expect(view.getByText('3 → 5')).not.toBeNull());
    await waitFor(() =>
      expect(view.queryByText(/The start refused the override preview/)).toBeNull(),
    );
    expect(fakes.previewCalls).toHaveLength(2);
  });

  test.each([
    ['no-routed-deployment', /No ready, routed deployment/],
    ['upgrade-incompatible-contract', /incompatible-contract/],
    ['workflow-not-terminal', /not terminal/],
  ])('a %s refusal from the preview is explained', async (reason, expected) => {
    const { client } = fakeClient({
      previews: [
        async () => {
          throw conflict(reason);
        },
      ],
    });
    const view = renderDialog(autoUpgradeRun(), client);
    await fireEvent.click(view.getByRole('button', { name: 'Preview worker upgrade' }));
    await waitFor(() => expect(view.getByRole('alert').textContent).toMatch(expected));
  });

  test('a server without a signing key says previews are unavailable', async () => {
    const { client } = fakeClient({
      previews: [
        async () => {
          throw new HttpClientError(501, 'x', { faultCode: 'UnsupportedCapability' });
        },
      ],
    });
    const view = renderDialog(autoUpgradeRun(), client);
    await fireEvent.click(view.getByRole('button', { name: 'Preview worker upgrade' }));
    await waitFor(() => expect(view.getByRole('alert').textContent).toMatch(/signing key/));
  });

  test('an expired preview cannot be confirmed', async () => {
    const { client, fakes } = fakeClient({
      previews: [async () => ({ preview: preview({ expiresAt: Date.now() - 1 }) })],
    });
    const view = renderDialog(autoUpgradeRun(), client);
    await fireEvent.click(view.getByRole('button', { name: 'Preview worker upgrade' }));
    await waitFor(() => expect(view.getByText(/This preview has expired/)).not.toBeNull());
    expect(view.queryByLabelText(/Restart on the build routing selects now/)).toBeNull();
    await enterSignal(view);
    await fireEvent.click(view.getByRole('button', { name: 'Restart workflow' }));
    await waitFor(() => expect(fakes.plainCalls).toBe(1));
    expect(fakes.spendCalls).toHaveLength(0);
  });
});
