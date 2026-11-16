/**
 * COR-2199, Revision 2026-11-16 — a pushed event carries no scorer-supplied free text. A canary is
 * planted in a `fail` verdict's message, in the message of an error a scorer throws, and in the
 * message of a scorer-returned `error` whose score still breaches its threshold. It appears in no
 * body a webhook receives, no delivery record the Bureau keeps, no envelope the event feed holds
 * and no diagnostic, and it IS on the `eval.sample.recorded` audit record, read through the audit
 * trail. An alert carries `judgeName`, `judgeVersion`, `judgeDigest`, `outcome`, `score` and
 * `threshold`, with the run id beside them.
 */
import { createAgent, stopWhen } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';
import { createReceiver, deliveriesOf, newEncryptionKey } from './hooks/hooks.test-support';

const CANARY = {
  fail: 'CANARY-FAIL-3c9e',
  thrown: 'CANARY-THROWN-b71d',
  error: 'CANARY-ERROR-52fa',
} as const;
const CANARIES = Object.values(CANARY);

const bureaus: Bureau<AgentDefinitions>[] = [];
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

describe('a scorer’s text stays on the audit record (COR-2199)', () => {
  it('reaches no webhook body, delivery record, feed envelope or diagnostic', async () => {
    const receiver = createReceiver();
    const diagnostics: unknown[] = [];
    const bureau = await createBureau<AgentDefinitions>({
      id: 'scorer-canary-bureau',
      agents: {
        default: createAgent({
          name: 'default',
          generate: async () => ({ content: 'done', toolCalls: [] }),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: new MemoryStorage(),
      durable: false,
      answerEncryption: { current: await newEncryptionKey() },
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
      hooks: {},
      webhooks: {
        targets: [{ url: 'https://receiver.example/eval', events: ['eval.threshold-breached'] }],
        fetch: receiver.fetch,
        sleep: () => Promise.resolve(),
      },
      scorers: {
        list: [
          {
            name: 'verdict',
            version: '1.0.0',
            score: () => ({ outcome: 'fail', message: `did not match ${CANARY.fail}`, score: 0.9 }),
          },
          {
            name: 'thrower',
            version: '1.0.0',
            score: () => {
              throw new Error(`provider failed ${CANARY.thrown}`);
            },
          },
          {
            name: 'low-error',
            version: '1.0.0',
            alertThreshold: 0.5,
            score: () => ({ outcome: 'error', message: `broke ${CANARY.error}`, score: 0.1 }),
          },
        ],
        sampleRate: 1,
        rng: () => 0,
      },
    });
    bureaus.push(bureau);
    const hook = await bureau.hooks!.create({
      action: { type: 'webhook', url: 'https://receiver.example/hook' },
      events: ['action', 'run.registered', 'run.error', 'run.settled', 'run.completed'],
    });

    const started = await bureau.tasks.start('default', 'go', { principal: 'api-key:alice' });
    await waitUntil(
      async () => {
        const task = await bureau.tasks.get(started.id);
        return task?.status === 'completed';
      },
      { message: 'the run completed' },
    );
    const sampler = bureau.internals.scorerSampler!;
    await waitUntil(() => sampler.sampledCount() === 1, { message: 'the run was sampled' });
    await sampler.flush();
    await bureau.internals.webhookNotifier!.flush();
    await bureau.internals.taskRegistry.flush();

    // Two scorers breach: the `fail`, and the `error` whose score is below its threshold.
    const alerts = receiver.calls
      .filter((call) => call.url === 'https://receiver.example/eval')
      .map((call) => JSON.parse(call.body) as { trigger: string; runId: string; detail: object });
    expect(alerts.map((alert) => (alert.detail as Record<string, unknown>)['judgeName'])).toEqual([
      'verdict',
      'low-error',
    ]);
    const identity = ['judgeDigest', 'judgeName', 'judgeVersion', 'outcome', 'score'];
    for (const alert of alerts) {
      expect(alert.trigger).toBe('eval.threshold-breached');
      expect(alert.runId).toBe(started.id);
      // Only the scorer with a threshold carries one.
      const threshold = (alert.detail as Record<string, unknown>)['judgeName'] === 'low-error';
      expect(Object.keys(alert.detail).toSorted()).toEqual(
        (threshold ? [...identity, 'threshold'] : identity).toSorted(),
      );
    }

    // No webhook body (the alerts and the hook's), no delivery record, no envelope, no diagnostic.
    const sent = receiver.calls.map((call) => call.body).join('\n');
    const kept = JSON.stringify([
      await bureau.internals.webhookNotifier!.listDeliveries(),
      await deliveriesOf(bureau, hook.id),
    ]);
    const envelopes: unknown[] = [];
    for await (const envelope of bureau.internals.eventFeed.feed.replay()) envelopes.push(envelope);
    const published = JSON.stringify(envelopes);
    const diagnosed = JSON.stringify(diagnostics);
    expect(envelopes.length).toBeGreaterThan(0);
    for (const canary of CANARIES) {
      expect(sent).not.toContain(canary);
      expect(kept).not.toContain(canary);
      expect(published).not.toContain(canary);
      expect(diagnosed).not.toContain(canary);
    }

    // The text is on the audit record, read back through the audit trail.
    const recorded = await bureau.internals.auditTrail!.query({
      runId: started.id,
      type: 'eval.sample.recorded',
    });
    const messages = recorded.map(
      (record) => (record.detail as Record<string, unknown>)['message'] as string,
    );
    expect(messages).toEqual([
      `did not match ${CANARY.fail}`,
      `Judge threw: provider failed ${CANARY.thrown}`,
      `broke ${CANARY.error}`,
    ]);
  });
});
