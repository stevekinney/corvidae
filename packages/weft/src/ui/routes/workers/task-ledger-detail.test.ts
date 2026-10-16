import { render, within } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { HttpClientError } from '@lostgradient/weft';

import TaskLedgerDetailView from './task-ledger-detail-view.svelte';
import TaskLedgerPanel from './task-ledger-panel.svelte';
import { MalformedTaskLedgerError, parseTaskLedgerDetail } from './workers-data.ts';

const NOW = 1_700_000_000_000;

function queuedTask() {
  return {
    state: 'queued',
    operationId: 'op_ledger_123456789',
    workflowId: 'wf_1',
    workflowExecutionToken: 'token_1',
    workflowType: 'orders',
    activityName: 'chargeCard',
    queue: 'payments',
    priority: 7,
    headerKeys: ['traceparent', 'tenant-id'],
    visibilityTimeoutMilliseconds: 30_000,
    retryPolicy: {
      maxAttempts: 5,
      initialBackoff: '1s',
      backoffMultiplier: 2,
      maxBackoff: '1m',
    },
    executionRequirement: { deploymentName: 'payments-v2', buildId: 'build-42' },
    createdAt: NOW - 60_000,
    availableAt: NOW + 30_000,
    attempt: 2,
    retryCount: 1,
    requeueCount: 1,
    attempts: [],
  } as const;
}

describe('task ledger response validation', () => {
  test('accepts the published common ledger envelope', () => {
    expect(parseTaskLedgerDetail(queuedTask())).toEqual(queuedTask());
  });

  test('rejects malformed generated-operation output at the boundary', () => {
    expect(() => parseTaskLedgerDetail({ state: 'queued', operationId: 'op_bad' })).toThrow(
      'malformed task ledger response',
    );
  });
});

describe('TaskLedgerDetailView', () => {
  test('renders one state with attempt, dispatch, retry, and reservation evidence', () => {
    const { getByText } = render(TaskLedgerDetailView, {
      props: { task: parseTaskLedgerDetail(queuedTask()), now: NOW },
    });

    expect(getByText('Delayed')).not.toBeNull();
    expect(getByText('traceparent, tenant-id')).not.toBeNull();
    expect(getByText('Available · attempt 2 of 5')).not.toBeNull();
    expect(getByText(/deploymentName: payments-v2/)).not.toBeNull();
  });

  test('names an already-qualified activity once, without prefixing its workflow type again', () => {
    const { getByText, queryByText } = render(TaskLedgerDetailView, {
      props: {
        task: parseTaskLedgerDetail({ ...queuedTask(), activityName: 'orders.chargeCard' }),
        now: NOW,
      },
    });

    expect(getByText('orders.chargeCard')).not.toBeNull();
    expect(queryByText('orders.orders.chargeCard')).toBeNull();
  });

  test('qualifies a bare activity name with its workflow type', () => {
    const { getByText } = render(TaskLedgerDetailView, {
      props: { task: parseTaskLedgerDetail(queuedTask()), now: NOW },
    });

    expect(getByText('orders.chargeCard')).not.toBeNull();
  });

  test('labels cached ledger evidence while an authoritative refresh is pending', () => {
    const { getByRole } = render(TaskLedgerDetailView, {
      props: { task: parseTaskLedgerDetail(queuedTask()), now: NOW, refreshing: true },
    });

    expect(getByRole('status').textContent).toContain('Cached ledger evidence remains visible');
  });

  test('makes failed adoption and retained terminal evidence explicit', () => {
    const task = parseTaskLedgerDetail({
      ...queuedTask(),
      state: 'terminal',
      disposition: 'resolved',
      resultDigest: 'sha256:abc',
      resultStatus: 'completed',
      terminalAt: NOW - 10_000,
      adopted: false,
    });
    const { getByText } = render(TaskLedgerDetailView, { props: { task, now: NOW } });

    expect(getByText(/has not been adopted/)).not.toBeNull();
    expect(getByText('Awaiting workflow adoption')).not.toBeNull();
    expect(getByText(/Terminal record retained/)).not.toBeNull();
    expect(getByText('resolved')).not.toBeNull();
    expect(getByText('completed')).not.toBeNull();
    expect(getByText('sha256:abc')).not.toBeNull();
  });

  test('renders cancellation and dead-letter evidence without reconstructing state', () => {
    const task = parseTaskLedgerDetail({
      ...queuedTask(),
      state: 'deadLettered',
      pendingStatus: 'failed',
      resultDigest: 'sha256:failed',
      error: 'card processor unavailable',
      deadLetteredAt: NOW - 5_000,
      persistenceFailureReason: 'terminal result could not be persisted',
      cancellationReason: 'operator requested cancellation',
      cancellationRequestedAt: NOW - 15_000,
    });
    const { getAllByText, getByText } = render(TaskLedgerDetailView, { props: { task, now: NOW } });

    expect(getByText('Dead lettered')).not.toBeNull();
    expect(getByText('sha256:failed')).not.toBeNull();
    expect(getByText('card processor unavailable')).not.toBeNull();
    expect(getByText('operator requested cancellation')).not.toBeNull();
    expect(getAllByText('terminal result could not be persisted')).toHaveLength(2);
  });

  test('renders active lease, heartbeat, deadline, and exhausted retry evidence', () => {
    const task = parseTaskLedgerDetail({
      ...queuedTask(),
      state: 'leased',
      attempt: 5,
      availableAt: undefined,
      leaseDeadline: NOW + 20_000,
      lastHeartbeatAt: NOW - 2_000,
      scheduleToCloseDeadline: NOW + 120_000,
      fairShareKey: 'tenant-42',
      stickyWorkflowId: 'wf_sticky',
      lastRequeueReason: 'lease expired',
    });
    const { getByText } = render(TaskLedgerDetailView, { props: { task, now: NOW } });

    expect(getByText('leased')).not.toBeNull();
    expect(getByText('Already dispatched')).not.toBeNull();
    expect(getByText('Exhausted · attempt 5 of 5')).not.toBeNull();
    expect(getByText('tenant-42')).not.toBeNull();
    expect(getByText('wf_sticky')).not.toBeNull();
    expect(getByText('lease expired')).not.toBeNull();
  });

  test('renders adopted terminal evidence and optional envelope defaults', () => {
    const task = parseTaskLedgerDetail({
      ...queuedTask(),
      state: 'terminal',
      priority: undefined,
      headerKeys: [],
      retryPolicy: undefined,
      executionRequirement: undefined,
      adopted: true,
      adoptedAt: NOW - 1_000,
      terminalAt: NOW - 2_000,
      disposition: 'resolved',
    });
    const { getByText } = render(TaskLedgerDetailView, { props: { task, now: NOW } });

    expect(getByText('Default')).not.toBeNull();
    expect(getByText('No retry policy')).not.toBeNull();
    expect(getByText(/Adopted/)).not.toBeNull();
    expect(getByText('No constrained capacity')).not.toBeNull();
  });
});

