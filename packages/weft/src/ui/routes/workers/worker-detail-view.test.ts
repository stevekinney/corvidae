import { describe, expect, test } from 'bun:test';

import { fireEvent, render, within } from '@testing-library/svelte';

import { HttpClientError } from '@lostgradient/weft';

import type { ScopeGate } from '../../lib/scopes.svelte.ts';
import type { WorkerSummary } from './worker-catalog-types.ts';
import WorkerDetailView from './worker-detail-view.svelte';
import {
  MalformedWorkerDiagnosticsError,
  type WorkerManifestDiagnostics,
} from './worker-manifest-diagnostics.ts';

function worker(overrides: Partial<WorkerSummary> = {}): WorkerSummary {
  return {
    id: 'wkr_1',
    transport: 'websocket',
    queue: 'default',
    activities: ['Workflow.activity'],
    concurrency: 4,
    inFlight: 1,
    availableCapacity: 3,
    connectedAt: 0,
    lastHeartbeatAt: 0,
    startedAt: 0,
    heartbeatAgeMs: 1_000,
    capabilities: {},
    health: 'active',
    ...overrides,
  };
}

const OPEN_GATE: ScopeGate = { disabled: false, title: undefined };
const DISABLED_GATE: ScopeGate = { disabled: true, title: 'Requires system:admin' };

describe('WorkerDetailView — health badge and drain banner', () => {
  test('an active worker shows Healthy or Stale (heartbeat-derived), no drain banner', () => {
    const { getByText, queryByText } = render(WorkerDetailView, {
      props: {
        worker: worker({ health: 'active', heartbeatAgeMs: 1_000 }),
        adminGate: OPEN_GATE,
        onDrain: () => {},
        onResume: () => {},
      },
    });

    expect(getByText('Healthy')).not.toBeNull();
    expect(queryByText(/Draining —/)).toBeNull();
  });

  test('a draining worker shows the Draining badge and the warning callout with in-flight count', () => {
    const { getByText } = render(WorkerDetailView, {
      props: {
        worker: worker({ health: 'draining', inFlight: 3 }),
        adminGate: OPEN_GATE,
        onDrain: () => {},
        onResume: () => {},
      },
    });

    expect(getByText('Draining')).not.toBeNull();
    expect(
      getByText(/Draining — finishing 3 in-flight tasks, accepting no new work\./),
    ).not.toBeNull();
  });

  test('a draining worker with exactly one in-flight task uses the singular "task" noun', () => {
    const { getByText } = render(WorkerDetailView, {
      props: {
        worker: worker({ health: 'draining', inFlight: 1 }),
        adminGate: OPEN_GATE,
        onDrain: () => {},
        onResume: () => {},
      },
    });

    expect(
      getByText(/Draining — finishing 1 in-flight task, accepting no new work\./),
    ).not.toBeNull();
  });

  test('a drained worker shows the Drained badge', () => {
    const { getByText } = render(WorkerDetailView, {
      props: {
        worker: worker({ health: 'drained' }),
        adminGate: OPEN_GATE,
        onDrain: () => {},
        onResume: () => {},
      },
    });

    expect(getByText('Drained')).not.toBeNull();
  });

  test('an active worker with a stale heartbeat is promoted to the Stale badge', () => {
    const { getByText } = render(WorkerDetailView, {
      props: {
        worker: worker({ health: 'active', heartbeatAgeMs: 200_000 }),
        adminGate: OPEN_GATE,
        onDrain: () => {},
        onResume: () => {},
      },
    });

    expect(getByText('Stale')).not.toBeNull();
  });
});

