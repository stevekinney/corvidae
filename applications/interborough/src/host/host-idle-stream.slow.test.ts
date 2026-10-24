/**
 * A stream that is quiet for longer than Bun's default idle timeout (10 seconds) is not cut by the
 * host (COR-1643). A cut stream ends without its terminating chunk, and Chromium logs
 * `ERR_INCOMPLETE_CHUNKED_ENCODING` for it. The engine's event feed pings every 15 seconds, so the
 * page's feed is quiet past the default, and this waits on real elapsed time: it lives in the
 * `test:slow` lane.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';

/** Longer than Bun's default idle timeout, shorter than the feed's first ping. */
const QUIET_FOR_MILLISECONDS = 12_000;

const homes: string[] = [];
const hosts: Host[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

test('the engine event feed stays open through a quiet stretch', async () => {
  const home = await mkdtemp(join(tmpdir(), 'interborough-idle-'));
  homes.push(home);
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0, seed: false });
  hosts.push(host);

  const controller = new AbortController();
  const response = await fetch(new URL('/v1/events/sse', host.url), {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('The event feed has no body.');

  // The stream ends here only if the host closed it: this test aborts it, and nothing else should.
  let endedByTheHost = false;
  const drain = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          endedByTheHost = true;
          return;
        }
      }
    } catch {
      endedByTheHost = !controller.signal.aborted;
    }
  })();

  await Bun.sleep(QUIET_FOR_MILLISECONDS);
  expect(endedByTheHost).toBe(false);
  controller.abort();
  await drain;
}, 30_000);