function attemptRecord(overrides: Record<string, unknown> = {}) {
  return {
    attempt: 1,
    attemptTokenDigest: 'sha256:attempt-token-digest-0001',
    claimedAt: NOW - 50_000,
    disposition: 'requeued',
    dispositionAt: NOW - 40_000,
    sessionGeneration: 1,
    ...overrides,
  };
}

function leasedTask(overrides: Record<string, unknown> = {}) {
  return parseTaskLedgerDetail({
    ...queuedTask(),
    state: 'leased',
    availableAt: undefined,
    startedAt: NOW - 10_000,
    lastHeartbeatAt: NOW - 1_000,
    leaseDeadline: NOW + 20_000,
    attemptDeadline: NOW + 60_000,
    scheduleToCloseDeadline: NOW + 120_000,
    attempts: [
      attemptRecord({
        attempt: 2,
        claimedAt: NOW - 10_000,
        disposition: 'leased',
        dispositionAt: NOW - 10_000,
      }),
    ],
    ...overrides,
  });
}

function clock(container: HTMLElement, id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-clock="${id}"]`);
  if (!element) throw new Error(`missing clock ${id}`);
  return element;
}

function attemptEntry(container: HTMLElement, attempt: number): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-attempt="${attempt}"]`);
  if (!element) throw new Error(`missing attempt ${attempt}`);
  return element;
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

