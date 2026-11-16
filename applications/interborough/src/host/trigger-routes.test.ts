/**
 * COR-2169 — the handler of `POST /triggers/<workflow-id>` (`trigger-routes.ts`), driven directly,
 * so each row is deterministic: the cap, the bytes it forwards, the signal, the statuses, and
 * what its log line and its answers hold. The route through a real host, its guard and a real
 * plugin is `host-triggers.test.ts`.
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { describe, expect, test } from 'bun:test';

import { createManualRuntimeServices } from '@lostgradient/bureau';

import {
  MAXIMUM_TRIGGER_BODY_BYTES,
  TRIGGER_BODY_DEADLINE_MILLISECONDS,
  TRIGGER_ROUTE,
  triggerRoutes,
  type TriggerBureau,
  type TriggerRouteDependencies,
} from './trigger-routes.ts';

const URL_OF = 'https://hooks.example.test/triggers/hook';

/** A request as Bun hands a route one: the decoded parameter is on `params`. */
function incoming(
  init: RequestInit & { duplex?: 'half' },
  workflow = 'hook',
): Bun.BunRequest<typeof TRIGGER_ROUTE> {
  return Object.assign(new Request(URL_OF, { method: 'POST', ...init }), {
    params: { workflow },
  }) as unknown as Bun.BunRequest<typeof TRIGGER_ROUTE>;
}

/** What `receiveTrigger` saw, and what it answers. */
function rig(
  answer: (id: string, request: Request) => Promise<Response> | Response,
  runtime?: TriggerRouteDependencies['runtime'],
) {
  const calls: Array<{ id: string; request: Request }> = [];
  const warnings: string[] = [];
  const bureau: TriggerBureau = {
    workflows: {
      receiveTrigger: async (id, request) => {
        calls.push({ id, request });
        return answer(id, request);
      },
    },
  };
  const { POST } = triggerRoutes({
    bureau,
    warn: (message) => warnings.push(message),
    ...(runtime === undefined ? {} : { runtime }),
  })[TRIGGER_ROUTE];
  return { calls, warnings, post: POST };
}

/** A body of `chunks` chunks of `size` bytes, pulled only when read, counting its pulls and its cancel. */
function countingBody(chunks: number, size: number) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulled += 1;
        controller.enqueue(new Uint8Array(size).fill(7));
        if (state.pulled === chunks) controller.close();
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { state, stream };
}

const ok = () => new Response('accepted', { status: 202 });

