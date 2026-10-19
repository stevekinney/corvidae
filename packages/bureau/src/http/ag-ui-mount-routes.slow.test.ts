/**
 * COR-855 — a start retried after the Bureau restarted replays a run that failed as that failure.
 *
 * The replay waits, on the mount's real clock, for the session to record the failed run's end
 * before it sends the conversation as it stands (`PEER_SESSION_SETTLE_GRACE_MS`, two seconds), so
 * this is slow by nature and lives in the `test:slow` lane (COR-1576). The rest of the mount's
 * routes are in `ag-ui-mount-routes.test.ts`.
 */
import { EventType } from '@ag-ui/core';
import { describe, expect, it } from 'bun:test';

import {
  type Harness,
  openHarness,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import { readAgUiStream, typesOf } from './ag-ui-stream.test-support.ts';

async function withHarness<T>(
  options: Parameters<typeof openHarness>[0],
  body: (harness: Harness) => Promise<T>,
): Promise<T> {
  const harness = await openHarness(options);
  try {
    return await body(harness);
  } finally {
    await harness.dispose();
  }
}

describe('a start retried after the Bureau restarted', () => {
  it('replays the failure of a run that failed, not an invented success', async () => {
    await withHarness(
      { script: [{ kind: 'fail', error: new Error('provider said no') }], storage: 'sqlite' },
      async (harness) => {
        await readAgUiStream(await harness.handler(startRequest(runAgentInput())));
        const restarted = await harness.restart([]);
        try {
          const retry = await readAgUiStream(
            await restarted.handler(startRequest(runAgentInput())),
          );

          expect(retry.at(-1)!.event).toMatchObject({
            type: EventType.RUN_ERROR,
            message: expect.stringContaining('provider said no'),
          });
          expect(typesOf(retry)).not.toContain(EventType.RUN_FINISHED);
        } finally {
          await restarted.dispose();
        }
      },
    );
  });
});
