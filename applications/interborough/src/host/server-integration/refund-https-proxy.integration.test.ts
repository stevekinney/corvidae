import { rethrow } from '@lostgradient/testing/module-scope-scenario';
import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import { expect, it } from 'bun:test';
import { format } from 'node:util';
import { startRefundProxy } from '../../../tests/e2e/refund-https-proxy.test-support.ts';
import { refundScenario } from './refund-scenario.test-support.ts';

const scenario1 = await refundScenario(async (onHang) => {
  const directory = createTemporaryDirectory('refund-proxy');
  onHang(() => removeTemporaryPath(directory));
  const observations: {
    index: number;
    origin: string | null;
    cookie: string | null;
    host: string | null;
    body: string;
  }[] = [];
  const hosts = [0, 1].map((index) =>
    Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/stream')
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('data: ready\n\n'));
                controller.close();
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        const body = await request.text();
        observations.push({
          index,
          origin: request.headers.get('origin'),
          cookie: request.headers.get('cookie'),
          host: request.headers.get('host'),
          body,
        });
        return Response.json({
          result: { id: 'review', receipt: index === 0 ? 'applied' : 'conflict' },
        });
      },
    }),
  );
  onHang(async () => {
    for (const host of hosts) await host.stop(true);
  });
  const proxy = await startRefundProxy(directory).catch(async (error: unknown) => {
    for (const host of hosts) await host.stop(true);
    removeTemporaryPath(directory);
    throw error;
  });
  onHang(() => proxy.close());
  try {
    proxy.setTargets(hosts.map((host) => host.url.toString()));
    const input = { id: 'review', round: 0, decision: 'approve' };
    const responses = await Promise.all(
      [0, 1].map(async (index) => {
        const response = await fetch(`${proxy.origin}/bureau/jsonrpc`, {
          method: 'POST',
          headers: {
            'x-refund-fixture-host': String(index),
            origin: proxy.origin,
            cookie: 'session=fixture',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ method: 'bureau.reviews.resolve', params: input }),
          tls: { rejectUnauthorized: false },
        });
        return response.json();
      }),
    );
    expect(responses).toEqual([
      { result: { id: 'review', receipt: 'applied' } },
      { result: { id: 'review', receipt: 'conflict' } },
    ]);
    expect(observations).toHaveLength(2);
    for (const item of observations) {
      expect(item).toMatchObject({
        origin: proxy.origin,
        host: new URL(proxy.origin).host,
        cookie: 'session=fixture',
      });
      expect(JSON.parse(item.body)).toMatchObject({ params: input });
    }
    expect(proxy.calls.map((call) => call.host).sort((left, right) => left - right)).toEqual([
      0, 1,
    ]);
    expect(proxy.calls.every((call) => call.status === 200 && call.response !== undefined)).toBe(
      true,
    );
    const stream = await fetch(`${proxy.origin}/stream`, {
      headers: { 'x-refund-fixture-host': '0' },
      tls: { rejectUnauthorized: false },
    });
    expect(await stream.text()).toBe('data: ready\n\n');
  } finally {
    await proxy.drain();
    await proxy.close();
    for (const host of hosts) await host.stop(true);
    removeTemporaryPath(directory);
  }
});
it('forwards two HTTPS contexts to separate listeners without changing authority or bodies', () =>
  rethrow(scenario1));