describe('task ledger lease and attempt validation', () => {
  test('rejects a response without an attempts array as malformed', () => {
    const { attempts: _attempts, ...withoutAttempts } = queuedTask();
    expect(() => parseTaskLedgerDetail(withoutAttempts)).toThrow(MalformedTaskLedgerError);
  });

  test('rejects an attempt record with an unknown disposition or a non-numeric claim', () => {
    expect(() =>
      parseTaskLedgerDetail({
        ...queuedTask(),
        attempts: [attemptRecord({ disposition: 'lost' })],
      }),
    ).toThrow(MalformedTaskLedgerError);
    expect(() =>
      parseTaskLedgerDetail({ ...queuedTask(), attempts: [attemptRecord({ claimedAt: 'soon' })] }),
    ).toThrow(MalformedTaskLedgerError);
  });

  test('rejects a non-numeric lease deadline', () => {
    expect(() => parseTaskLedgerDetail({ ...queuedTask(), attemptDeadline: 'later' })).toThrow(
      MalformedTaskLedgerError,
    );
  });
});

describe('TaskLedgerDetailView — lease clocks', () => {
  test('shows the session lease, attempt lease, and absolute deadline as three labeled clocks', () => {
    const task = leasedTask({ attemptDeadline: NOW - 1_000 });
    const { container } = render(TaskLedgerDetailView, { props: { task, now: NOW } });

    const session = within(clock(container, 'session-lease'));
    expect(session.getByText('Session lease')).not.toBeNull();
    expect(session.getByText('Active')).not.toBeNull();
    expect(session.getByText(iso(NOW + 20_000)).getAttribute('datetime')).toBe(iso(NOW + 20_000));

    const attempt = within(clock(container, 'attempt-lease'));
    expect(attempt.getByText('Attempt lease')).not.toBeNull();
    expect(attempt.getByText('Expired')).not.toBeNull();
    expect(attempt.getByText(iso(NOW - 1_000))).not.toBeNull();

    const deadline = within(clock(container, 'execution-deadline'));
    expect(deadline.getByText('Absolute execution deadline')).not.toBeNull();
    expect(deadline.getByText('Active')).not.toBeNull();
    expect(deadline.getByText(iso(NOW + 120_000))).not.toBeNull();
  });

  test('labels unset clocks and settled tasks instead of reporting them expired', () => {
    const queued = render(TaskLedgerDetailView, {
      props: { task: parseTaskLedgerDetail(queuedTask()), now: NOW },
    });
    expect(within(clock(queued.container, 'session-lease')).getByText('Not leased')).not.toBeNull();
    expect(
      within(clock(queued.container, 'attempt-lease')).getByText('No attempt limit'),
    ).not.toBeNull();
    expect(
      within(clock(queued.container, 'execution-deadline')).getByText('No deadline'),
    ).not.toBeNull();
    queued.unmount();

    const terminal = parseTaskLedgerDetail({
      ...queuedTask(),
      state: 'terminal',
      disposition: 'resolved',
      terminalAt: NOW - 1_000,
      adopted: true,
      scheduleToCloseDeadline: NOW - 60_000,
    });
    const { container } = render(TaskLedgerDetailView, { props: { task: terminal, now: NOW } });
    expect(
      within(clock(container, 'execution-deadline')).getByText('Settled · no longer running'),
    ).not.toBeNull();
    expect(container.querySelector('[data-state="expired"]')).toBeNull();
  });

  test('marks a running attempt stale once its heartbeat age passes the configured threshold', () => {
    const task = leasedTask({ lastHeartbeatAt: NOW - 200_000 });
    const stale = render(TaskLedgerDetailView, { props: { task, now: NOW } });
    const heartbeat = within(clock(stale.container, 'heartbeat'));
    expect(heartbeat.getByText('Stale')).not.toBeNull();
    expect(heartbeat.getByText(iso(NOW - 200_000))).not.toBeNull();
    expect(heartbeat.getByText('Stale after 2m without a heartbeat.')).not.toBeNull();
    stale.unmount();

    const relaxed = render(TaskLedgerDetailView, {
      props: { task, now: NOW, staleHeartbeatAfterMs: 300_000 },
    });
    expect(within(clock(relaxed.container, 'heartbeat')).getByText('Fresh')).not.toBeNull();
  });

  test('reports a running attempt with no heartbeat yet without calling it stale', () => {
    const task = leasedTask({ lastHeartbeatAt: undefined });
    const { container } = render(TaskLedgerDetailView, { props: { task, now: NOW } });
    expect(within(clock(container, 'heartbeat')).getByText('No heartbeat yet')).not.toBeNull();
  });
});

