/**
 * COR-2204 — a plugin scorer that asks a decision, end to end, against the outcome matrix
 * (`tmp/chef/briefs/COR-2204-matrix.md`). One table, one entry per matrix row, each titled with its
 * row number and the matrix's source column. Each row opens a real Bureau that loads a plugin whose
 * scorer holds the host the plugin was given, runs one agent task, and reads what the trail and the
 * event feed recorded.
 *
 * Every decision model is a double, and nothing waits on a clock: a held model settles when the
 * test releases it, and a wait goes through `waitUntil` or the sampler's `flush`.
 */
import * as pluginPackage from '@lostgradient/interborough-plugin';
import type { PluginHost, PluginScorer } from '@lostgradient/interborough-plugin';
import { type BackendDescriptor, createAgent, stopWhen } from '@lostgradient/operative';
import { createMockGenerate } from '@lostgradient/operative/testing';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import { projectBureauEvent } from './bureau-event-feed';
import { scorerBudgetKey } from './scorers';
import {
  FALLBACK_ROW,
  heldModel,
  type MatrixRow,
  scriptedModel,
} from './testing/decision-harness.test-support.ts';
import {
  disposePluginBureaus,
  openPluginBureau,
  type PluginBureau,
  type PluginBureauOptions,
} from './testing/plugin-decisions.test-support.ts';

afterEach(disposePluginBureaus);

const QUESTION = { kind: 'boolean', question: 'Is the reply acceptable?' } as const;
const passOrFail = (decision: { value: unknown }) =>
  decision.value === true
    ? ({ outcome: 'pass', message: 'ok', score: 1 } as const)
    : ({ outcome: 'fail', message: 'no', score: 0 } as const);

const worker = createAgent({
  name: 'default',
  generate: async () => ({ content: 'the final reply', toolCalls: [] }),
  stopWhen: stopWhen.noToolCalls(),
});

/** A Bureau with plugin `demo` whose scorers are built from its host, sampling every run. */
function openScoring(
  scorers: (host: PluginHost) => PluginScorer[],
  options: Omit<PluginBureauOptions, 'contributions'> = {},
): Promise<PluginBureau> {
  return openPluginBureau({
    ...options,
    contributions: (host) => ({ scorers: scorers(host) }),
    bureau: {
      agents: { default: worker },
      scorers: { list: [], sampleRate: 1, rng: () => 0 },
      ...options.bureau,
    },
  });
}

/** Runs one task to completion and waits until its scoring has settled. */
async function finishRun(opened: PluginBureau): Promise<string> {
  const { bureau } = opened;
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
  return started.id;
}

async function scoreRecords(opened: PluginBureau) {
  const records = await opened.bureau.internals.auditTrail!.query({ type: 'scorer.recorded' });
  return records.map((record) => ({
    runId: record.runId,
    detail: record.detail as Record<string, unknown>,
  }));
}

/**
 * A scorer that asks two decisions under a daily budget of one unit, after one run has been scored.
 * `counts` reads what the Bureau's store holds as today's count: the scorer's one reservation, and
 * nothing for either decision. The day is read before and after the run, so a run that crosses
 * midnight still finds its key.
 */
async function spendTheDailyBudget() {
  const asked = scriptedModel(true);
  const storage = new MemoryStorage();
  const opened = await openScoring(
    (host) => [
      {
        name: 'double',
        version: '1',
        score: async (_run, _signal, context) => {
          await host.decisions.decide(QUESTION, { taskId: context.runId });
          await host.decisions.decide(QUESTION, { taskId: context.runId });
          return { outcome: 'pass', message: 'ok' };
        },
      },
    ],
    { bureau: { storage, decisions: { models: { m: asked.model }, model: 'm' } } },
  );
  const { revision } = await opened.bureau.settings.get();
  await opened.bureau.settings.update(
    { 'scorers.sampleRate': 1, 'scorers.dailyBudget': 1 },
    { expectedRevision: revision },
  );
  const before = new Date().toISOString().slice(0, 10);
  await finishRun(opened);
  const after = new Date().toISOString().slice(0, 10);
  const counts = async () => {
    const held = await Promise.all(
      [...new Set([before, after])].map((day) => textValueStore(storage).get(scorerBudgetKey(day))),
    );
    return held.filter((count): count is string => count !== null && count !== undefined);
  };
  return { asked, opened, counts };
}

