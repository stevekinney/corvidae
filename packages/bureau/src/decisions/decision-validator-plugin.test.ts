/**
 * COR-2204 — a goal validator that asks a decision, through Bureau's own `decisionValidator` and
 * through the plugin helper it is now built over, against the outcome matrix
 * (`tmp/chef/briefs/COR-2204-matrix.md`). One table, one entry per matrix row, each titled with its
 * row number and the matrix's source column.
 *
 * Every decision model is a double, and nothing waits on a clock.
 */
import * as pluginPackage from '@lostgradient/interborough-plugin';
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  type Decision,
  type DecisionModel,
  executeValidator,
  type Validator,
  type ValidatorInput,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';
import { formatToolId } from 'armorer';

import type { AgentDefinitions } from '../agent-catalog.ts';
import type { Bureau } from '../bureau-types/facade.ts';
import { createBureau } from '../create-bureau.ts';
import { composePlugins } from '../plugins/compose-plugins.ts';
import { ALL_KINDS, type MatrixRow } from '../testing/decision-harness.test-support.ts';
import {
  answering,
  GOAL_BOUNDS,
  goalRequest,
  pollUntil,
  TERMINAL_STATUSES,
  workerAgent,
} from '../testing/goal-fixtures.test-support.ts';
import {
  disposePluginBureaus,
  openPluginBureau,
  type PluginBureau,
} from '../testing/plugin-decisions.test-support.ts';
import { bindDecisionValidator, decisionValidator } from './decision-validator.ts';
import type { DecisionSource } from './types.ts';