describe('TaskLedgerDetailView — fenced attempt history', () => {
  test('renders an empty history when no attempt has been claimed', () => {
    const { getByText } = render(TaskLedgerDetailView, {
      props: { task: parseTaskLedgerDetail(queuedTask()), now: NOW },
    });
    expect(getByText('No attempts claimed')).not.toBeNull();
  });

  test('orders attempts by attempt and claim time and fences an older late disposition', () => {
    const task = leasedTask({
      attempt: 3,
      attempts: [
        attemptRecord({
          attempt: 3,
          claimedAt: NOW - 5_000,
          disposition: 'leased',
          dispositionAt: NOW - 5_000,
        }),
        attemptRecord({
          attempt: 1,
          claimedAt: NOW - 60_000,
          disposition: 'requeued',
          // Recorded after attempt 2 claimed the task: must not stretch attempt 1's window.
          dispositionAt: NOW - 20_000,
          dispositionReason: 'lease expired',
        }),
        attemptRecord({
          attempt: 2,
          claimedAt: NOW - 30_000,
          disposition: 'requeued',
          dispositionAt: NOW - 10_000,
        }),
      ],
    });
    const { container } = render(TaskLedgerDetailView, { props: { task, now: NOW } });

    const order = [...container.querySelectorAll('[data-attempt]')].map((element) =>
      element.getAttribute('data-attempt'),
    );
    expect(order).toEqual(['1', '2', '3']);

    const first = within(attemptEntry(container, 1));
    expect(first.getByText(`${iso(NOW - 60_000)} → ${iso(NOW - 30_000)} (30s)`)).not.toBeNull();
    expect(first.getByText(/after attempt 2 claimed the task; fenced/)).not.toBeNull();
    expect(first.getByText('Superseded')).not.toBeNull();
    expect(first.queryByText(new RegExp(`→ ${iso(NOW - 20_000)}`))).toBeNull();

    const current = within(attemptEntry(container, 3));
    expect(current.getByText(`${iso(NOW - 5_000)} → still held`)).not.toBeNull();
    expect(current.queryByText('Superseded')).toBeNull();
    expect(container.textContent).toContain('Attempt 3 · current');
  });
});

describe('TaskLedgerDetailView — out-of-order attempt claims', () => {
  test('renders a zero-length window rather than a negative duration', () => {
    const task = leasedTask({
      attempt: 2,
      attempts: [
        attemptRecord({
          attempt: 1,
          claimedAt: NOW - 5_000,
          disposition: 'requeued',
          dispositionAt: NOW - 4_000,
        }),
        attemptRecord({
          attempt: 2,
          claimedAt: NOW - 20_000,
          disposition: 'leased',
          dispositionAt: NOW - 20_000,
        }),
      ],
    });
    const { container } = render(TaskLedgerDetailView, { props: { task, now: NOW } });

    const first = within(attemptEntry(container, 1));
    expect(first.getByText(`${iso(NOW - 5_000)} → ${iso(NOW - 5_000)} (0ms)`)).not.toBeNull();
    expect(attemptEntry(container, 1).textContent).not.toContain('(-');
  });
});

describe('TaskLedgerDetailView — attempt build identity', () => {
  function identity(overrides: Record<string, unknown>) {
    return {
      workerId: 'worker-a',
      manifestDigest: 'sha256:manifest',
      sdkVersion: '1.0.0',
      runtimeName: 'bun',
      runtimeVersion: '1.3.0',
      deploymentName: 'payments',
      buildId: 'build-41',
      artifactDigest: 'sha256:artifact-41',
      workflowType: 'orders',
      workflowRevision: 'rev-6',
      activityName: 'chargeCard',
      activityContractHash: 'sha256:contract',
      protocolVersion: 1,
      ...overrides,
    };
  }

  test('a retry across builds shows each attempt’s deployment, build, artifact, and revision', () => {
    const task = leasedTask({
      attempts: [
        attemptRecord({ attempt: 1, executionIdentity: identity({}) }),
        attemptRecord({
          attempt: 2,
          claimedAt: NOW - 10_000,
          disposition: 'leased',
          dispositionAt: NOW - 10_000,
          executionIdentity: identity({
            workerId: 'worker-b',
            deploymentName: 'payments-v2',
            buildId: 'build-42',
            artifactDigest: 'sha256:artifact-42',
            workflowRevision: 'rev-7',
          }),
        }),
      ],
    });
    const { container } = render(TaskLedgerDetailView, { props: { task, now: NOW } });

    const first = within(attemptEntry(container, 1));
    expect(first.getByText('payments')).not.toBeNull();
    expect(first.getByText('build-41')).not.toBeNull();
    expect(first.getByText('sha256:artifact-41')).not.toBeNull();
    expect(first.getByText('rev-6')).not.toBeNull();
    const second = within(attemptEntry(container, 2));
    expect(second.getByText('payments-v2')).not.toBeNull();
    expect(second.getByText('build-42')).not.toBeNull();
    expect(second.getByText('sha256:artifact-42')).not.toBeNull();
    expect(second.getByText('rev-7')).not.toBeNull();
  });

  test('an attempt without a recorded identity says so instead of inventing a build', () => {
    const task = leasedTask();
    const { container } = render(TaskLedgerDetailView, { props: { task, now: NOW } });

    expect(within(attemptEntry(container, 2)).getByText('Build identity')).not.toBeNull();
    expect(within(attemptEntry(container, 2)).getAllByText('Not recorded')).not.toHaveLength(0);
  });

  test('a drifted execution identity renders the task ledger as malformed', () => {
    expect(() =>
      leasedTask({
        attempts: [attemptRecord({ attempt: 2, executionIdentity: { workerId: 7 } })],
      }),
    ).toThrow(MalformedTaskLedgerError);
  });
});