for (const row of [
  'bureau.reviews.list',
  'bureau.reviews.get',
  'bureau.reviews.resolve',
] as const) {
  const procedure = row;
  const scenario2 = await refundScenario(async (onHang) => {
    const directory = createTemporaryDirectory('refund-proxy-identity');
    onHang(() => removeTemporaryPath(directory));
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response('Workspace identity changed', {
          status: 409,
          headers: { 'x-interborough-identity-mismatch': '1' },
        }),
    });
    onHang(() => upstream.stop(true));
    const proxy = await startRefundProxy(directory).catch(async (error: unknown) => {
      await upstream.stop(true);
      removeTemporaryPath(directory);
      throw error;
    });
    onHang(() => proxy.close());
    try {
      proxy.setTargets([upstream.url.toString()]);
      const response = await fetch(`${proxy.origin}/jsonrpc`, {
        method: 'POST',
        headers: { 'x-refund-fixture-host': '0', 'content-type': 'application/json' },
        body: JSON.stringify({ method: procedure, params: {} }),
        tls: { rejectUnauthorized: false },
      });
      expect(response.status).toBe(409);
      expect(response.headers.get('x-interborough-identity-mismatch')).toBe('1');
      expect(await response.text()).toBe('Workspace identity changed');
      await proxy.drain();
      const call = procedure === 'bureau.reviews.resolve' ? proxy.calls[0] : proxy.reads[0];
      expect(call).toMatchObject({ status: 409, response: 'Workspace identity changed' });
      expect(call?.finished).toBeDefined();
    } finally {
      await proxy.close();
      await upstream.stop(true);
      removeTemporaryPath(directory);
    }
  });
  it(format('preserves a plain-text identity mismatch on %s', procedure), () => rethrow(scenario2));
}

const scenario3 = await refundScenario(async (onHang) => {
  const directory = createTemporaryDirectory('refund-proxy-invalid-json');
  onHang(() => removeTemporaryPath(directory));
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('invalid'),
  });
  onHang(() => upstream.stop(true));
  const proxy = await startRefundProxy(directory).catch(async (error: unknown) => {
    await upstream.stop(true);
    removeTemporaryPath(directory);
    throw error;
  });
  onHang(() => proxy.close());
  try {
    proxy.setTargets([upstream.url.toString()]);
    const response = await fetch(`${proxy.origin}/jsonrpc`, {
      method: 'POST',
      headers: { 'x-refund-fixture-host': '0', 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'bureau.reviews.list', params: {} }),
      tls: { rejectUnauthorized: false },
    });
    expect(response.status).toBe(502);
    const failure = await proxy.drain().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect(proxy.cancellations).toEqual([]);
  } finally {
    await proxy.close();
    await upstream.stop(true);
    removeTemporaryPath(directory);
  }
});
it('keeps malformed successful captured responses fatal', () => rethrow(scenario3));

