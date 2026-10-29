/**
 * Integration tests for `WorkflowTailSource` against a REAL in-process weft
 * server (`live-source-test-server.test-support.ts`, a plain `serve()`) — no
 * mock server.
 *
 * Uses the `signal-stepped` fixture (`fixtures/workflows.ts`) specifically
 * so this suite can drive checkpoint commits deterministically —
 * `engine.signal(id, 'advance')` — rather than racing real wall-clock
 * timing against a fast-completing workflow.
 *
 * **Scope.** The reconnect, cursor-resume, buffer, and terminal-event
 * mechanics are exhaustively covered against a scripted `fetch` in
 * `workflow-tail-source.test.ts` (deterministic, no server, no real timers).
 * What genuinely needs a real server is proving the WIRE INTEGRATION holds:
 * real SSE framing, real engine execution driving real committed events,
 * catch-up-then-live delivery, and — the point of the cursor — that a
 * connection severed mid-stream resumes through the server's own
 * `Last-Event-ID` replay with nothing delivered twice and nothing skipped.
 * Bun gives no way to sever an in-flight SSE response from the client side,
 * so the severing test wraps `fetch` to relay the real response through a
 * stream the test can cut.
 */
import type { WorkflowEvent } from '@lostgradient/weft';
import { flushPortableMicrotasks, HttpClient } from '@lostgradient/weft';
import { waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { quietFor } from '@lostgradient/testing/wait-until';
import { installFetchImplementation } from './fetch.test-support.ts';
import {
  startLiveSourceTestServer,
  type LiveSourceTestServer,
} from './live-source-test-server.test-support.ts';
import { WorkflowTailSource } from './workflow-tail-source.svelte.ts';

/**
 * Promise turns that drain a delivery already queued behind the stream reader: a count of
 * microtask hops, which never depends on host load.
 */
const MICROTASK_TURNS = 100;

/** The caller connection a `WorkflowTailSource` reads: the real client's base URL and authorization headers. */
function sseClient(server: LiveSourceTestServer): HttpClient {
  return new HttpClient({ baseUrl: server.baseUrl, token: server.token });
}

async function startSignalStepped(
  server: LiveSourceTestServer,
  workflowId: string,
  steps: number,
): Promise<void> {
  await server.engine.start('signal-stepped', { steps }, { id: workflowId });
}

/**
 * Relays each per-workflow SSE request to the real server through a stream the test can cut,
 * which is the closest a client-side test gets to a network drop mid-stream.
 */
function installSeverableFetch(): { sever(): void; requests: Request[]; restore(): void } {
  const original = globalThis.fetch;
  const requests: Request[] = [];
  const cuts: (() => void)[] = [];
  const restore = installFetchImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const upstream = await original(request.clone());
    if (upstream.body === null || !request.url.includes('/events/sse')) return upstream;
    const reader = upstream.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        cuts.push(() => {
          void reader.cancel();
          controller.close();
        });
      },
      async pull(controller) {
        const chunk = await reader.read();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      },
    });
    return new Response(body, { status: upstream.status, headers: upstream.headers });
  });
  return { sever: () => cuts.pop()?.(), requests, restore };
}

function identities(events: readonly WorkflowEvent[]): string[] {
  return events.map((event) => `${event.type}:${String(event.data['step'])}`);
}

let restoreFetch: (() => void) | undefined;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

