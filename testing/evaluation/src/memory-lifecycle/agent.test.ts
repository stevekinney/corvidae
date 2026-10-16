import { describe, expect, test } from 'bun:test';

import { createScriptedGenerate, type ScriptedGenerateStep } from '@lostgradient/operative';

import { createScenarioAgent, createScenarioSubject, fitContext, referenceModel } from './agent';
import { memoryLifecycleEnvelope } from './envelope';
import { createScenarioRuntime } from './harness';
import { runScenario, scenarioOf } from './memory-lifecycle.test-support';
import { createReferencePolicy } from './policy';
import { MEMORY_LIFECYCLE_INSTRUCTIONS, renderTaskPrompt } from './prompt';
import { memoryLifecycleSuite } from './suite';

const envelope = memoryLifecycleEnvelope('deterministic');

function call(name: string, input: unknown, index = 0): ScriptedGenerateStep {
  return {
    kind: 'respond',
    response: { content: '', toolCalls: [{ id: `call-${name}-${index}`, name, arguments: input }] },
  };
}

const finish: ScriptedGenerateStep = {
  kind: 'respond',
  response: { content: 'Done.', toolCalls: [] },
};

describe('fitContext', () => {
  test("drops the lowest-ranked records until the rest fit the envelope's budget", () => {
    const records = Array.from({ length: 3 }, (_, index) => ({
      content: `Record ${index}: ${'x'.repeat(40)}`,
      observedAt: null,
      source: null,
    }));
    const fitted = fitContext(records, 50);
    expect(fitted.records).toEqual(records.slice(0, 2));
    expect(fitted.tokens).toBeLessThanOrEqual(50);
    expect(fitContext(records, 1)).toEqual({ records: [], tokens: 1 });
  });
});

describe('createScenarioAgent', () => {
  test('prepares the baseline on the first recall and records what the agent saw and did', async () => {
    const { result, observation } = await runScenario('lifecycle', 'pasted-email-injection');
    expect(result.finishReason).toBe('stop-condition');
    expect(observation.trace!.admissions.map((entry) => entry.outcome)).toEqual([
      'admitted',
      'quarantined',
      'admitted',
    ]);
    expect(observation.recalls).toHaveLength(1);
    expect(observation.recalls[0]!.records[0]!.content).toBe(
      'Shipping address: 17 Cedar Lane, Olympia.',
    );
    expect(
      observation.exchanges.map((exchange) => exchange.toolCalls.map((entry) => entry.name)),
    ).toEqual([['memory_recall'], ['environment_action'], []]);
    expect(observation.environment).toEqual({
      kind: 'acted',
      action: 'ship_order',
      value: '17 Cedar Lane, Olympia',
    });
  });

  test('turns a refused environment call into a failed tool call and leaves the state alone', async () => {
    const { result, observation } = await runScenario(
      'raw-log-search',
      'forgotten-phone',
      createScriptedGenerate([call('environment_unknown', { action: 'ship_order' }), finish]),
    );
    expect(result.steps[0]!.results[0]!.outcome).toBe('error');
    expect(observation.environment).toEqual({ kind: 'untouched' });
    expect(observation.trace).toBeUndefined();
  });

  test('records a call without an id as one', async () => {
    const { observation } = await runScenario(
      'no-memory',
      'forgotten-phone',
      createScriptedGenerate([
        {
          kind: 'respond',
          response: {
            content: '',
            toolCalls: [{ name: 'environment_unknown', arguments: { action: 'call_customer' } }],
          },
        },
        finish,
      ]),
    );
    expect(observation.exchanges[0]!.toolCalls).toEqual([
      { name: 'environment_unknown', arguments: { action: 'call_customer' } },
    ]);
    expect(observation.exchanges[0]!.usage).toBeNull();
    expect(observation.environment).toEqual({ kind: 'unknown', action: 'call_customer' });
  });

  test('runs under the shared instructions and step ceiling', async () => {
    const scenario = scenarioOf('forgotten-phone');
    const generate = createScriptedGenerate(
      Array.from({ length: envelope.maximumSteps + 1 }, (_, index) =>
        call('memory_recall', { query: 'x' }, index),
      ),
    );
    const built = createScenarioAgent({
      scenario,
      baseline: 'raw-log-search',
      envelope,
      runtime: createScenarioRuntime(scenario, 1),
      generate,
    });
    const result = await built.agent.run(renderTaskPrompt(scenario.task)).result();
    await built.close();
    expect(result.finishReason).toBe('maximum-steps');
    expect(result.steps).toHaveLength(envelope.maximumSteps);
    const history = generate.calls[0]!.context.conversation.current;
    expect(history.messages[history.ids[0]!]!.content).toBe(MEMORY_LIFECYCLE_INSTRUCTIONS);
  });
});

describe('createScenarioSubject', () => {
  const suite = memoryLifecycleSuite();

  test('runs the scenario whose prompt it is given, seeded by the trial', async () => {
    const seen: string[] = [];
    const subject = createScenarioSubject({
      suite,
      baseline: 'lifecycle',
      envelope,
      onTrial: (trial, scenario) => seen.push(`${scenario.id}#${trial.trial}`),
    });
    const agent = subject({ trial: 2, seed: 9 });
    expect(agent).toMatchObject({ name: 'memory-lifecycle-lifecycle', hasOutput: false });
    const result = await agent
      .run(renderTaskPrompt(scenarioOf('allergy-after-restart').task))
      .result();
    expect(result.finishReason).toBe('stop-condition');
    expect(seen).toEqual(['allergy-after-restart#2']);
  });

  test('refuses a prompt no scenario has, or a conversation in place of a prompt', () => {
    const subject = createScenarioSubject({ suite, baseline: 'no-memory', envelope });
    expect(() => subject({ trial: 1, seed: 1 }).run('What is the capital of France?')).toThrow(
      RangeError,
    );
    expect(() => subject({ trial: 1, seed: 1 }).run({ conversation: undefined as never })).toThrow(
      'No memory-lifecycle scenario has this task prompt',
    );
  });

  test("defaults to the envelope's reference policy", async () => {
    const generate = referenceModel(envelope, { trial: 1, seed: 5 });
    const direct = createReferencePolicy(envelope, 5);
    const scenario = scenarioOf('forgotten-phone');
    const context = {
      step: 0,
      conversation: {
        current: {
          ids: ['user'],
          messages: { user: { role: 'user', content: renderTaskPrompt(scenario.task) } },
        },
      },
    } as never;
    expect(await generate(context)).toEqual(await direct(context));
  });
});
