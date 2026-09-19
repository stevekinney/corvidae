import { expect, type Page, type Route } from '@playwright/test';
import { newFixtureMarker } from '../fixture-probe';
import { gotoHydrated } from '../page.svelte-test-helpers';
import { fixtureMarker } from '../streaming-fixture';

export { fixtureMarker, gotoHydrated, newFixtureMarker };
export type { Page, Route };

/** A title no other test will collide with, in this run or a previous one. */
export const uniqueTitle = (label: string): string =>
  `${label} ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export type PostOutcome =
  'success' | 'conflict' | 'error' | 'network' | 'completed-success' | 'completed-error';

function postPayloadOf(route: Route): { approved?: unknown; callId?: unknown } {
  const payload = route.request().postDataJSON();
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Expected approval POST payload to be an object.');
  }
  return {
    approved: Reflect.get(payload, 'approved'),
    callId: Reflect.get(payload, 'callId'),
  };
}

export function assertApprovedPost(route: Route, expectedCallId?: string): void {
  const payload = postPayloadOf(route);
  expect(payload.approved).toBe(true);
  if (expectedCallId === undefined) {
    expect(payload.callId).toEqual(expect.any(String));
    expect(payload.callId).not.toBe('');
  } else {
    expect(payload.callId).toBe(expectedCallId);
  }
}

/**
 * Serves the turn's NDJSON body from the test instead of from the server.
 *
 * WHY THIS EXISTS. These specs pin races around a question being REMOVED or
 * REPLACED underneath a decision that is already in flight. Both are real:
 * the gate asks about each gated call in turn, so one question resolves and
 * the next registers, and a second client can answer the current one at any
 * moment. Neither is producible from the local fixture, whose approval
 * scenario emits exactly one gated call — so the specs used to fabricate them
 * by answering the 250ms `GET …/elicitation` poll with a made-up body.
 *
 * That poll is gone: a question now arrives as an `elicitation.requested`
 * frame and leaves as `elicitation.resolved`. So the fabrication moves to
 * where the truth now lives. The test opens the response body itself and
 * pushes frames into it on demand, which is strictly more precise than the
 * poll ever was — a replacement lands exactly when the test says it does,
 * rather than on the next tick of a timer.
 *
 * Only the streaming turn is intercepted. Every other request, including the
 * answering POST, goes to the real server or to whatever `page.route` the
 * spec installed over it.
 */
export async function serveStreamFromTest(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const encoder = new TextEncoder();
    let live: ReadableStreamDefaultController<Uint8Array> | null = null;
    let sequence = 0;
    Reflect.set(window, '__pushFrame', (frame: Record<string, unknown>) => {
      if (live === null) throw new Error('no streaming turn is open');
      // The envelope is stamped here so a spec never has to keep a sequence
      // counter of its own — the decoder rejects a stream whose sequence does
      // not strictly increase, or whose version changes partway through.
      const line = `${JSON.stringify({ ...frame, wireVersion: 2, sequence })}\n`;
      sequence += 1;
      live.enqueue(encoder.encode(line));
      if (String(frame['type']).startsWith('run.')) {
        live.close();
        live = null;
      }
    });
    const native = window.fetch.bind(window);
    const patched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.endsWith('/stream')) return native(input, init);
      sequence = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          live = controller;
        },
        cancel() {
          live = null;
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
      });
    };
    window.fetch = Object.assign(patched, window.fetch);
  });
}

/** Pushes one frame into the open turn, stamping its wire envelope. */
export async function pushFrame(page: Page, frame: Record<string, unknown>): Promise<void> {
  await page.evaluate((one) => {
    const push = Reflect.get(window, '__pushFrame');
    if (typeof push !== 'function') throw new Error('the test stream is not installed');
    push(one);
  }, frame);
}

/** Raises a question on the open turn, as the server would. */
export async function askOnStream(
  page: Page,
  question: { requestId: string; callId: string; message: string },
): Promise<void> {
  await pushFrame(page, {
    type: 'elicitation.requested',
    requestId: question.requestId,
    toolCallId: question.callId,
    message: question.message,
  });
}

/** Reports a question answered, as the server would once it settles. */
export async function resolveOnStream(
  page: Page,
  question: { requestId: string; callId: string },
  accepted = true,
): Promise<void> {
  await pushFrame(page, {
    type: 'elicitation.resolved',
    requestId: question.requestId,
    toolCallId: question.callId,
    accepted,
  });
}
