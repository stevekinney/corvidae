import { describe, expect, test } from 'bun:test';

import { describeSessionLifecycle, type SessionInstance } from './worker-session-lifecycle.ts';

const NOW = 1_700_000_000_000;

function instance(overrides: Partial<SessionInstance> = {}): SessionInstance {
  return {
    workerId: 'worker-a',
    queue: 'payments',
    transport: 'websocket',
    health: 'active',
    connectedAt: NOW - 60_000,
    startedAt: NOW - 120_000,
    lastHeartbeatAt: NOW - 1_000,
    heartbeatAgeMs: 1_000,
    sessionGeneration: 2,
    ...overrides,
  };
}

describe('describeSessionLifecycle — WebSocket', () => {
  test('a healthy worker is connected, with no session deadline', () => {
    const lifecycle = describeSessionLifecycle(instance(), NOW);
    expect(lifecycle).toMatchObject({ state: 'connected', label: 'Connected', variant: 'success' });
    expect(lifecycle.connection).toBe('The WebSocket is connected.');
    expect(lifecycle.deadline).toContain('None. A WebSocket session has no lease deadline');
    expect(lifecycle.registration).toBe(
      'Registered with the server on queue payments, generation 2',
    );
  });

  test('a dropped socket inside the grace window is reconnecting, and keeps its registration', () => {
    const lifecycle = describeSessionLifecycle(
      instance({ reconnectGraceEndsAt: NOW + 1_500 }),
      NOW,
    );
    expect(lifecycle).toMatchObject({
      state: 'reconnecting',
      label: 'Reconnecting',
      variant: 'warning',
    });
    expect(lifecycle.connection).toContain('The socket is disconnected');
    expect(lifecycle.registration).toContain('Registered with the server');
    expect(lifecycle.deadline).toBe(
      `Reconnect grace window closes ${new Date(NOW + 1_500).toISOString()} (in 1s); a same-id reconnect before then resumes the session`,
    );
  });

  test('a grace window that has passed says the server is requeueing', () => {
    const lifecycle = describeSessionLifecycle(
      instance({ reconnectGraceEndsAt: NOW - 4_000 }),
      NOW,
    );
    expect(lifecycle.state).toBe('reconnecting');
    expect(lifecycle.deadline).toContain('closed');
    expect(lifecycle.deadline).toContain('4s ago');
    expect(lifecycle.deadline).toContain("requeueing this worker's in-flight work");
  });

  test('draining is closing, drained is closed', () => {
    expect(describeSessionLifecycle(instance({ health: 'draining' }), NOW)).toMatchObject({
      state: 'closing',
      label: 'Closing · draining',
      variant: 'warning',
    });
    expect(describeSessionLifecycle(instance({ health: 'drained' }), NOW)).toMatchObject({
      state: 'closed',
      label: 'Closed · drained',
      variant: 'neutral',
    });
  });

  test('a reconnect window outranks the health state', () => {
    expect(
      describeSessionLifecycle(instance({ health: 'draining', reconnectGraceEndsAt: NOW + 1 }), NOW)
        .state,
    ).toBe('reconnecting');
  });
});

describe('describeSessionLifecycle — HTTP long-poll', () => {
  test('has no persistent connection, and states its lease expiry', () => {
    const lifecycle = describeSessionLifecycle(
      instance({ transport: 'long-poll', sessionLeaseExpiresAt: NOW + 42_000 }),
      NOW,
    );
    expect(lifecycle.state).toBe('connected');
    expect(lifecycle.connection).toContain('No persistent connection');
    expect(lifecycle.deadline).toBe(
      `Session lease expires ${new Date(NOW + 42_000).toISOString()} (in 42s) unless a poll or heartbeat renews it`,
    );
  });

  test('an expired lease says what the server answers next', () => {
    const lifecycle = describeSessionLifecycle(
      instance({ transport: 'long-poll', sessionLeaseExpiresAt: NOW - 9_000 }),
      NOW,
    );
    expect(lifecycle.deadline).toContain('Session lease expired');
    expect(lifecycle.deadline).toContain('9s ago');
    expect(lifecycle.deadline).toContain('410');
  });

  test('a lease the server did not report is said so rather than invented', () => {
    expect(describeSessionLifecycle(instance({ transport: 'long-poll' }), NOW).deadline).toBe(
      'Session lease expiry not reported',
    );
  });

  test('a long-poll worker never reads as reconnecting from a stray grace field', () => {
    // The server sets reconnectGraceEndsAt for WebSocket workers only; the lifecycle follows the field.
    expect(
      describeSessionLifecycle(
        instance({ transport: 'long-poll', health: 'drained', sessionLeaseExpiresAt: NOW }),
        NOW,
      ).state,
    ).toBe('closed');
  });
});
