/**
 * COR-2204 — the run rule for the plugin-facing decision path: no pushed event, webhook or response
 * carries free error text, and a failure is an enum or an identifier matching
 * `^[A-Z][A-Z0-9_]{0,63}$` (`published-error-names.ts`; the canary of `run-error-no-free-text.test.ts`
 * and `scorer-no-free-text.test.ts`). A canary is planted in the message of the error a decision
 * model throws, and in its code. A plugin's decision scorer and its goal validator both ask that
 * model and both fail. The message appears on no record, event or response; the code, which is
 * free text on purpose, is on the `decision.made` audit record read through the audit trail and on
 * nothing the Bureau pushes or returns over `bureau.audit.query`. A scorer's recorded message and a
 * validator error's code are fixed identifiers, so what is read back from them is no provider text.
 */
import * as pluginPackage from '@lostgradient/interborough-plugin';
import { createAgent, stopWhen } from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { formatToolId } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import { failingModel } from './testing/decision-harness.test-support.ts';
import { disposePluginBureaus, openPluginBureau } from './testing/plugin-decisions.test-support.ts';
import {
  answering,
  goalRequest,
  pollUntil,
  TERMINAL_STATUSES,
  workerAgent,
} from './testing/goal-fixtures.test-support.ts';

afterEach(disposePluginBureaus);

const CANARY = { message: 'CANARY-MESSAGE-4e1a', code: 'CANARY-CODE-77bd' } as const;
const IDENTIFIER = /^[A-Z][A-Z0-9_]{0,63}$/;

describe('a plugin’s failed decision leaves no free text on anything pushed (COR-2204)', () => {
  it('keeps the model’s message off every record and the model’s code off everything pushed', async () => {
    const diagnostics: unknown[] = [];
    const thrown = Object.assign(new Error(`provider said ${CANARY.message}`), {
      code: `key ${CANARY.code} rejected`,
    });
    const opened = await openPluginBureau({
      contributions: (host) => ({
        scorers: [
          pluginPackage.decisionScorer(host.decisions, {
            name: 'judge',
            version: '1',
            question: { kind: 'boolean', question: 'Is it acceptable?' },
            verdict: () => ({ outcome: 'pass', message: 'ok' }),
            alertThreshold: 0.5,
          }),
        ],
        validators: [
          pluginPackage.decisionValidator(host.decisions, {
            name: 'judge',
            version: '1',
            request: () => ({ kind: 'boolean', question: 'Is it acceptable?' }),
            verdict: () => ({ kind: 'pass', evidence: [] }),
          }),
        ],
      }),
      bureau: {
        durable: true,
        agents: {
          default: createAgent({
            name: 'default',
            generate: async () => ({ content: 'done', toolCalls: [] }),
            stopWhen: stopWhen.noToolCalls(),
          }),
          worker: workerAgent(answering('an answer')),
        },
        scorers: { list: [], sampleRate: 1, rng: () => 0 },
        decisions: { models: { m: failingModel(thrown) }, model: 'm' },
        onDiagnostic: (diagnostic: unknown) => {
          diagnostics.push(diagnostic);
        },
      },
    });
    const { bureau } = opened;
    const dispatched: unknown[] = [];
    for (const type of ['decision.made', 'goal.failed', 'scorer.recorded']) {
      bureau.addEventListener(type, (event: Event) => {
        dispatched.push({ type, event: JSON.stringify(event) });
      });
    }

    const started = await bureau.tasks.start('default', 'go', { principal: 'api-key:alice' });
    await waitUntil(
      async () => {
        const task = await bureau.tasks.get(started.id);
        return task?.status === 'completed';
      },
      { message: 'the run completes' },
    );
    await bureau.internals.taskRegistry.flush();
    await bureau.internals.scorerSampler!.flush();
    await bureau.goals.create(
      goalRequest({
        validator: { name: formatToolId({ namespace: 'demo', name: 'judge' }), version: '1' },
      }),
    );
    await pollUntil(async () => {
      const goal = await bureau.goals.get('g1');
      return (TERMINAL_STATUSES as readonly string[]).includes(goal?.status ?? '');
    });

    const envelopes: { kind: string; payload: Record<string, unknown> }[] = [];
    for await (const envelope of bureau.internals.eventFeed.feed.replay()) envelopes.push(envelope);
    expect(envelopes.length).toBeGreaterThan(0);

    // The goal failed on its validator, and what the feed pushes of that is a kind and an identifier.
    const failed = envelopes.find((envelope) => envelope.kind === 'goal.failed');
    expect(failed?.payload['terminalReason']).toBe('validator-infrastructure-error');
    const validatorError = failed?.payload['validatorError'] as { kind: string; code: string };
    expect(validatorError.kind).toBe('execute');
    expect(validatorError.code).toMatch(IDENTIFIER);

    const read = [
      await bureau.audit.query({ type: 'decision.made', limit: 100 }),
      await bureau.audit.query({ type: 'scorer.recorded', limit: 100 }),
    ];
    const goal = await bureau.goals.get('g1');
    const pushed = JSON.stringify([envelopes, dispatched, diagnostics, read, goal]);
    for (const canary of Object.values(CANARY)) expect(pushed).not.toContain(canary);

    // The scorer's recorded message is fixed text naming an identifier.
    const [score] = await bureau.internals.auditTrail!.query({ type: 'scorer.recorded' });
    const scoreDetail = score?.detail as Record<string, unknown>;
    expect(scoreDetail['outcome']).toBe('error');
    expect(String(scoreDetail['message'])).toMatch(/^Decision failed: [A-Z][A-Z0-9_]{0,63}$/);

    // The audit trail holds the code verbatim on the decision's own record, and never the message.
    const trail = JSON.stringify(
      await bureau.internals.auditTrail!.query({ type: 'decision.made' }),
    );
    expect(trail).toContain(CANARY.code);
    expect(trail).not.toContain(CANARY.message);
    expect(
      JSON.stringify(await bureau.internals.auditTrail!.query({ type: 'scorer.recorded' })),
    ).not.toContain(CANARY.message);
  });
});
