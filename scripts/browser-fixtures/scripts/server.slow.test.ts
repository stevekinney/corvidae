import { waitUntil } from '@lostgradient/testing/wait-until';
import { expect, test } from 'bun:test';
import { controlledBuild, developmentHost } from './server.test-support.ts';

/** Settle a request as a value, so a socket that closes under it is data rather than a throw. */
function outcomeOf(request: Promise<Response>) {
  return request.then(
    (response) => ({ response }),
    (error: unknown) => ({ error }),
  );
}

/**
 * COR-2682: Bun closes a socket that has produced no bytes for its idle timeout, ten seconds by
 * default, and a request waiting for a development rebuild produces none. The Chromium sweep saw
 * seventeen `net::ERR_EMPTY_RESPONSE` navigations that way.
 *
 * The test needs no timer of its own. A server on Bun's default timeout that never answers is the clock:
 * once it has reset its own request, the default idle timeout has demonstrably elapsed for a
 * request that began after the fixture host's, so the fixture host's request has outlived it too,
 * or been reset itself. Only then does the build resolve. The test takes the idle timeout to run.
 */
test('a request waiting for a rebuild outlives the default idle timeout', async () => {
  const build = controlledBuild();
  let waiting = 0;
  const host = await developmentHost(() => {
    waiting += 1;
    return build.promise;
  });
  const silent = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    // Bun's default, written out: left implicit, Bun warns each time it closes a socket.
    idleTimeout: 10,
    fetch: () => new Promise<Response>(() => {}),
  });
  try {
    const held = outcomeOf(host.request());
    await waitUntil(() => waiting === 1, { message: 'the request reached the rebuild wait' });
    const reference = await outcomeOf(fetch(silent.url));
    expect('error' in reference, 'a server on the default idle timeout closes its socket').toBe(
      true,
    );

    build.release();
    const outcome = await held;
    expect('error' in outcome ? String(outcome.error) : 'answered').toBe('answered');
    if ('response' in outcome) {
      expect(outcome.response.status).toBe(200);
      expect(await outcome.response.text()).toContain('.fixture');
    }
  } finally {
    build.release();
    await silent.stop(true);
    await host.close();
  }
});