/** The detail of the first `scorer.recorded` record. */
async function firstScore(opened: PluginBureau) {
  const [score] = await scoreRecords(opened);
  return score?.detail;
}

/** The `context` the first question a model double was asked carried. */
function contextOf(calls: readonly { request: { context?: string } }[]): string | undefined {
  const [first] = calls;
  return first?.request.context;
}

function decisionsOf(value: unknown) {
  return { models: { m: scriptedModel(value).model }, model: 'm' };
}

const ROWS: readonly MatrixRow[] = [
  {
    row: 70,
    source: 'AC4, Rev',
    title:
      'AC4: a sampled run’s decisionScorer sends only the final reply to the decision model, durably or not',
    async run() {
      for (const durable of [false, true]) {
        const asked = scriptedModel(true);
        const opened = await openScoring(
          (host) => [
            pluginPackage.decisionScorer(host.decisions, {
              name: 'judge',
              version: '1',
              question: QUESTION,
              verdict: passOrFail,
            }),
          ],
          { bureau: { durable, decisions: { models: { m: asked.model }, model: 'm' } } },
        );
        await finishRun(opened);
        expect(contextOf(asked.calls)).toBe('the final reply');
        expect(await firstScore(opened)).toMatchObject({ outcome: 'pass' });
      }
    },
  },
  {
    row: 71,
    source: 'AC4, Rev',
    title: 'AC4: content transcript sends the run’s conversation, durably or not',
    async run() {
      for (const durable of [false, true]) {
        const asked = scriptedModel(true);
        const opened = await openScoring(
          (host) => [
            pluginPackage.decisionScorer(host.decisions, {
              name: 'judge',
              version: '1',
              question: QUESTION,
              verdict: passOrFail,
              content: 'transcript',
            }),
          ],
          { bureau: { durable, decisions: { models: { m: asked.model }, model: 'm' } } },
        );
        await finishRun(opened);
        const context = contextOf(asked.calls) ?? '';
        // The prompt the task was started with, and the reply, are both in the transcript.
        expect(context).toContain('go');
        expect(context).toContain('the final reply');
        expect(await firstScore(opened)).toMatchObject({ outcome: 'pass' });
      }
    },
  },
  {
    row: 22,
    source: 'Rev, AC2',
    title:
      'AC2: requireKinds boolean over a model lacking boolean records unavailable and makes no fallback call',
    async run() {
      const choiceOnly = scriptedModel('a', { kinds: new Set(['choice']) });
      const generated: string[] = [];
      const reply = createMockGenerate([{ content: '{"answer":true}', toolCalls: [] }]);
      const opened = await openScoring(
        (host) => [
          pluginPackage.decisionScorer(host.decisions, {
            name: 'judge',
            version: '1',
            question: QUESTION,
            verdict: passOrFail,
            requireKinds: ['boolean'],
          }),
        ],
        {
          bureau: {
            decisions: { models: { m: choiceOnly.model }, model: 'm' },
            models: {
              catalog: [FALLBACK_ROW],
              generate: (descriptor: BackendDescriptor) => {
                generated.push(`${descriptor.provider}/${descriptor.model}`);
                return reply;
              },
            },
          },
        },
      );
      await finishRun(opened);
      const [score] = await scoreRecords(opened);
      expect(score?.detail).toMatchObject({ outcome: 'unavailable' });
      expect(choiceOnly.calls).toHaveLength(0);
      expect(generated).toEqual([]);
      const refusals = await opened.records();
      expect(refusals.map((record) => record.detail)).toEqual([
        expect.objectContaining({ outcome: 'refused', reason: 'NOT_CONFIGURED' }),
      ]);
    },
  },
  {
    row: 48,
    source: 'main, brief',
    title:
      'a scorer’s decision at Bureau shutdown receives the scorer’s signal, which the shutdown aborts',
    async run() {
      const held = heldModel({ honorSignal: true });
      const opened = await openScoring(
        (host) => [
          pluginPackage.decisionScorer(host.decisions, {
            name: 'judge',
            version: '1',
            question: QUESTION,
            verdict: passOrFail,
          }),
        ],
        { bureau: { decisions: { models: { m: held.model }, model: 'm' } } },
      );
      const { bureau } = opened;
      const started = await bureau.tasks.start('default', 'go', { principal: 'api-key:alice' });
      await waitUntil(() => held.calls.length === 1, { message: 'the scorer’s decision is asked' });
      expect(held.calls[0]?.signal?.aborted).toBe(false);
      await bureau.dispose();
      expect(held.calls[0]?.signal?.aborted).toBe(true);
      expect(started.id).toBeDefined();
      held.release();
    },
  },
  {
    row: 51,
    source: 'O4',
    title:
      'two decisions in one scorer spend the scorer’s one budget unit: both are recorded, the count stays 1',
    async run() {
      const { asked, opened, counts } = await spendTheDailyBudget();
      expect(asked.calls).toHaveLength(2);
      expect(await opened.records()).toHaveLength(2);
      expect(await counts()).toEqual(['1']);
    },
  },
  {
    row: 52,
    source: 'main',
    title: 'at the daily cap the next run’s scorer is not invoked, so its decisions are never made',
    async run() {
      const { asked, opened } = await spendTheDailyBudget();
      await finishRun(opened);
      expect(asked.calls).toHaveLength(2);
      expect(await opened.records()).toHaveLength(2);
      expect(await scoreRecords(opened)).toHaveLength(1);
    },
  },
  {
    row: 55,
    source: 'O4',
    title: 'a decision outside a scorer spends no budget unit',
    async run() {
      const asked = scriptedModel(true);
      const opened = await openScoring(
        (host) => [
          pluginPackage.decisionScorer(host.decisions, {
            name: 'judge',
            version: '1',
            question: QUESTION,
            verdict: passOrFail,
          }),
        ],
        { bureau: { decisions: { models: { m: asked.model }, model: 'm' } } },
      );
      const { revision } = await opened.bureau.settings.get();
      await opened.bureau.settings.update(
        { 'scorers.sampleRate': 1, 'scorers.dailyBudget': 1 },
        { expectedRevision: revision },
      );
      for (let call = 0; call < 3; call += 1) {
        await opened.startHost().decisions.decide(QUESTION, { taskId: 'task-1' });
      }
      // The one unit is still there for a scorer: the run is scored.
      await finishRun(opened);
      expect(await scoreRecords(opened)).toHaveLength(1);
    },
  },
  {
    row: 61,
    source: 'main',
    title:
      'a needs-setup plugin’s decision scorer is refused by the gate before the helper runs: unavailable, no decision',
    async run() {
      const asked = scriptedModel(true);
      const opened = await openScoring(
        (host) => [
          pluginPackage.decisionScorer(host.decisions, {
            name: 'judge',
            version: '1',
            question: QUESTION,
            verdict: passOrFail,
          }),
        ],
        {
          secret: 'DEMO_KEY',
          pluginSecrets: { get: async () => undefined, watch: () => () => undefined },
          bureau: { decisions: { models: { m: asked.model }, model: 'm' } },
        },
      );
      await finishRun(opened);
      expect(await firstScore(opened)).toMatchObject({ outcome: 'unavailable' });
      expect(asked.calls).toHaveLength(0);
      expect(await opened.records()).toEqual([]);
    },
  },
  {
    row: 62,
    source: 'AC1, Rev',
    title:
      'AC1: a plugin scorer that calls host.decisions.decide with taskId context.runId writes a decision.made record under the run',
    async run() {
      const asked = scriptedModel(true);
      const opened = await openScoring(
        (host) => [
          {
            name: 'judge',
            version: '1',
            score: async (_run, _signal, context) => {
              await host.decisions.decide(QUESTION, { taskId: context.runId });
              return { outcome: 'pass', message: 'ok' };
            },
          },
        ],
        { bureau: { decisions: { models: { m: asked.model }, model: 'm' } } },
      );
      const runId = await finishRun(opened);
      const [score] = await scoreRecords(opened);
      const [record] = await opened.records();
      expect(score?.runId).toBeDefined();
      expect(record?.runId).toBe(score?.runId ?? 'missing');
      expect(record?.runId).toBe(runId);
      expect(record?.principal).toBe('plugin:demo');
      expect(record?.detail).toMatchObject({ kind: 'boolean', outcome: 'answered' });
      expect(opened.events.map((event) => event.taskId)).toEqual([runId]);
    },
  },
  {
    row: 64,
    source: 'O6',
    title: 'scorer.recorded lists the decision a decisionScorer’s answered decision made',
    async run() {
      const opened = await openScoring(
        (host) => [
          pluginPackage.decisionScorer(host.decisions, {
            name: 'judge',
            version: '1',
            question: QUESTION,
            verdict: passOrFail,
          }),
        ],
        { bureau: { decisions: decisionsOf(true) } },
      );
      await finishRun(opened);
      const [score] = await scoreRecords(opened);
      expect(score?.detail['decisions']).toEqual([{ provider: 'hostprov', model: 'host-model' }]);
    },
  },
  {
    row: 65,
    source: 'AC5, brief',
    title: 'AC5: scorer.recorded records determinism stochastic for a scorer built on a decision',
    async run() {
      const opened = await openScoring(
        (host) => [
          pluginPackage.decisionScorer(host.decisions, {
            name: 'judge',
            version: '1',
            question: QUESTION,
            verdict: passOrFail,
          }),
        ],
        { bureau: { decisions: decisionsOf(true) } },
      );
      await finishRun(opened);
      expect(await firstScore(opened)).toMatchObject({
        determinism: 'stochastic',
        outcome: 'pass',
      });
    },
  },
  {
    row: 67,
    source: 'main, run rule',
    title:
      'a breaching decision scorer publishes scorer.threshold-breached with only run, scorer, outcome and score',
    async run() {
      const opened = await openScoring(
        (host) => [
          pluginPackage.decisionScorer(host.decisions, {
            name: 'judge',
            version: '1',
            question: QUESTION,
            verdict: passOrFail,
            alertThreshold: 0.5,
          }),
        ],
        { bureau: { decisions: decisionsOf(false) } },
      );
      const breaches: Event[] = [];
      opened.bureau.addEventListener('scorer.threshold-breached', (event: Event) => {
        breaches.push(event);
      });
      await finishRun(opened);
      expect(breaches).toHaveLength(1);
      const payload = projectBureauEvent(breaches[0])?.payload ?? {};
      expect(Object.keys(payload).toSorted()).toEqual([
        'outcome',
        'runId',
        'score',
        'scorerName',
        'scorerVersion',
      ]);
      expect(payload['outcome']).toBe('fail');
    },
  },
  {
    row: 68,
    source: 'main, O7',
    title:
      'a decision scorer’s message is on scorer.recorded only, and is fixed text, never the provider’s',
    async run() {
      const failing = {
        name: 'failing',
        kinds: scriptedModel(true).model.kinds,
        decide: async () => {
          throw new Error('CANARY-PROVIDER-TEXT');
        },
      };
      const opened = await openScoring(
        (host) => [
          pluginPackage.decisionScorer(host.decisions, {
            name: 'judge',
            version: '1',
            question: QUESTION,
            verdict: passOrFail,
          }),
        ],
        { bureau: { decisions: { models: { m: failing }, model: 'm' } } },
      );
      await finishRun(opened);
      const [score] = await scoreRecords(opened);
      expect(score?.detail).toMatchObject({
        outcome: 'error',
        message: 'Decision failed: UNKNOWN',
      });
      expect(
        JSON.stringify([...(await scoreRecords(opened)), ...(await opened.records())]),
      ).not.toContain('CANARY-PROVIDER-TEXT');
    },
  },
];

describe('COR-2204 decision matrix: a plugin scorer that asks a decision', () => {
  for (const { row, source, title, run } of ROWS) {
    it(`R${row} [${source}] ${title}`, () => run());
  }
});
