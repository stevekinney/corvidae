/**
 * COR-2009 — the showcase host's provider resolver (`showcase.ts`): a built-in agent's model
 * override sends its steps to the stub provider, and the showcase answers them from the agent's
 * script, so Tool runner still raises its refund approval on the model a person chose
 * (decisions.md, "B01 fix round, Nov 3"). Any other step gets the stub's fixed reply.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgent, stopWhen } from '@lostgradient/operative';

import { startHost, type Host } from './host.ts';
import { showcaseAgentScripts, showcaseModelSwitcherReply } from './showcase-agents.ts';
import {
  SHOWCASE_MODELS,
  SHOWCASE_MODEL_REPLY,
  showcaseHostOptions,
  showcaseProviderResolver,
} from './showcase.ts';
import { writeProviderHome } from './stub-provider.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A showcase host on a fresh home whose catalog holds the stub provider's models. */
async function startShowcaseHost(): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-showcase-provider-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  await writeProviderHome(home, [...SHOWCASE_MODELS]);
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    ...showcaseHostOptions(),
  });
  cleanups.push(() => host.close());
  return host;
}

/** Saves `model` as built-in agent `id`'s model override. */
async function overrideModel(host: Host, id: string, model: string): Promise<void> {
  const state = await host.bureau.agents.overrides.get(id);
  expect(state).toBeDefined();
  await host.bureau.agents.overrides.save(
    id,
    { model },
    { expectedHash: state?.hash ?? '', savedBy: 'anonymous:local' },
  );
}

describe('the showcase provider resolver', () => {
  test('answers a built-in agent with a model override from its script, so Tool runner still asks to refund', async () => {
    const host = await startShowcaseHost();
    await overrideModel(host, 'tool-runner', 'anthropic/claude-haiku-5-5');

    const task = await host.bureau.tasks.start(
      'tool-runner',
      'Please refund order 4471, it arrived damaged.',
    );
    const result = await task.result();

    expect(
      result.steps.flatMap((step) =>
        step.results.map((outcome) => [outcome.toolName, outcome.outcome]),
      ),
    ).toEqual([
      ['lookup-order', 'success'],
      ['issue-refund', 'action_required'],
    ]);
    expect(result.steps.at(-1)?.results[0]?.pendingApproval).toBeDefined();
    expect(result.steps.map((step) => step.content)).not.toContain(SHOWCASE_MODEL_REPLY);
  });

  test('answers Model switcher from its script, not the stub, once its override sends it to the provider', async () => {
    const host = await startShowcaseHost();
    await overrideModel(host, 'model-switcher', 'anthropic/claude-haiku-5-5');

    const task = await host.bureau.tasks.start('model-switcher', 'Which model are you?');
    const result = await task.result();

    expect(result.content).toBe(showcaseModelSwitcherReply('claude-sonnet-5-5'));
  });

  test('gives a run the Bureau holds no task of the stub’s fixed reply', async () => {
    const host = await startShowcaseHost();
    // A run outside the Bureau: its generate is the provider's, and nothing names its agent.
    const outsider = createAgent({
      name: 'tool-runner',
      generate: host.generateFor({ provider: 'anthropic', model: 'claude-haiku-5-5' }),
      stopWhen: stopWhen.noToolCalls(),
    });

    const result = await outsider.run('Please refund order 4471, it arrived damaged.').result();

    expect(result.content).toBe(SHOWCASE_MODEL_REPLY);
  });

  test('reads whose run a step is at each call, and falls back to the provider for an agent with no script', async () => {
    const owners = new Map<string, string>([
      ['run-echo', 'echo'],
      ['run-file-agent', 'researcher'],
    ]);
    const asked: string[] = [];
    const resolver = showcaseProviderResolver(async (runId) => {
      asked.push(runId);
      return owners.get(runId);
    }, showcaseAgentScripts());
    const definition = {
      name: 'fixture',
      generate: () => async () => ({ content: 'Answered by the provider.', toolCalls: [] }),
      stream: () => {
        throw new Error('The fixture provider does not stream.');
      },
    };
    // One generate serves every run on its model, so whose run it is must be read per call.
    const generate = resolver(
      [definition],
      { provider: 'fixture', model: 'fixture-model', apiKey: 'fixture-key' },
      undefined,
      undefined,
    );
    const contextOf = (runId: string | undefined) =>
      ({
        runId,
        step: 0,
        conversation: { getMessages: () => [{ role: 'user', content: 'Say this back' }] },
      }) as unknown as Parameters<typeof generate>[0];

    expect(await generate(contextOf('run-echo'))).toEqual({
      content: 'Say this back',
      toolCalls: [],
    });
    const fileAgent = await generate(contextOf('run-file-agent'));
    const noRun = await generate(contextOf(undefined));
    expect(fileAgent.content).toBe('Answered by the provider.');
    expect(noRun.content).toBe('Answered by the provider.');
    expect(asked).toEqual(['run-echo', 'run-file-agent']);
  });
});