describe('WorkerDetailView — drain/resume action', () => {
  test('an active worker shows a Drain button that calls onDrain when the gate is open', async () => {
    let drained = false;
    const { getByText } = render(WorkerDetailView, {
      props: {
        worker: worker({ health: 'active' }),
        adminGate: OPEN_GATE,
        onDrain: () => {
          drained = true;
        },
        onResume: () => {
          throw new Error('must not be called');
        },
      },
    });

    await fireEvent.click(getByText('Drain'));
    expect(drained).toBe(true);
  });

  test('a draining worker shows a Resume button that calls onResume when the gate is open', async () => {
    let resumed = false;
    const { getByText } = render(WorkerDetailView, {
      props: {
        worker: worker({ health: 'draining' }),
        adminGate: OPEN_GATE,
        onDrain: () => {
          throw new Error('must not be called');
        },
        onResume: () => {
          resumed = true;
        },
      },
    });

    await fireEvent.click(getByText('Resume'));
    expect(resumed).toBe(true);
  });

  test('when the admin gate is disabled, the button is disabled and labeled per health (Drain for active)', () => {
    const { getByText } = render(WorkerDetailView, {
      props: {
        worker: worker({ health: 'active' }),
        adminGate: DISABLED_GATE,
        onDrain: () => {
          throw new Error('must not be called while disabled');
        },
        onResume: () => {},
      },
    });

    const button = getByText('Drain').closest('button');
    expect(button?.hasAttribute('disabled')).toBe(true);
  });

  test('when the admin gate is disabled for a draining worker, the button is disabled and labeled Resume', () => {
    const { getByText } = render(WorkerDetailView, {
      props: {
        worker: worker({ health: 'draining' }),
        adminGate: DISABLED_GATE,
        onDrain: () => {},
        onResume: () => {
          throw new Error('must not be called while disabled');
        },
      },
    });

    const button = getByText('Resume').closest('button');
    expect(button?.hasAttribute('disabled')).toBe(true);
  });
});

describe('WorkerDetailView — connection and activities panels', () => {
  test('renders queue, build identity, and concurrency in the connection panel', () => {
    const { getByText } = render(WorkerDetailView, {
      props: {
        worker: worker({
          queue: 'payments',
          buildId: '#123',
          inFlight: 2,
          concurrency: 8,
        }),
        adminGate: OPEN_GATE,
        onDrain: () => {},
        onResume: () => {},
      },
    });

    expect(getByText('payments')).not.toBeNull();
    expect(getByText('#123')).not.toBeNull();
    expect(getByText('2 / 8')).not.toBeNull();
  });

  test('missing build identity falls back to the em dash placeholder', () => {
    const { getByText } = render(WorkerDetailView, {
      props: {
        // `worker()`'s defaults already omit optional `buildId`, so this
        // exercises the `?? '—'` fallback directly.
        worker: worker(),
        adminGate: OPEN_GATE,
        onDrain: () => {},
        onResume: () => {},
      },
    });

    expect(getByText('—')).not.toBeNull();
  });

  test('renders one badge per reported activity', () => {
    const { getByText } = render(WorkerDetailView, {
      props: {
        worker: worker({ activities: ['Workflow.chargeCard', 'Workflow.sendEmail'] }),
        adminGate: OPEN_GATE,
        onDrain: () => {},
        onResume: () => {},
      },
    });

    expect(getByText('Workflow.chargeCard')).not.toBeNull();
    expect(getByText('Workflow.sendEmail')).not.toBeNull();
  });
});

const SESSION_NOW = 1_700_000_000_000;

function sessionDiagnostics(
  instance: Partial<WorkerManifestDiagnostics['instance']> = {},
): WorkerManifestDiagnostics {
  return {
    instance: {
      workerId: 'wkr_1',
      queue: 'default',
      health: 'active',
      connectedAt: SESSION_NOW - 3_600_000,
      startedAt: SESSION_NOW - 3_700_000,
      lastHeartbeatAt: SESSION_NOW - 4_000,
      heartbeatAgeMs: 4_000,
      sessionGeneration: 3,
      ...instance,
    },
    deploymentVersion: {
      deploymentName: 'payments',
      buildId: 'build-1',
      artifactDigest: 'sha256:artifact',
      runtimeName: 'bun',
      runtimeVersion: '1.4.0',
      sdkVersion: '0.20.0',
      manifestVersion: 1,
      protocolVersion: 3,
      manifestDigest: 'sha256:manifest',
      workflows: {},
    },
  };
}

function renderSession(props: {
  diagnostics?: WorkerManifestDiagnostics | null | undefined;
  loading?: boolean;
  error?: unknown;
}) {
  return render(WorkerDetailView, {
    props: {
      worker: worker(),
      adminGate: OPEN_GATE,
      onDrain: () => {},
      onResume: () => {},
      manifestDiagnostics: props.diagnostics,
      manifestLoading: props.loading ?? false,
      manifestError: props.error ?? null,
      now: SESSION_NOW,
    },
  });
}