for (const row of [
  ['bureau.reviews.list', '/jsonrpc', 'waiting-for-claims', '0', true],
  ['bureau.reviews.resolve', '/jsonrpc', 'waiting-for-claims', '0', false],
  ['bureau.reviews.get', '/jsonrpc', 'waiting-for-claims', '0', false],
  ['bureau.reviews.list', '/jsonrpc', 'panel-teardown', '0', false],
  ['bureau.reviews.list', '/bureau/jsonrpc', 'waiting-for-claims', '0', false],
  ['bureau.reviews.list', '/jsonrpc', 'waiting-for-claims', '1', false],
  ['bureau.reviews.list', '/jsonrpc', 'warning-decision', '0', true],
  ['bureau.reviews.list', '/jsonrpc', 'setup', '0', false],
  ['bureau.reviews.get', '/jsonrpc', 'warning-decision', '0', false],
  ['bureau.reviews.resolve', '/jsonrpc', 'warning-decision', '0', false],
] as const) {
  const [procedure, path, phase, host, acknowledged] = row;
  const scenario4 = await refundScenario(async (onHang) => {
    const directory = createTemporaryDirectory('refund-proxy-cancel');
    onHang(() => removeTemporaryPath(directory));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch() {
        entered.resolve();
        await release.promise;
        return Response.json({ reviews: [] });
      },
    });
    onHang(() => {
      release.resolve();
      return upstream.stop(true);
    });
    const proxy = await startRefundProxy(directory).catch(async (error: unknown) => {
      release.resolve();
      await upstream.stop(true);
      removeTemporaryPath(directory);
      throw error;
    });
    onHang(() => proxy.close());
    try {
      proxy.setTargets([upstream.url.toString(), upstream.url.toString()]);
      proxy.setPhase(phase === 'warning-decision' ? 'setup' : phase);
      const controller = new AbortController();
      const pending = fetch(`${proxy.origin}${path}`, {
        method: 'POST',
        headers: { 'x-refund-fixture-host': host, 'content-type': 'application/json' },
        body: JSON.stringify({ method: procedure, params: {} }),
        signal: controller.signal,
        tls: { rejectUnauthorized: false },
      }).then(
        () => 'answered',
        () => 'aborted',
      );
      await entered.promise;
      proxy.setPhase(phase);
      controller.abort();
      expect(await pending).toBe('aborted');
      release.resolve();
      const failure = await proxy.drain().then(
        () => undefined,
        (error: unknown) => error,
      );
      if (acknowledged) {
        expect(failure).toBeUndefined();
        expect(proxy.cancellations).toHaveLength(1);
        expect(JSON.parse(proxy.cancellations[0]!.message)).toMatchObject({
          host,
          method: 'POST',
          path,
          procedure,
          phase,
          ingressPhase: phase === 'warning-decision' ? 'setup' : phase,
          ingressAborted: true,
        });
        expect(proxy.cancellations[0]!.cause).toBeDefined();
      } else {
        expect(failure).toBeInstanceOf(AggregateError);
        const errors = (failure as AggregateError).errors as Error[];
        expect(JSON.parse(errors[0]!.message)).toMatchObject({
          host,
          method: 'POST',
          path,
          procedure,
          phase,
          ingressAborted: true,
        });
        expect(errors[0]!.cause).toBeDefined();
        expect(proxy.cancellations).toHaveLength(0);
      }
    } finally {
      release.resolve();
      await proxy.close();
      await upstream.stop(true);
      removeTemporaryPath(directory);
    }
  });
  it(
    format(
      'classifies client abort of %s at %s during %s on host %s',
      procedure,
      path,
      phase,
      host,
    ),
    () => rethrow(scenario4),
  );
}

for (const row of [
  ['bureau.contexts.get', '/jsonrpc', '0', 'old', 'setup', true, true],
  ['bureau.contexts.get', '/jsonrpc', '0', 'new', 'setup', true, false],
  ['bureau.contexts.get', '/jsonrpc', '0', 'missing', 'setup', true, false],
  ['bureau.contexts.get', '/jsonrpc', '1', 'old', 'setup', true, false],
  ['bureau.contexts.get', '/bureau/jsonrpc', '0', 'old', 'setup', true, false],
  ['bureau.contexts.get', '/jsonrpc', '0', 'old', 'warning-decision', true, false],
  ['bureau.contexts.get', '/jsonrpc', '0', 'old', 'setup', false, false],
  ['bureau.contexts.list', '/jsonrpc', '0', 'old', 'setup', true, false],
  ['bureau.reviews.resolve', '/jsonrpc', '0', 'old', 'setup', true, false],
] as const) {
  const [procedure, path, host, identity, ingressPhase, armed, acknowledged] = row;
  const scenario = await refundScenario(async (onHang) => {
    const directory = createTemporaryDirectory('refund-proxy-identity-cancel');
    onHang(() => removeTemporaryPath(directory));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch() {
        entered.resolve();
        await release.promise;
        return Response.json({ result: {} });
      },
    });
    onHang(() => {
      release.resolve();
      return upstream.stop(true);
    });
    const proxy = await startRefundProxy(directory).catch(async (error: unknown) => {
      release.resolve();
      await upstream.stop(true);
      removeTemporaryPath(directory);
      throw error;
    });
    onHang(() => proxy.close());
    try {
      proxy.setTargets([upstream.url.toString(), upstream.url.toString()]);
      if (armed) proxy.allowOldIdentityContextCancellation('old');
      proxy.setPhase(ingressPhase);
      const controller = new AbortController();
      const pending = fetch(`${proxy.origin}${path}`, {
        method: 'POST',
        headers: {
          'x-refund-fixture-host': host,
          'content-type': 'application/json',
          ...(identity === 'missing' ? {} : { 'x-interborough-expected-identity': identity }),
        },
        body: JSON.stringify({ method: procedure, params: {} }),
        signal: controller.signal,
        tls: { rejectUnauthorized: false },
      }).then(
        () => 'answered',
        () => 'aborted',
      );
      await entered.promise;
      proxy.setPhase('identity-change');
      controller.abort();
      expect(await pending).toBe('aborted');
      release.resolve();
      const failure = await proxy.drain().then(
        () => undefined,
        (error: unknown) => error,
      );
      if (acknowledged) {
        expect(failure).toBeUndefined();
        expect(proxy.cancellations).toHaveLength(1);
        expect(JSON.parse(proxy.cancellations[0]!.message)).toMatchObject({
          host,
          method: 'POST',
          path,
          procedure,
          phase: 'identity-change',
          ingressPhase,
          ingressAborted: true,
          oldIdentity: true,
        });
        expect(proxy.cancellations[0]!.cause).toBeDefined();
      } else {
        expect(failure).toBeInstanceOf(AggregateError);
        expect(proxy.cancellations).toEqual([]);
      }
    } finally {
      release.resolve();
      await proxy.close();
      await upstream.stop(true);
      removeTemporaryPath(directory);
    }
  });
  it(
    format(
      'identity cancellation %s %s host %s identity %s ingress %s armed %s',
      procedure,
      path,
      host,
      identity,
      ingressPhase,
      armed,
    ),
    () => rethrow(scenario),
  );
}

