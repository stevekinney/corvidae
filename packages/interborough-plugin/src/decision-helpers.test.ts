/**
 * COR-2204 — `decisionScorer` and `decisionValidator`, the helpers that turn a decision into a
 * scorer or a goal validator, against the outcome matrix (`tmp/chef/briefs/COR-2204-matrix.md`).
 * One table, one entry per matrix row this package owns, each titled with its row number and the
 * matrix's source column. The helpers are built over a decision source the test scripts, because
 * this package cannot import Bureau; the rows that need a real Bureau are in the Bureau package.
 *
 * Nothing here calls a model or waits on a clock.
 */
import type { Decision, DecisionRequest, RunResult, ValidatorInput } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';
import { Conversation, conversationToMarkdown } from 'conversationalist/testing';

import { definePlugin } from './define-plugin.ts';
import type { PluginHost } from './host-api.ts';
import * as pluginPackage from './index.ts';
import { pluginContributions } from './testing/plugin-identities.ts';

const IDENTIFIER = /^[A-Z][A-Z0-9_]{0,63}$/;
const CANARY = 'CANARY-sk-live-91f3';

type Decide = PluginHost['decisions']['decide'];

/** A decision source that records what it is asked and answers, or rejects, as the test scripts. */
function source(behaviour: () => Promise<Decision<unknown>> | Decision<unknown>) {
  const asked: { request: DecisionRequest; options: Parameters<Decide>[1] }[] = [];
  const decisions: PluginHost['decisions'] = {
    decide: async (request, options) => {
      asked.push({ request, options });
      return behaviour();
    },
  };
  return { decisions, asked };
}

const answer =
  (value: unknown, extra: Partial<Decision<unknown>> = {}) =>
  (): Decision<unknown> => ({
    value,
    provider: 'hostprov',
    model: 'host-model',
    ...extra,
  });

const rejecting = (error: unknown) => async (): Promise<never> => {
  throw error;
};

function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    conversation: new Conversation(),
    steps: [],
    content: 'the final answer',
    usage: { prompt: 10, completion: 5, total: 15 },
    finishReason: 'stop',
    ...overrides,
  } as RunResult;
}

const QUESTION = { kind: 'boolean', question: 'Is the answer acceptable?' } as const;
const CONTEXT = { runId: 'run-7' } as const;
const passOrFail = (decision: Decision<unknown>) =>
  decision.value === true
    ? ({ outcome: 'pass', message: 'ok', score: 1 } as const)
    : ({ outcome: 'fail', message: 'no', score: 0 } as const);

async function scoreWith(
  behaviour: () => Promise<Decision<unknown>> | Decision<unknown>,
  options: Partial<Parameters<typeof pluginPackage.decisionScorer>[1]> = {},
  run: RunResult = runResult(),
  signal: AbortSignal = new AbortController().signal,
) {
  const { decisions, asked } = source(behaviour);
  const scorer = pluginPackage.decisionScorer(decisions, {
    name: 'judge',
    version: '1',
    question: QUESTION,
    verdict: passOrFail,
    ...options,
  });
  return { scorer, asked, score: await scorer.score(run, signal, CONTEXT) };
}

const validatorInput = (overrides: Partial<ValidatorInput> = {}): ValidatorInput => ({
  goalRunId: 'goal-1',
  attemptId: 'attempt-1',
  attemptIndex: 0,
  result: runResult(),
  history: [],
  ...overrides,
});

async function validateWith(
  behaviour: () => Promise<Decision<unknown>> | Decision<unknown>,
  signal: AbortSignal = new AbortController().signal,
  options: Partial<Parameters<typeof pluginPackage.decisionValidator>[1]> = {},
) {
  const { decisions, asked } = source(behaviour);
  const validator = pluginPackage.decisionValidator(decisions, {
    name: 'judge',
    version: '1',
    request: () => QUESTION,
    verdict: (decision) =>
      decision.value === true
        ? { kind: 'pass', evidence: [] }
        : { kind: 'fail', feedback: 'no', evidence: [], retryable: true },
    ...options,
  });
  return { validator, asked, outcome: await validator.validate(validatorInput(), signal) };
}

async function scoreOf(...args: Parameters<typeof scoreWith>) {
  const { score } = await scoreWith(...args);
  return score;
}