describe('M54: the body cap is the route’s, answered before Bureau is called (COR-2168 matrix)', () => {
  test('is 4 MiB', () => {
    expect(MAXIMUM_TRIGGER_BODY_BYTES).toBe(4 * 1024 * 1024);
  });

  test('a Content-Length over it answers 413 without reading a byte or calling receive', async () => {
    const { calls, post } = rig(ok);
    const { stream, state } = countingBody(1, 8);
    const response = await post(
      incoming({
        body: stream,
        duplex: 'half',
        headers: { 'content-length': String(MAXIMUM_TRIGGER_BODY_BYTES + 1) },
      }),
    );
    expect(response.status).toBe(413);
    expect(response.body).toBeNull();
    expect(state.pulled).toBe(0);
    expect(calls).toEqual([]);
  });

  test('a body of unknown length is counted as it streams: 413 once the count would pass the cap, nothing past it pulled', async () => {
    const { calls, post } = rig(ok);
    const mebibyte = 1024 * 1024;
    // Five 1 MiB chunks: the fifth is the one that crosses 4 MiB.
    const { stream, state } = countingBody(8, mebibyte);
    const response = await post(incoming({ body: stream, duplex: 'half' }));
    expect(response.status).toBe(413);
    expect(response.body).toBeNull();
    expect(state.pulled).toBe(5);
    expect(state.cancelled).toBe(true);
    expect(calls).toEqual([]);
  });

  test('a Content-Length under the real size is no licence: the stream is counted anyway', async () => {
    const { calls, post } = rig(ok);
    const { stream, state } = countingBody(8, 1024 * 1024);
    const response = await post(
      incoming({ body: stream, duplex: 'half', headers: { 'content-length': '10' } }),
    );
    expect(response.status).toBe(413);
    expect(state.pulled).toBe(5);
    expect(calls).toEqual([]);
  });

  test('a Content-Length that is not a number declares nothing', async () => {
    const { calls, post } = rig(ok);
    const response = await post(
      incoming({ body: 'small', headers: { 'content-length': 'a lot' } }),
    );
    expect(response.status).toBe(202);
    expect(calls).toHaveLength(1);
  });

  test('a body of exactly the cap is accepted whole', async () => {
    const { calls, post } = rig(async (_id, request) => {
      const bytes = new Uint8Array(await request.arrayBuffer());
      return new Response(String(bytes.byteLength), { status: 200 });
    });
    const { stream } = countingBody(4, 1024 * 1024);
    const response = await post(incoming({ body: stream, duplex: 'half' }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(String(MAXIMUM_TRIGGER_BODY_BYTES));
    expect(calls).toHaveLength(1);
  });

  test('a request with no body is an empty one', async () => {
    const { calls, post } = rig(async (_id, request) => new Response(await request.text()));
    const response = await post(incoming({}));
    expect(await response.text()).toBe('');
    expect(calls).toHaveLength(1);
  });
});

describe('the deadline on reading a body (COR-2169)', () => {
  /** A body that sends `first` and then nothing, as a client that stalls does. */
  function stalling(first: Uint8Array) {
    const state = { pulled: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          state.pulled += 1;
          if (state.pulled === 1) controller.enqueue(first);
          else return new Promise<void>(() => undefined);
          return undefined;
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return { state, stream };
  }

  test('is 30 seconds', () => {
    expect(TRIGGER_BODY_DEADLINE_MILLISECONDS).toBe(30_000);
  });

  test('a body not fully read within it is aborted and answered 408, without calling receive', async () => {
    const services = createManualRuntimeServices();
    const { calls, post } = rig(ok, services);
    const { stream, state } = stalling(new Uint8Array([1, 2, 3]));
    const pending = post(incoming({ body: stream, duplex: 'half' }));
    await services.advance(TRIGGER_BODY_DEADLINE_MILLISECONDS - 1);
    expect(state.cancelled).toBe(false);
    expect(calls).toEqual([]);
    await services.advance(1);
    const response = await pending;
    expect(response.status).toBe(408);
    expect(response.body).toBeNull();
    expect(state.cancelled).toBe(true);
    expect(calls).toEqual([]);
    expect(services.pendingTimers()).toEqual([]);
  });

  test('the timer is cancelled when the body completes: a slow receive is not a slow body', async () => {
    const services = createManualRuntimeServices();
    const release = Promise.withResolvers<void>();
    const { calls, post } = rig(async () => {
      await release.promise;
      return ok();
    }, services);
    const pending = post(incoming({ body: 'complete' }));
    await waitUntil(() => calls.length === 1, { message: 'receive to be called' });
    expect(services.pendingTimers()).toEqual([]);
    await services.advance(TRIGGER_BODY_DEADLINE_MILLISECONDS * 2);
    expect(calls[0]?.request.signal.aborted).toBe(false);
    release.resolve();
    const answered = await pending;
    expect(answered.status).toBe(202);
  });

  test('a body that fails is answered 500, and its timer is cancelled too', async () => {
    const services = createManualRuntimeServices();
    const { warnings, post } = rig(ok, services);
    const broken = new ReadableStream<Uint8Array>({
      pull() {
        throw new TypeError('the client went away');
      },
    });
    const response = await post(incoming({ body: broken, duplex: 'half' }));
    expect(response.status).toBe(500);
    expect(services.pendingTimers()).toEqual([]);
    expect(warnings.join()).not.toContain('went away');
  });
});

describe('the request the route snapshots before it reads the body (COR-2169)', () => {
  test('a header the host changes while the body is read does not reach receive', async () => {
    const { calls, post } = rig(ok);
    const request = incoming({
      headers: { 'x-hub-signature-256': 'sha256=original' },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          // The body is still arriving: the host's own headers object changes underneath.
          request.headers.set('x-hub-signature-256', 'sha256=changed');
          request.headers.set('x-added', 'late');
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      }),
      duplex: 'half',
    });
    await post(request);
    const forwarded = calls[0]?.request;
    expect(forwarded?.headers.get('x-hub-signature-256')).toBe('sha256=original');
    expect(forwarded?.headers.has('x-added')).toBe(false);
    expect(new Uint8Array(await forwarded!.arrayBuffer())).toEqual(new Uint8Array([1]));
  });
});

describe('what the trigger receives', () => {
  test('the decoded identifier, and a fresh request with the method, the url, the headers and the bytes as sent', async () => {
    const original = Uint8Array.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0x7f]);
    const { calls, post } = rig(ok);
    const request = incoming(
      {
        body: original,
        headers: {
          'x-hub-signature-256': 'sha256=abc',
          'content-type': 'application/octet-stream',
        },
      },
      '../host/status',
    );
    await post(request);
    const [call] = calls;
    expect(call?.id).toBe('../host/status');
    expect(call?.request).not.toBe(request);
    expect(call?.request.method).toBe('POST');
    expect(call?.request.url).toBe(URL_OF);
    expect(call?.request.headers.get('x-hub-signature-256')).toBe('sha256=abc');
    // Bytes, not text: a body that is not UTF-8 arrives intact.
    expect(new Uint8Array(await call!.request.arrayBuffer())).toEqual(original);
    // The incoming stream was read by the route, not handed on.
    expect(request.bodyUsed).toBe(true);
  });

  test('every Response is the trigger’s or Bureau’s, passed through unchanged', async () => {
    for (const status of [202, 404, 405]) {
      const answer = new Response(status === 202 ? 'accepted' : null, { status });
      const { post } = rig(() => answer);
      expect(await post(incoming({ body: '{}' }))).toBe(answer);
    }
  });
});

