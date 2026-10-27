/**
 * The Engine console serves the Bureau's own durable engine, not a second engine over the same
 * storage. A second engine holds no lease on the Bureau's runs, so a cancel through it would not be
 * fenced by their owner and its live feed would never see them. Both are proven through the public
 * origin, the way the console reaches them.
 */
import { HttpClient } from '@lostgradient/weft';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';

const homes: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** A host whose runs stay in flight until `release()`. */
async function startWithRunInFlight() {
  const home = await mkdtemp(join(tmpdir(), 'interborough-engine-'));
  homes.push(home);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    seed: false,
    generate: async () => {
      started.resolve();
      await release.promise;
      return { content: 'finished', toolCalls: [] };
    },
  });
  hosts.push(host);
  return { host, started: started.promise, release: release.resolve };
}

/** Read the fleet feed until `seen` holds `text`, returning what arrived. */
async function readFeedUntil(host: Host, text: () => string | undefined) {
  const controller = new AbortController();
  const response = await fetch(new URL('/v1/events/sse', host.url), { signal: controller.signal });
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('Expected a streaming feed.');
  let received = '';
  const decoder = new TextDecoder();
  const done = (async () => {
    for (;;) {
      const needle = text();
      if (needle !== undefined && received.includes(needle)) return received;
      const chunk = await reader.read();
      if (chunk.done) return received;
      received += decoder.decode(chunk.value, { stream: true });
    }
  })();
  return { done, close: () => controller.abort() };
}

describe('the Engine console', () => {
  test('serves the engine the Bureau composed', async () => {
    const { host } = await startWithRunInFlight();

    expect(host.engine).toBe(host.bureau.durableEngine() as typeof host.engine);
  });

  test('sees a run the Bureau started, in its live feed', async () => {
    const { host, started, release } = await startWithRunInFlight();
    let runId: string | undefined;
    const feed = await readFeedUntil(host, () => runId);

    const run = await host.bureau.createRun({ agentName: 'assistant', message: 'watch me' });
    runId = run.id;
    await started;
    const received = await feed.done;
    feed.close();
    release();

    expect(received).toContain(run.id);
  });

  test('cancels a run the Bureau started through its own ownership', async () => {
    const { host, started, release } = await startWithRunInFlight();
    const run = await host.bureau.createRun({ agentName: 'assistant', message: 'cancel me' });
    await started;

    await new HttpClient({ baseUrl: host.url.origin }).cancel(run.id);

    // The Bureau's own live run is torn down, not merely marked cancelled in storage.
    const state = await host.bureau.tasks.wait(run.id);
    release();
    expect(state?.status).toBe('cancelled');
    expect(host.bureau.tasks.detail(run.id)?.status).toBe('aborted');
  });
});