describe('TaskLedgerDetailView — cancellation evidence', () => {
  test('a cancelling task whose owning attempt is still leased is requested, not acknowledged', () => {
    const task = leasedTask({
      state: 'cancelling',
      cancellationReason: 'operator requested cancellation',
      cancellationRequestedAt: NOW - 3_000,
    });
    const { getByText, queryByText } = render(TaskLedgerDetailView, { props: { task, now: NOW } });

    expect(getByText('Requested · awaiting worker acknowledgement')).not.toBeNull();
    expect(getByText('operator requested cancellation')).not.toBeNull();
    expect(getByText(`${iso(NOW - 3_000)} (just now)`)).not.toBeNull();
    expect(getByText('Not acknowledged · attempt 2 is leased')).not.toBeNull();
    expect(queryByText(/^Acknowledged/)).toBeNull();
  });

  test('a cancelled disposition on an older attempt never acknowledges the current attempt', () => {
    const task = leasedTask({
      state: 'cancelling',
      cancellationReason: 'operator requested cancellation',
      cancellationRequestedAt: NOW - 3_000,
      attempts: [
        attemptRecord({
          attempt: 1,
          disposition: 'cancelled',
          dispositionReason: 'worker stopped',
        }),
        attemptRecord({
          attempt: 2,
          claimedAt: NOW - 10_000,
          disposition: 'leased',
          dispositionAt: NOW - 10_000,
        }),
      ],
    });
    const { getByText, queryByText } = render(TaskLedgerDetailView, { props: { task, now: NOW } });

    expect(getByText('Requested · awaiting worker acknowledgement')).not.toBeNull();
    expect(
      getByText('Attempt 1 recorded cancellation; that does not acknowledge attempt 2'),
    ).not.toBeNull();
    expect(queryByText('Acknowledged by owning attempt')).toBeNull();
  });

  test("acknowledgement is shown only from the owning attempt's own cancelled disposition", () => {
    const task = parseTaskLedgerDetail({
      ...queuedTask(),
      state: 'terminal',
      disposition: 'cancelled',
      cancellationReason: 'operator requested cancellation',
      terminalAt: NOW - 1_000,
      adopted: true,
      attempts: [
        attemptRecord({
          attempt: 2,
          disposition: 'cancelled',
          dispositionAt: NOW - 2_000,
          dispositionReason: 'worker acknowledged cancellation',
        }),
      ],
    });
    const { getByText } = render(TaskLedgerDetailView, { props: { task, now: NOW } });

    expect(getByText('Acknowledged by owning attempt')).not.toBeNull();
    expect(
      getByText(
        `Acknowledged by attempt 2 at ${iso(NOW - 2_000)} · worker acknowledged cancellation`,
      ),
    ).not.toBeNull();
  });

  test('a cancellation Weft force-settled after the grace period is never shown as acknowledged', () => {
    const task = parseTaskLedgerDetail({
      ...queuedTask(),
      state: 'terminal',
      disposition: 'cancelled',
      cancellationReason: 'operator requested cancellation',
      terminalAt: NOW - 1_000,
      adopted: true,
      attempts: [
        attemptRecord({
          attempt: 2,
          disposition: 'cancelled',
          dispositionAt: NOW - 1_000,
          dispositionReason: 'cancellation deadline elapsed with no cooperative result',
        }),
      ],
    });
    const { getByText, queryByText } = render(TaskLedgerDetailView, { props: { task, now: NOW } });

    expect(getByText('Settled after grace period · no worker acknowledgement')).not.toBeNull();
    expect(
      getByText(
        `Not acknowledged · Weft settled attempt 2 at ${iso(NOW - 1_000)} after the cancellation grace period elapsed`,
      ),
    ).not.toBeNull();
    expect(queryByText('Acknowledged by owning attempt')).toBeNull();
    expect(queryByText(/^Acknowledged by attempt/)).toBeNull();
  });

  test('a cancelled terminal task without an owning cancelled attempt records no acknowledgement', () => {
    const task = parseTaskLedgerDetail({
      ...queuedTask(),
      state: 'terminal',
      disposition: 'cancelled',
      cancellationReason: 'workflow cancelled',
      terminalAt: NOW - 1_000,
      adopted: true,
      attempts: [],
    });
    const { getByText } = render(TaskLedgerDetailView, { props: { task, now: NOW } });

    expect(getByText('Cancelled · no worker acknowledgement recorded')).not.toBeNull();
    expect(getByText('No record for attempt 2 yet')).not.toBeNull();
  });

  test('an expired lease reads as an expired clock, not as cancellation', () => {
    const task = leasedTask({ leaseDeadline: NOW - 5_000 });
    const { container, getByText, queryByText } = render(TaskLedgerDetailView, {
      props: { task, now: NOW },
    });

    expect(within(clock(container, 'session-lease')).getByText('Expired')).not.toBeNull();
    expect(getByText('Not requested')).not.toBeNull();
    expect(getByText('No cancellation to acknowledge')).not.toBeNull();
    expect(queryByText(/Requested ·/)).toBeNull();
    expect(container.querySelector('[data-cancellation="not-requested"]')).not.toBeNull();
  });
});