for (const row of [
  ['waiting-for-claims', 'bureau.reviews.list'],
  ['warning-decision', 'bureau.reviews.list'],
  ['identity-change', 'bureau.contexts.get'],
] as const) {
  const [phase, procedure] = row;
  const scenario5 = await refundScenario(async (onHang) => {
    const directory = createTemporaryDirectory('refund-proxy-upstream');
    onHang(() => removeTemporaryPath(directory));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch() {
        entered.resolve();
        await release.promise;
        return new Response('not JSON', { status: 502 });
      },
    });
    onHang(() => {
      release.resolve();
      return upstream.stop(true);
    });
    const proxy = await startRefundProxy(directory).catch(async (error: unknown) => {
      await upstream.stop(true);
      removeTemporaryPath(directory);
      throw error;
    });
    onHang(() => proxy.close());
    try {
      proxy.setTargets([upstream.url.toString(), upstream.url.toString()]);
      if (phase === 'identity-change') proxy.allowOldIdentityContextCancellation('old');
      proxy.setPhase(phase === 'identity-change' ? 'setup' : phase);
      const pending = fetch(`${proxy.origin}/jsonrpc`, {
        method: 'POST',
        headers: {
          'x-refund-fixture-host': '0',
          'content-type': 'application/json',
          ...(phase === 'identity-change' ? { 'x-interborough-expected-identity': 'old' } : {}),
        },
        body: JSON.stringify({ method: procedure, params: {} }),
        tls: { rejectUnauthorized: false },
      }).then(
        (result) => result.status,
        () => 'rejected',
      );
      await entered.promise;
      proxy.setPhase(phase);
      release.resolve();
      const response = await pending;
      expect(response).toBe(502);
      const failure = await proxy.drain().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AggregateError);
      const errors = (failure as AggregateError).errors as Error[];
      expect(JSON.parse(errors[0]!.message)).toMatchObject({
        host: '0',
        method: 'POST',
        path: '/jsonrpc',
        procedure,
        phase,
        ingressAborted: false,
      });
      expect(errors[0]!.cause).toBeDefined();
      expect(proxy.cancellations).toHaveLength(0);
    } finally {
      release.resolve();
      await proxy.close();
      await upstream.stop(true);
      removeTemporaryPath(directory);
    }
  });
  it(
    format('keeps an upstream failure fatal during %s when the ingress was not aborted', phase),
    () => rethrow(scenario5),
  );
}