const bureaus: Bureau[] = [];
afterEach(async () => {
  await disposePluginBureaus();
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

const JUDGE = { name: 'judge', version: '1' } as const;
const PLUGIN_JUDGE = {
  name: formatToolId({ namespace: 'demo', name: 'judge' }),
  version: '1',
} as const;
const verdict = (decision: Decision<unknown>) =>
  decision.value === true
    ? ({ kind: 'pass', evidence: [] } as const)
    : ({ kind: 'fail', feedback: 'try again', evidence: [], retryable: true } as const);
const request = (input: ValidatorInput) =>
  ({ kind: 'boolean', question: 'Is it acceptable?', context: input.result.content }) as const;
const input = { goalRunId: 'goal-1', result: { content: 'x' } } as unknown as ValidatorInput;

const notConfigured = () => Object.assign(new Error('none'), { code: 'NOT_CONFIGURED' });
const policyDenied = () =>
  Object.assign(new Error('denied'), {
    code: 'model-policy-denied',
    name: 'ModelPolicyDeniedError',
  });

/** A decision model that plays `script` in order: a value answers, an error rejects. */
function sequencedModel(script: readonly unknown[]): DecisionModel {
  const remaining = [...script];
  return {
    name: 'sequenced',
    kinds: ALL_KINDS,
    decide: async () => {
      const next = remaining.shift();
      if (next instanceof Error) throw next;
      return { value: next, provider: 'hostprov', model: 'sequenced' };
    },
  };
}

/** Bureau's validator bound to a source that scripts `decide`, run under Operative's executor. */
async function executeBound(
  decide: DecisionSource['decide'],
  signal: AbortSignal = new AbortController().signal,
  options: { principal?: string } = {},
) {
  const validator = decisionValidator({
    ...JUDGE,
    request,
    verdict,
    ...(options.principal === undefined ? {} : { principal: options.principal }),
  });
  const bound = bindDecisionValidator(validator, { decide });
  return executeValidator(bound, input, signal, { runtime: createManualRuntimeServices() });
}

async function ended(bureau: Bureau, goalRunId = 'g1') {
  await pollUntil(async () => {
    const goal = await bureau.goals.get(goalRunId);
    return (TERMINAL_STATUSES as readonly string[]).includes(goal?.status ?? '');
  });
  return (await bureau.goals.get(goalRunId))!;
}

/** A Bureau with Bureau's own decision validator, asking the sequenced model. */
async function openBureauValidator(script: readonly unknown[]) {
  const bureau = await createBureau<AgentDefinitions>({
    storage: new MemoryStorage(),
    durable: true,
    agents: { worker: workerAgent(answering('an answer')) },
    validators: [decisionValidator({ ...JUDGE, request, verdict })],
    decisions: { models: { m: sequencedModel(script) }, model: 'm' },
  });
  bureaus.push(bureau);
  return bureau;
}

/** A Bureau whose plugin `demo` contributes the plugin helper's validator over its host. */
function openPluginValidator(script: readonly unknown[]): Promise<PluginBureau> {
  return openPluginBureau({
    contributions: (host) => ({
      validators: [pluginPackage.decisionValidator(host.decisions, { ...JUDGE, request, verdict })],
    }),
    bureau: {
      durable: true,
      agents: { worker: workerAgent(answering('an answer')) },
      decisions: { models: { m: sequencedModel(script) }, model: 'm' },
    },
  });
}

const RETRY_ON_UNAVAILABLE = {
  bounds: GOAL_BOUNDS,
  retryPolicy: { retryOn: ['validator-unavailable'] },
} as const;

const ROWS: readonly MatrixRow[] = [
  {
    row: 80,
    source: 'AC3, Decisions',
    title:
      'AC3: Bureau’s validator, rebuilt over the helper, and the plugin helper’s pass and fail a goal as Bureau’s did',
    async run() {
      const passed = await executeBound(async () => ({ value: true, provider: 'p', model: 'm' }));
      expect(passed.outcome.kind).toBe('pass');
      const failed = await executeBound(async () => ({ value: false, provider: 'p', model: 'm' }));
      expect(failed.outcome).toMatchObject({ kind: 'fail', retryable: true });

      const passing = await openBureauValidator([true]);
      await passing.goals.create(goalRequest({ validator: JUDGE }));
      expect(await ended(passing)).toMatchObject({ status: 'succeeded', usage: { attempts: 1 } });

      const retrying = await openPluginValidator([false, true]);
      await retrying.bureau.goals.create(
        goalRequest({ validator: PLUGIN_JUDGE, bounds: GOAL_BOUNDS }),
      );
      expect(await ended(retrying.bureau)).toMatchObject({
        status: 'succeeded',
        usage: { attempts: 2 },
      });

      const failing = await openPluginValidator([true]);
      await failing.bureau.goals.create(goalRequest({ validator: PLUGIN_JUDGE }));
      expect(await ended(failing.bureau)).toMatchObject({
        status: 'succeeded',
        usage: { attempts: 1 },
      });
    },
  },
  {
    row: 81,
    source: 'Rev',
    title: 'Bureau’s validator asks with { signal, taskId: goalRunId, principal }',
    async run() {
      const seen: unknown[] = [];
      const controller = new AbortController();
      await executeBound(
        async (_request, options) => {
          seen.push(options);
          return { value: true, provider: 'p', model: 'm' };
        },
        controller.signal,
        { principal: 'agent-run:owner' },
      );
      expect(seen[0]).toMatchObject({ taskId: 'goal-1', principal: 'agent-run:owner' });
      expect(seen[0]).toHaveProperty('signal');
      const { outcome } = await executeBound(async (_request, options) => {
        seen.push(options);
        return { value: true, provider: 'p', model: 'm' };
      });
      expect(outcome.kind).toBe('pass');
      expect(seen[1]).not.toHaveProperty('principal');
    },
  },
  {
    row: 82,
    source: 'Rev',
    title:
      'NOT_CONFIGURED and a policy denial are unavailable, so a goal that retries on validator-unavailable now retries',
    async run() {
      for (const error of [notConfigured(), policyDenied()]) {
        const { outcome } = await executeBound(async () => {
          throw error;
        });
        expect(outcome.kind).toBe('unavailable');
      }
      const bureauValidator = await openBureauValidator([notConfigured(), true]);
      await bureauValidator.goals.create(
        goalRequest({ validator: JUDGE, ...RETRY_ON_UNAVAILABLE }),
      );
      expect(await ended(bureauValidator)).toMatchObject({
        status: 'succeeded',
        usage: { attempts: 2 },
      });

      const pluginValidator = await openPluginValidator([policyDenied(), true]);
      await pluginValidator.bureau.goals.create(
        goalRequest({ validator: PLUGIN_JUDGE, ...RETRY_ON_UNAVAILABLE }),
      );
      expect(await ended(pluginValidator.bureau)).toMatchObject({
        status: 'succeeded',
        usage: { attempts: 2 },
      });

      // Without the retry entry the goal fails as an infrastructure error, as it did on main.
      const unretried = await openBureauValidator([notConfigured()]);
      await unretried.goals.create(goalRequest({ validator: JUDGE }));
      expect(await ended(unretried)).toMatchObject({ status: 'failed' });
    },
  },
  {
    row: 83,
    source: 'Rev, main',
    title: 'a rejection while the goal’s signal is aborted is canceled',
    async run() {
      const controller = new AbortController();
      const executing = executeBound(
        (_request, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), {
              once: true,
            });
          }),
        controller.signal,
      );
      controller.abort();
      const { outcome } = await executing;
      expect(outcome.kind).toBe('canceled');
    },
  },
  {
    row: 84,
    source: 'Rev, O7',
    title: 'any other rejection is an error with an identifier code, not VALIDATOR_THREW',
    async run() {
      const { outcome } = await executeBound(async () => {
        throw new Error('provider down');
      });
      expect(outcome).toMatchObject({
        kind: 'error',
        error: { kind: 'execute', code: 'DECISION_FAILED' },
      });
    },
  },
  {
    row: 85,
    source: 'Decisions, main',
    title: 'Bureau’s validator used outside a Bureau is indeterminate, and reports stochastic',
    async run() {
      const validator = decisionValidator({ ...JUDGE, request, verdict });
      expect(validator.determinism).toBe('stochastic');
      const outcome = await validator.validate(input, new AbortController().signal);
      expect(outcome.kind).toBe('indeterminate');
    },
  },
  {
    row: 86,
    source: 'main',
    title:
      'Bureau’s decisionValidator contributed by a plugin loses its binding: indeterminate, the source never called',
    async run() {
      const contributed = decisionValidator({ ...JUDGE, request, verdict });
      const { options } = await composePlugins({
        plugins: [
          {
            descriptor: pluginPackage.definePlugin({
              name: 'demo',
              version: '1.0.0',
              description: 'Contributes Bureau’s validator.',
              setup: () => ({ validators: [contributed] }),
            }),
            source: 'package',
            location: '@example/demo',
          },
        ],
      } as never);
      const composed = (options as { validators: Validator[] }).validators[0]!;
      let calls = 0;
      const rebound = bindDecisionValidator(composed, {
        decide: async () => {
          calls += 1;
          return { value: true, provider: 'p', model: 'm' };
        },
      });
      const { outcome } = await executeValidator(rebound, input, new AbortController().signal, {
        runtime: createManualRuntimeServices(),
      });
      expect(outcome.kind).toBe('indeterminate');
      expect(calls).toBe(0);
    },
  },
  {
    row: 87,
    source: 'Rev',
    title:
      'the plugin helper’s validator, contributed by a plugin, asks through host.decisions as plugin:demo under the goal run',
    async run() {
      const opened = await openPluginValidator([true]);
      await opened.bureau.goals.create(
        goalRequest({ goalRunId: 'goal-87', validator: PLUGIN_JUDGE }),
      );
      expect(await ended(opened.bureau, 'goal-87')).toMatchObject({ status: 'succeeded' });
      const records = await opened.records();
      expect(records.map((record) => [record.runId, record.principal])).toEqual([
        ['goal-87', 'plugin:demo'],
      ]);
    },
  },
];

describe('COR-2204 decision matrix: goal validators that ask a decision', () => {
  for (const { row, source, title, run } of ROWS) {
    it(`R${row} [${source}] ${title}`, () => run());
  }
});