async function outcomeOf(...args: Parameters<typeof validateWith>) {
  const { outcome } = await validateWith(...args);
  return outcome;
}

/** The `context` the first request carried. */
function contextAsked(asked: readonly { request: DecisionRequest }[]): string | undefined {
  const request = asked[0]?.request;
  return request !== undefined && 'context' in request ? request.context : undefined;
}

const aborted = () => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

const notConfigured = () => Object.assign(new Error(`${CANARY} none`), { code: 'NOT_CONFIGURED' });
const policyDenied = () =>
  Object.assign(new Error(`${CANARY} denied`), {
    code: 'model-policy-denied',
    name: 'ModelPolicyDeniedError',
  });
const providerDown = () => Object.assign(new Error(`${CANARY} down`), { code: 'PROVIDER_DOWN' });
const freeTextCode = () => Object.assign(new Error('down'), { code: `key ${CANARY} rejected` });

interface Row {
  readonly row: number;
  readonly source: string;
  readonly title: string;
  readonly run: () => Promise<void> | void;
}

const ROWS: readonly Row[] = [
  {
    row: 3,
    source: 'Rev',
    title:
      'the testing kit’s host gains decisions.decide, rejecting the unstarted message; reading it never throws',
    async run() {
      let held: PluginHost | undefined;
      let built = false;
      await pluginContributions(
        definePlugin({
          name: 'kit',
          version: '1.0.0',
          description: 'Holds the setup host.',
          setup: ({ host }) => {
            held = host;
            // A helper built during `setup` reads `host.decisions` before the host starts.
            pluginPackage.decisionScorer(host.decisions, {
              name: 'judge',
              version: '1',
              question: QUESTION,
              verdict: passOrFail,
            });
            built = true;
            return {};
          },
        }),
      );
      expect(built).toBe(true);
      expect(Object.keys(held!).toSorted()).toEqual([
        'agents',
        'decisions',
        'goals',
        'publish',
        'schedules',
      ]);
      const error = await held!.decisions.decide(QUESTION, { taskId: 'run-1' }).then(
        () => undefined,
        (rejection: unknown) => rejection,
      );
      expect((error as Error).message).toBe(
        'The host has not started: a plugin may call it only after start.',
      );
    },
  },
  {
    row: 64,
    source: 'O6',
    title:
      'an answered decision fills decisions with its provider, model and usage; a rejection lists none',
    async run() {
      const usage = { prompt: 3, completion: 2, total: 5 };
      const { score } = await scoreWith(answer(true, { usage }));
      expect(score.decisions).toEqual([{ provider: 'hostprov', model: 'host-model', usage }]);
      const { score: noUsage } = await scoreWith(answer(true));
      expect(noUsage.decisions).toEqual([{ provider: 'hostprov', model: 'host-model' }]);
      const { score: failed } = await scoreWith(rejecting(providerDown()));
      expect(failed.decisions).toBeUndefined();
    },
  },
  {
    row: 68,
    source: 'main, O7',
    title: 'a failure’s message is fixed text naming a code, never the provider’s message',
    async run() {
      const cases = [
        [notConfigured(), 'Decision unavailable: NOT_CONFIGURED'],
        [policyDenied(), 'Decision unavailable: UNKNOWN'],
        [providerDown(), 'Decision failed: PROVIDER_DOWN'],
        [freeTextCode(), 'Decision failed: UNKNOWN'],
        [new TypeError(CANARY), 'Decision failed: UNKNOWN'],
      ] as const;
      for (const [error, message] of cases) {
        const { score } = await scoreWith(rejecting(error));
        expect(score.message).toBe(message);
        expect(JSON.stringify(score)).not.toContain(CANARY);
      }
      const canceled = await scoreOf(rejecting(new Error(CANARY)), {}, runResult(), aborted());
      expect(canceled.message).toBe('Decision canceled');
    },
  },
  {
    row: 69,
    source: 'run rule, O7',
    title:
      'a validator error or unavailable outcome carries an identifier code, a fixed message and no cause',
    async run() {
      for (const error of [
        notConfigured(),
        policyDenied(),
        providerDown(),
        freeTextCode(),
        new TypeError(CANARY),
      ]) {
        const { outcome } = await validateWith(rejecting(error));
        if (outcome.kind !== 'error' && outcome.kind !== 'unavailable')
          throw new Error('expected a failure');
        expect(outcome.error.code).toMatch(IDENTIFIER);
        expect(outcome.error.kind).toBe('execute');
        expect(outcome.error).not.toHaveProperty('cause');
        expect(JSON.stringify(outcome)).not.toContain(CANARY);
        if (outcome.kind === 'unavailable') expect(outcome.reason).toMatch(IDENTIFIER);
      }
    },
  },
  {
    row: 70,
    source: 'AC4, Rev',
    title:
      'a decisionScorer with no content option sends only the final reply to the decision model',
    async run() {
      const conversation = new Conversation();
      conversation.appendUserMessage('hello from the transcript');
      const { asked } = await scoreWith(
        answer(true),
        {},
        runResult({ content: 'the final answer', conversation }),
      );
      expect(asked).toHaveLength(1);
      expect(asked[0]?.request).toEqual({ ...QUESTION, context: 'the final answer' });
      expect(JSON.stringify(asked[0]?.request)).not.toContain('hello from the transcript');
    },
  },
  {
    row: 71,
    source: 'AC4, Rev',
    title: 'content transcript sends the conversation as markdown',
    async run() {
      const conversation = new Conversation();
      conversation.appendUserMessage('hello from the transcript');
      conversation.appendAssistantMessage('the final answer');
      const run = runResult({ content: 'the final answer', conversation });
      const { asked } = await scoreWith(answer(true), { content: 'transcript' }, run);
      expect(asked[0]?.request).toEqual({
        ...QUESTION,
        context: conversationToMarkdown(conversation),
      });
      expect(contextAsked(asked)).toContain('hello from the transcript');
    },
  },
  {
    row: 72,
    source: 'O11',
    title:
      'another content value throws a TypeError when the scorer is built, and the helper’s context wins',
    async run() {
      const { decisions } = source(answer(true));
      expect(() =>
        pluginPackage.decisionScorer(decisions, {
          name: 'judge',
          version: '1',
          question: QUESTION,
          verdict: passOrFail,
          content: 'everything' as never,
        }),
      ).toThrow(TypeError);
      const { asked, scorer } = await scoreWith(answer(true), {
        question: { ...QUESTION, context: 'smuggled' } as never,
        sampleRate: 1,
      } as never);
      expect(contextAsked(asked)).toBe('the final answer');
      expect(scorer).not.toHaveProperty('sampleRate');
    },
  },
  {
    row: 73,
    source: 'Rev, brief',
    title:
      'the request is the question plus the context, asked under the run id with requireKinds and the signal',
    async run() {
      const controller = new AbortController();
      const { asked } = await scoreWith(
        answer(true),
        { requireKinds: ['boolean'] },
        runResult(),
        controller.signal,
      );
      expect(asked[0]?.options).toEqual({
        taskId: 'run-7',
        requireKinds: ['boolean'],
        signal: controller.signal,
      });
      const { asked: plain } = await scoreWith(answer(true));
      expect(plain[0]?.options).not.toHaveProperty('requireKinds');
    },
  },
  {
    row: 74,
    source: 'Rev, O7',
    title: 'an answered decision goes to verdict, whose result is the score',
    async run() {
      expect(await scoreOf(answer(true))).toMatchObject({ outcome: 'pass', score: 1 });
      expect(await scoreOf(answer(false))).toMatchObject({ outcome: 'fail', score: 0 });
      const asynchronous = await scoreWith(answer(true), {
        verdict: async () => ({ outcome: 'indeterminate', message: 'unsure' }),
      });
      expect(asynchronous.score).toMatchObject({ outcome: 'indeterminate', message: 'unsure' });
    },
  },
  {
    row: 75,
    source: 'Rev, main',
    title: 'a rejection while the scorer’s signal is aborted is canceled',
    async run() {
      const { score } = await scoreWith(
        rejecting(new DOMException('stop', 'AbortError')),
        {},
        runResult(),
        aborted(),
      );
      expect(score).toMatchObject({ outcome: 'canceled' });
    },
  },
  {
    row: 76,
    source: 'Rev, AC2, O9',
    title: 'NOT_CONFIGURED and a policy denial are unavailable',
    async run() {
      for (const error of [notConfigured(), policyDenied()]) {
        expect(await scoreOf(rejecting(error))).toMatchObject({ outcome: 'unavailable' });
      }
    },
  },
  {
    row: 77,
    source: 'Rev',
    title: 'a schema failure or a provider error is an error',
    async run() {
      const schemaFailure = Object.assign(new Error('bad answer'), { name: 'DecisionSchemaError' });
      for (const error of [schemaFailure, providerDown(), new TypeError('x')]) {
        expect(await scoreOf(rejecting(error))).toMatchObject({ outcome: 'error' });
      }
    },
  },
  {
    row: 78,
    source: 'Rev',
    title: 'alertThreshold is set on the scorer it builds, and absent when not given',
    async run() {
      const { scorer: given } = await scoreWith(answer(true), { alertThreshold: 0.5 });
      expect(given.alertThreshold).toBe(0.5);
      const { scorer: absent } = await scoreWith(answer(true));
      expect(absent).not.toHaveProperty('alertThreshold');
    },
  },
  {
    row: 79,
    source: 'AC5, brief',
    title: 'a scorer built on a decision declares determinism stochastic',
    async run() {
      const { scorer } = await scoreWith(answer(true));
      expect(scorer).toMatchObject({ name: 'judge', version: '1', determinism: 'stochastic' });
    },
  },
  {
    row: 80,
    source: 'AC3, Decisions',
    title: 'the plugin helper’s validator passes on a true answer and retries on a false one',
    async run() {
      expect(await outcomeOf(answer(true))).toEqual({ kind: 'pass', evidence: [] });
      expect(await outcomeOf(answer(false))).toEqual({
        kind: 'fail',
        feedback: 'no',
        evidence: [],
        retryable: true,
      });
    },
  },
  {
    row: 81,
    source: 'Rev',
    title: 'the validator asks under the goal run id with its signal, and sets no principal',
    async run() {
      const controller = new AbortController();
      const { asked } = await validateWith(answer(true), controller.signal, {
        requireKinds: ['boolean'],
      });
      expect(asked[0]?.options).toEqual({
        taskId: 'goal-1',
        requireKinds: ['boolean'],
        signal: controller.signal,
      });
      expect(asked[0]?.options).not.toHaveProperty('principal');
    },
  },
  {
    row: 82,
    source: 'Rev',
    title:
      'NOT_CONFIGURED and a policy denial are unavailable, so a goal that retries on validator-unavailable retries',
    async run() {
      const refused = await outcomeOf(rejecting(notConfigured()));
      expect(refused).toMatchObject({
        kind: 'unavailable',
        reason: 'NOT_CONFIGURED',
        error: { kind: 'execute', code: 'DECISION_UNAVAILABLE' },
      });
      expect(await outcomeOf(rejecting(policyDenied()))).toMatchObject({
        kind: 'unavailable',
        reason: 'UNKNOWN',
      });
    },
  },
  {
    row: 83,
    source: 'Rev, main',
    title: 'a rejection while the goal’s signal is aborted is canceled',
    async run() {
      const { outcome } = await validateWith(
        rejecting(new DOMException('stop', 'AbortError')),
        aborted(),
      );
      expect(outcome).toEqual({ kind: 'canceled' });
    },
  },
  {
    row: 84,
    source: 'Rev, O7',
    title: 'any other rejection is an error with an identifier code',
    async run() {
      expect(await outcomeOf(rejecting(providerDown()))).toMatchObject({
        kind: 'error',
        error: {
          kind: 'execute',
          code: 'DECISION_FAILED',
          message: 'Decision failed: PROVIDER_DOWN',
        },
      });
    },
  },
  {
    row: 88,
    source: 'brief, main',
    title: 'the validator is stochastic, carries its identity, and accepts requireKinds',
    async run() {
      const { validator } = await validateWith(answer(true), undefined, {
        requireKinds: ['boolean'],
      });
      expect(validator).toMatchObject({
        identity: { name: 'judge', version: '1' },
        determinism: 'stochastic',
      });
    },
  },
  {
    row: 89,
    source: 'Constraints',
    title: 'the package exports decisionScorer and decisionValidator',
    run() {
      expect(typeof pluginPackage.decisionScorer).toBe('function');
      expect(typeof pluginPackage.decisionValidator).toBe('function');
    },
  },
];

describe('COR-2204 decision matrix: the plugin helpers', () => {
  for (const { row, source: rowSource, title, run } of ROWS) {
    it(`R${row} [${rowSource}] ${title}`, () => run());
  }
});