describe('the signal of the request receive gets', () => {
  test('follows the incoming request while receiveTrigger is pending', async () => {
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const { calls, post } = rig(async () => {
      entered.resolve();
      await release.promise;
      return ok();
    });
    const controller = new AbortController();
    const pending = post(incoming({ body: '{}', signal: controller.signal }));
    await entered.promise;
    expect(calls[0]?.request.signal.aborted).toBe(false);
    controller.abort();
    expect(calls[0]?.request.signal.aborted).toBe(true);
    release.resolve();
    await pending;
  });

  test('stops following once receiveTrigger settles, so an abort after the response does not stop a late fire', async () => {
    const { calls, post } = rig(ok);
    const controller = new AbortController();
    await post(incoming({ body: '{}', signal: controller.signal }));
    controller.abort();
    expect(calls[0]?.request.signal.aborted).toBe(false);
  });

  test('is aborted from the start for a request that arrived aborted', async () => {
    const { calls, post } = rig(ok);
    const controller = new AbortController();
    controller.abort();
    await post(incoming({ body: '{}', signal: controller.signal }));
    expect(calls[0]?.request.signal.aborted).toBe(true);
  });
});

describe('M57: the statuses the route authors for what Bureau rejects with (COR-2168 matrix)', () => {
  const secret = 'whsec-CANARY-0123456789';
  const signature = 'sha256=CANARY-signature-0123456789abcdef';
  const message = `the signature ${signature} did not match the secret ${secret}`;

  test('503 with no body for a Bureau that runs no workflows, naming only the workflow', async () => {
    const warnings: string[] = [];
    const { POST } = triggerRoutes({
      bureau: { workflows: undefined },
      warn: (line) => warnings.push(line),
    })[TRIGGER_ROUTE];
    const response = await POST(incoming({ body: '{}' }));
    expect(response.status).toBe(503);
    expect(response.body).toBeNull();
    expect(warnings.map((line) => JSON.parse(line))).toEqual([
      { event: 'host.trigger.failure', workflow: 'hook', error: 'WorkflowsUnavailable' },
    ]);
  });

  test.each([
    ['a plugin that needs setup', 'PluginNeedsSetupError', 503],
    ['any other error', 'Error', 500],
    ['a TypeError', 'TypeError', 500],
  ] as const)(
    '%s answers %p → %p with no body, and logs the id and the error name only',
    async (_label, name, status) => {
      const failure = Object.assign(new Error(message), { name });
      const { post, warnings } = rig(() => {
        throw failure;
      });
      const response = await post(
        incoming({ body: `{"secret":"${secret}"}`, headers: { 'x-signature': signature } }),
      );
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
      expect(response.statusText).toBe('');
      expect([...response.headers]).toEqual([]);
      expect(warnings.map((line) => JSON.parse(line))).toEqual([
        { event: 'host.trigger.failure', workflow: 'hook', error: name },
      ]);
      for (const text of [...warnings, await response.text()]) {
        expect(text).not.toContain('CANARY');
        expect(text).not.toContain(message);
      }
    },
  );

  test('a rejection that is not an Error is 500, and logs only its type', async () => {
    const { post, warnings } = rig(() => Promise.reject(`CANARY ${message}`));
    const response = await post(incoming({ body: '{}' }));
    expect(response.status).toBe(500);
    expect(warnings.map((line) => JSON.parse(line))).toEqual([
      { event: 'host.trigger.failure', workflow: 'hook', error: 'string' },
    ]);
    expect(warnings.join()).not.toContain('CANARY');
  });

  test('the identifier in the log line is JSON, so a hostile one cannot forge a line', async () => {
    const { post, warnings } = rig(() => {
      throw new Error('x');
    });
    await post(incoming({ body: '{}' }, 'a"\n{"event":"forged"}'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.includes('\n')).toBe(false);
    expect(JSON.parse(warnings[0]!)).toEqual({
      event: 'host.trigger.failure',
      workflow: 'a"\n{"event":"forged"}',
      error: 'Error',
    });
  });

  test('an answer that is not a failure is not logged', async () => {
    const { post, warnings } = rig(() => new Response(null, { status: 404 }));
    await post(incoming({ body: '{}' }));
    expect(warnings).toEqual([]);
  });
});