describe('TaskLedgerPanel — query states', () => {
  test('shows an explicit loading state', () => {
    const { getByRole } = render(TaskLedgerPanel, {
      props: { loading: true, error: null, task: undefined, now: NOW },
    });
    expect(getByRole('status', { name: 'Loading task ledger' })).not.toBeNull();
  });

  test('shows a denied state for a 403 instead of a generic fault', () => {
    const { getByText } = render(TaskLedgerPanel, {
      props: {
        loading: false,
        error: new HttpClientError(403, 'Forbidden'),
        task: undefined,
        now: NOW,
      },
    });
    expect(getByText('Task ledger is locked')).not.toBeNull();
    expect(getByText('Requires system:read to read lease and attempt evidence.')).not.toBeNull();
  });

  test('shows a malformed-response state for a payload that fails validation', () => {
    let error: unknown;
    try {
      parseTaskLedgerDetail({ ...queuedTask(), attempts: 'none' });
    } catch (caught) {
      error = caught;
    }
    const { getByText } = render(TaskLedgerPanel, {
      props: { loading: false, error, task: undefined, now: NOW },
    });
    expect(getByText('Malformed server response')).not.toBeNull();
    expect(getByText('Weft returned a malformed task ledger response.')).not.toBeNull();
  });

  test('shows the server fault treatment for a 500', () => {
    const { getByText } = render(TaskLedgerPanel, {
      props: {
        loading: false,
        error: new HttpClientError(500, 'Internal server error'),
        task: undefined,
        now: NOW,
      },
    });
    expect(getByText('Something went wrong')).not.toBeNull();
    expect(getByText('Internal server error')).not.toBeNull();
  });

  test('renders the ledger, clocks, and history once data arrives', () => {
    const { getByRole, getByText } = render(TaskLedgerPanel, {
      props: { loading: false, error: null, task: leasedTask(), now: NOW },
    });
    expect(getByRole('heading', { name: 'Authoritative task ledger' })).not.toBeNull();
    expect(getByRole('heading', { name: 'Lease clocks' })).not.toBeNull();
    expect(getByRole('list', { name: 'Attempt history' })).not.toBeNull();
    expect(getByText('Attempt 2 · current')).not.toBeNull();
  });

  test('falls back to a no-selection state without data or error', () => {
    const { getByText } = render(TaskLedgerPanel, {
      props: { loading: false, error: null, task: undefined, now: NOW },
    });
    expect(getByText('No task selected')).not.toBeNull();
  });
});