function sessionRegion(container: HTMLElement) {
  const region = container.querySelector<HTMLElement>('[aria-labelledby="worker-session-heading"]');
  if (!region) throw new Error('missing session region');
  return within(region);
}

describe('WorkerDetailView — server-reported session', () => {
  test('shows session generation, connection instant, heartbeat timing, and health from diagnostics', () => {
    const { container } = renderSession({ diagnostics: sessionDiagnostics() });
    const session = sessionRegion(container);

    expect(session.getByRole('heading', { name: 'Session' })).not.toBeNull();
    expect(session.getByText('Session generation')).not.toBeNull();
    expect(session.getByText('3')).not.toBeNull();
    expect(
      session.getByText(`${new Date(SESSION_NOW - 3_600_000).toISOString()} (1h ago)`),
    ).not.toBeNull();
    expect(session.getByText(new Date(SESSION_NOW - 4_000).toISOString())).not.toBeNull();
    expect(session.getByText('4s · fresh (stale at 2m)')).not.toBeNull();
    expect(session.getAllByText('Active')).toHaveLength(2);
    expect(session.getByText('Heartbeat fresh')).not.toBeNull();
  });

  test('reports a stale session in text once heartbeat age passes the configured threshold', () => {
    const { container } = renderSession({
      diagnostics: sessionDiagnostics({ heartbeatAgeMs: 180_000, health: 'draining' }),
    });
    const session = sessionRegion(container);

    expect(session.getByText('Heartbeat stale')).not.toBeNull();
    expect(session.getByText('3m · stale (stale at 2m)')).not.toBeNull();
    expect(session.getByText(/No heartbeat for 3m\. The session may be slow/)).not.toBeNull();
    expect(session.getAllByText('Draining')).toHaveLength(2);
  });

  test('stale-session copy does not claim a proven resume changes the generation', () => {
    const { container } = renderSession({
      diagnostics: sessionDiagnostics({ heartbeatAgeMs: 180_000 }),
    });
    const warning = sessionRegion(container).getByText(/No heartbeat for 3m/);
    const copy = (warning.textContent ?? '').replace(/\s+/g, ' ');

    expect(copy).toContain(
      'A proven resume keeps generation 3; a fresh or unproven registration reports a higher one.',
    );
    expect(copy).not.toContain('a reconnect reports a generation above');
  });

  test('shows an explicit loading state while diagnostics load', () => {
    const { container } = renderSession({ loading: true });
    expect(
      sessionRegion(container).getByRole('status', { name: 'Loading worker session' }),
    ).not.toBeNull();
  });

  test('shows an empty state when the server reports no live session', () => {
    const { container } = renderSession({ diagnostics: null });
    expect(sessionRegion(container).getByText('No live session')).not.toBeNull();
  });

  test('shows an unavailable state before diagnostics have been read', () => {
    const { container } = renderSession({ diagnostics: undefined });
    expect(sessionRegion(container).getByText('Session evidence unavailable')).not.toBeNull();
  });

  test('shows a denied state for a 403', () => {
    const { container } = renderSession({ error: new HttpClientError(403, 'Forbidden') });
    const session = sessionRegion(container);
    expect(session.getByText('Session evidence is locked')).not.toBeNull();
    expect(
      session.getByText('Requires system:read to read worker session diagnostics.'),
    ).not.toBeNull();
  });

  test('shows a malformed-response state for diagnostics that fail validation', () => {
    const { container } = renderSession({
      error: new MalformedWorkerDiagnosticsError('response.worker.instance.sessionGeneration'),
    });
    const session = sessionRegion(container);
    expect(session.getByText('Malformed server response')).not.toBeNull();
    expect(session.getByText(/instance\.sessionGeneration/)).not.toBeNull();
  });

  test('shows the server fault treatment for a 500', () => {
    const { container } = renderSession({
      error: new HttpClientError(500, 'Internal server error'),
    });
    const session = sessionRegion(container);
    expect(session.getByText('Something went wrong')).not.toBeNull();
    expect(session.getByText('Internal server error')).not.toBeNull();
  });
});
