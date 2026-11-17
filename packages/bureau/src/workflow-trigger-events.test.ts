/**
 * COR-2250 — the trigger events through a Bureau, on its feed: a listener that started, one that
 * failed, a fire of a listener's `start` and a fire of a `receive` that the file's `inputSchema`
 * refuses. A canary is planted in the failing `start`'s message, in the refused payload and in the
 * idempotency key, and appears in no envelope the feed holds (the rule of
 * `run-error-no-free-text.test.ts`: a pushed event carries no free text).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  definePlugin,
  defineTrigger,
  type PluginTriggerContext,
} from '@lostgradient/interborough-plugin';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { z } from 'zod';

import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';

const CANARY = {
  start: 'CANARY-START-3c1d',
  payload: 'CANARY-PAYLOAD-8e2a',
  key: 'CANARY-KEY-5b7f',
} as const;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

interface Envelope {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

/** A plugin `x` with `x:watch` (a `start` that throws for the account `bad`) and `x:hook` (a `receive`). */
function triggerPlugin() {
  const contexts: PluginTriggerContext[] = [];
  const descriptor = definePlugin({
    name: 'x',
    version: '1.0.0',
    description: 'Fires triggers.',
    setup: () => ({
      triggers: [
        defineTrigger({
          name: 'watch',
          description: 'Watches.',
          configuration: z.object({ account: z.string() }),
          start: async (context) => {
            if (context.configuration.account === 'bad') {
              throw new Error(`the source refused ${CANARY.start}`);
            }
            contexts.push(context);
            return () => undefined;
          },
        }),
        defineTrigger({
          name: 'hook',
          description: 'Receives.',
          configuration: z.object({}),
          receive: async (_request, context) => {
            await context
              .fire({ n: CANARY.payload }, { idempotencyKey: CANARY.key })
              .catch(() => undefined);
            return new Response(null, { status: 202 });
          },
        }),
      ],
    }),
  });
  return {
    entry: { descriptor, source: 'package' as const, location: '@example/x' },
    contexts,
  };
}

/** The `inputSchema` every file here has: `n` is a number, so a string payload is refused. */
const NUMBER_INPUT = {
  inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
};

async function everyEnvelope(harness: WorkflowBureauHarness): Promise<Envelope[]> {
  const found: Envelope[] = [];
  for await (const envelope of harness.bureau.internals.eventFeed.feed.replay()) {
    found.push(envelope);
  }
  return found;
}

describe('the trigger events on a Bureau’s feed (COR-2250)', () => {
  it('publishes started, failed and refused fires of a start and of a receive, with no free text', async () => {
    const plugin = triggerPlugin();
    const harness = await startWorkflowBureau({
      overrides: { plugins: [plugin.entry], onDiagnostic: () => undefined },
    });
    cleanups.push(() => harness.dispose());
    await harness.put(
      'good.json',
      workflowFileText('good', { trigger: { kind: 'x:watch', account: 'ok' }, ...NUMBER_INPUT }),
    );
    await harness.put(
      'bad.json',
      workflowFileText('bad', { trigger: { kind: 'x:watch', account: 'bad' }, ...NUMBER_INPUT }),
    );
    await harness.put(
      'hooked.json',
      workflowFileText('hooked', { trigger: { kind: 'x:hook' }, ...NUMBER_INPUT }),
    );
    await harness.bureau.workflows?.refresh();
    await waitUntil(() => plugin.contexts.length === 1, { message: 'the good listener' });

    const refused = await plugin.contexts[0]!.fire(
      { n: CANARY.payload },
      { idempotencyKey: CANARY.key },
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    const answer = await harness.bureau.workflows!.receiveTrigger(
      'hooked',
      new Request('http://127.0.0.1/triggers/hooked', { method: 'POST' }),
    );
    expect(answer.status).toBe(202);

    let feed: Envelope[] = [];
    await waitUntil(
      async () => {
        feed = await everyEnvelope(harness);
        return feed.filter((envelope) => envelope.kind === 'trigger.fired').length === 2;
      },
      { message: 'both fires on the feed' },
    );
    const triggers = feed
      .filter((envelope) => envelope.kind.startsWith('trigger.'))
      .map(({ kind, payload }) => ({ kind, payload }));
    expect(triggers).toContainEqual({
      kind: 'trigger.started',
      payload: { workflowId: 'good', trigger: 'x:watch', version: '1.0.0' },
    });
    expect(triggers).toContainEqual({
      kind: 'trigger.started',
      payload: { workflowId: 'hooked', trigger: 'x:hook', version: '1.0.0' },
    });
    expect(triggers).toContainEqual({
      kind: 'trigger.failed',
      payload: {
        workflowId: 'bad',
        trigger: 'x:watch',
        version: '1.0.0',
        errorCode: 'START_FAILED',
      },
    });
    for (const workflowId of ['good', 'hooked']) {
      expect(triggers).toContainEqual({
        kind: 'trigger.fired',
        payload: {
          workflowId,
          trigger: workflowId === 'good' ? 'x:watch' : 'x:hook',
          version: '1.0.0',
          outcome: 'refused',
          errorCode: 'INPUT_INVALID',
        },
      });
    }
    const published = JSON.stringify(feed);
    for (const canary of Object.values(CANARY)) expect(published).not.toContain(canary);
  });
});