describe('WorkflowTailSource (integration, real server)', () => {
  test('whenConnected resolves after catch-up, then delivers live frames driven by real engine activity', async () => {
    const server = await startLiveSourceTestServer();
    try {
      const workflowId = 'wts-integration-catchup-live';
      await startSignalStepped(server, workflowId, 3);

      // Commit one step before subscribing so catch-up has a deterministic
      // persisted frame. Waiting for wall-clock time does not prove that the
      // workflow has reached its signal boundary or committed anything.
      await server.engine.signal(workflowId, 'advance');

      const client = sseClient(server);
      const source = new WorkflowTailSource(client, workflowId);
      const received: WorkflowEvent[] = [];
      source.subscribe((frame) => received.push(frame));

      await source.whenConnected();
      expect(source.status).toBe('live');
      await waitFor(() => {
        expect(received.length).toBeGreaterThan(0);
      });
      const catchUpCount = received.length;

      // Drive a genuinely LIVE checkpoint through real engine execution.
      await server.engine.signal(workflowId, 'advance');

      await waitFor(() => {
        expect(received.length).toBeGreaterThan(catchUpCount);
      });

      source.close();
    } finally {
      await server.stop();
    }
  });

  test('a second, independent tail catches up to everything committed so far exactly once, in order (the mechanism reconnect relies on)', async () => {
    const server = await startLiveSourceTestServer();
    try {
      const workflowId = 'wts-integration-second-tail';
      await startSignalStepped(server, workflowId, 3);
      await server.engine.signal(workflowId, 'advance');
      await server.engine.signal(workflowId, 'advance');

      const firstClient = sseClient(server);
      const firstSource = new WorkflowTailSource(firstClient, workflowId);
      const firstReceived: WorkflowEvent[] = [];
      firstSource.subscribe((frame) => firstReceived.push(frame));
      await firstSource.whenConnected();
      await waitFor(() => {
        expect(firstReceived.length).toBeGreaterThanOrEqual(2);
      });
      firstSource.close();

      // A fresh tail (what a reconnect opens) independently catches up to
      // the SAME committed history — no duplicates, no gaps, same order.
      const secondClient = sseClient(server);
      const secondSource = new WorkflowTailSource(secondClient, workflowId);
      const secondReceived: WorkflowEvent[] = [];
      secondSource.subscribe((frame) => secondReceived.push(frame));
      await secondSource.whenConnected();
      await waitFor(() => {
        expect(secondReceived.length).toBeGreaterThanOrEqual(firstReceived.length);
      });

      expect(secondReceived.slice(0, firstReceived.length)).toEqual(firstReceived);
      // No duplicate (type, data) pairs within the second tail's own delivery.
      const seen = new Set(
        secondReceived.map((frame) => `${frame.type}:${JSON.stringify(frame.data)}`),
      );
      expect(seen.size).toBe(secondReceived.length);

      secondSource.close();
    } finally {
      await server.stop();
    }
  });

  test('close() stops delivery — no further frames arrive after close', async () => {
    const server = await startLiveSourceTestServer();
    try {
      const workflowId = 'wts-integration-close';
      await startSignalStepped(server, workflowId, 2);
      await server.engine.signal(workflowId, 'advance');

      const client = sseClient(server);
      const source = new WorkflowTailSource(client, workflowId);
      const received: WorkflowEvent[] = [];
      source.subscribe((frame) => received.push(frame));
      await source.whenConnected();

      // `whenConnected()` resolving (the `replayComplete` ping) does not by
      // itself guarantee every catch-up frame ahead of that ping has
      // finished its own delivery microtask — let catch-up fully settle
      // before taking the "at close" baseline, or this test would be
      // asserting on an inherent delivery race rather than close()'s
      // actual behavior.
      await waitFor(() => {
        expect(received.length).toBeGreaterThan(0);
      });

      source.close();
      expect(source.status).toBe('closed');
      // A delivery already queued when close() ran is a microtask; what arrives after that would
      // be close() failing to stop the stream.
      await flushPortableMicrotasks(MICROTASK_TURNS);
      const countAtClose = received.length;

      await server.engine.signal(workflowId, 'advance');
      await quietFor(100);
      expect(received.length).toBe(countAtClose);
    } finally {
      await server.stop();
    }
  });

  test('a connection severed mid-stream resumes from its cursor: nothing delivered twice, nothing skipped', async () => {
    const server = await startLiveSourceTestServer();
    try {
      const workflowId = 'wts-integration-sever-resume';
      await startSignalStepped(server, workflowId, 5);
      await server.engine.signal(workflowId, 'advance');

      const relay = installSeverableFetch();
      restoreFetch = relay.restore;
      const source = new WorkflowTailSource(sseClient(server), workflowId, {
        computeReconnectDelayMs: () => 1,
      });
      const received: WorkflowEvent[] = [];
      source.subscribe((frame) => received.push(frame));
      await source.whenConnected();
      await waitFor(() => expect(received.length).toBeGreaterThan(0));
      const deliveredBeforeSever = received.length;

      relay.sever();
      await waitFor(() => expect(relay.requests.length).toBe(2));
      expect(relay.requests[0]?.headers.get('Last-Event-ID')).toBeNull();
      expect(relay.requests[1]?.headers.get('Last-Event-ID')).not.toBeNull();

      // Events committed after the sever arrive on the resumed connection only.
      await server.engine.signal(workflowId, 'advance');
      await server.engine.signal(workflowId, 'advance');
      await waitFor(() => expect(received.length).toBeGreaterThan(deliveredBeforeSever));

      // A control tail that never severs sees the whole history once; the resumed tail must match
      // it exactly, which rules out both a replayed prefix and a gap.
      const control = new WorkflowTailSource(sseClient(server), workflowId);
      const controlReceived: WorkflowEvent[] = [];
      control.subscribe((frame) => controlReceived.push(frame));
      await control.whenConnected();
      // Compared by event identity (type and step): the server's replayed history also carries a
      // `__weftCheckpointReplay` payload that its live frames omit, which says nothing about delivery.
      await waitFor(() => expect(identities(received)).toEqual(identities(controlReceived)));
      expect(new Set(identities(received)).size).toBe(received.length);

      control.close();
      source.close();
    } finally {
      await server.stop();
    }
  });
});
