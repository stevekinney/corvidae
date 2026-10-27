/**
 * COR-1709 — the `decide` tool: offered by default to the runs `requestHumanInput` is offered to,
 * resolved inline as the task's principal, capped per task, and left out under `decide: false`.
 */
import {
  createAgent,
  type DecisionModel,
  type GenerateContext,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from '../agent-catalog.ts';
import { createBureau } from '../create-bureau.ts';
import { runTask } from '../test/index.ts';
import type { Bureau, BureauOptions } from '../types.ts';
import { createDecideToolbox, type DecideToolResult } from './decide-tool.ts';
import type { DecisionSource } from './types.ts';

const bureaus: Bureau<AgentDefinitions>[] = [];
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

function scriptedModel(): DecisionModel & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    name: 'scripted/model',
    kinds: new Set(['boolean', 'choice', 'scale', 'structured']),
    asked,
    decide: async (request) => {
      asked.push(request.question);
      return {
        value: request.kind === 'boolean' ? true : 'a',
        provider: 'scripted',
        model: 'model',
      };
    },
  };
}

/** An agent that records the tools it was offered, calls `decide` `calls` times, then answers. */
function decidingAgent(offered: string[][], results: unknown[], calls: number) {
  const generate: GenerateFunction = async (context: GenerateContext) => {
    offered.push(context.toolbox.tools().map((tool) => tool.name));
    const last = context.conversation.getMessages().at(-1);
    if (context.step > 0) results.push(last?.toolResult?.content);
    if (context.step >= calls) return { content: 'done', toolCalls: [] };
    return {
      content: '',
      toolCalls: [
        {
          id: `call-${context.step}`,
          name: 'decide',
          arguments: {
            kind: 'boolean',
            question: `Question ${context.step}?`,
            context: 'secret context',
          },
        },
      ],
    };
  };
  return createAgent({ generate, toolbox: createToolbox([]), stopWhen: stopWhen.noToolCalls() });
}

async function open(
  agents: AgentDefinitions,
  options: Partial<BureauOptions<AgentDefinitions>> = {},
): Promise<Bureau<AgentDefinitions>> {
  const bureau = await createBureau<AgentDefinitions>({
    agents,
    storage: { type: 'memory' },
    durable: true,
    ...options,
  });
  bureaus.push(bureau);
  return bureau;
}

async function toolsOfTask(options: Partial<BureauOptions<AgentDefinitions>>): Promise<string[]> {
  const offered: string[][] = [];
  const bureau = await open({ worker: decidingAgent(offered, [], 0) }, options);
  await runTask(bureau, 'worker', 'go');
  return offered.flat();
}

describe('offering the decide tool', () => {
  it('offers it by default once a decision model is configured', async () => {
    expect(await toolsOfTask({ decisions: { model: scriptedModel() } })).toContain('decide');
  });

  it('offers it once models.generate is configured', async () => {
    expect(
      await toolsOfTask({
        models: { generate: () => async () => ({ content: '', toolCalls: [] }) },
      }),
    ).toContain('decide');
  });

  it('leaves it out under decide: false, and offers the other tools still', async () => {
    const tools = await toolsOfTask({ decisions: { model: scriptedModel() }, decide: false });

    expect(tools).not.toContain('decide');
    expect(tools).toContain('requestHumanInput');
  });

  it('leaves it out when nothing could answer, and when requestHumanInput is the one turned off', async () => {
    expect(await toolsOfTask({})).not.toContain('decide');
    expect(
      await toolsOfTask({ decisions: { model: scriptedModel() }, humanInput: false }),
    ).toContain('decide');
  });

  it('leaves it out of a non-durable Bureau', async () => {
    expect(
      await toolsOfTask({ durable: false, decisions: { model: scriptedModel() } }),
    ).not.toContain('decide');
  });
});

describe('calling the decide tool', () => {
  it('resolves inline and files the audit record under the task as the task’s principal', async () => {
    const results: unknown[] = [];
    const model = scriptedModel();
    const bureau = await open({ worker: decidingAgent([], results, 1) }, { decisions: { model } });

    const task = await bureau.tasks.start('worker', 'go', { principal: 'api-key:alice' });
    await task.result();

    expect(model.asked).toEqual(['Question 0?']);
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0])).toContain('"ok":true');
    const records = (await bureau.internals.auditTrail?.query({ type: 'decision.made' })) ?? [];
    expect(records.map((record) => [record.runId, record.principal])).toEqual([
      [task.id, 'api-key:alice'],
    ]);
    expect(JSON.stringify(records)).not.toContain('secret context');
  });

  it('refuses the call after the cap with a typed result and asks the model no more', async () => {
    const results: unknown[] = [];
    const model = scriptedModel();
    const bureau = await open(
      { worker: decidingAgent([], results, 3) },
      { decisions: { model, maximumPerTask: 2 } },
    );

    await runTask(bureau, 'worker', 'go');

    expect(model.asked).toEqual(['Question 0?', 'Question 1?']);
    expect(results).toHaveLength(3);
    expect(JSON.stringify(results[2])).toContain('"refusal":"maximum-per-task"');
  });
});

describe('createDecideToolbox', () => {
  async function call(toolbox: ReturnType<typeof createDecideToolbox>, input: unknown) {
    const tool = toolbox.getTool('decide')!;
    return (await tool.execute(input as never)) as unknown as DecideToolResult;
  }

  const answering: DecisionSource = {
    decide: async () => ({ value: true, provider: 'p', model: 'm' }),
  };

  it('refuses the 21st call of a task at the default cap of 20', async () => {
    const toolbox = createDecideToolbox({
      decisions: answering,
      principal: undefined,
      taskId: 't1',
      maximumPerTask: 20,
    });

    for (let index = 1; index <= 20; index += 1) {
      expect(await call(toolbox, { kind: 'boolean', question: `Q${index}?` })).toMatchObject({
        ok: true,
      });
    }
    expect(await call(toolbox, { kind: 'boolean', question: 'Q21?' })).toMatchObject({
      ok: false,
      refusal: 'maximum-per-task',
      maximum: 20,
    });
  });

  it('counts a task apart from another', async () => {
    const make = (taskId: string) =>
      createDecideToolbox({
        decisions: answering,
        principal: undefined,
        taskId,
        maximumPerTask: 1,
      });
    const first = make('a');
    const second = make('b');

    expect(await call(first, { kind: 'boolean', question: 'Q?' })).toMatchObject({ ok: true });
    expect(await call(first, { kind: 'boolean', question: 'Q?' })).toMatchObject({ ok: false });
    expect(await call(second, { kind: 'boolean', question: 'Q?' })).toMatchObject({ ok: true });
  });

  it('refuses a schema it cannot accept, and a request that is incomplete', async () => {
    const toolbox = createDecideToolbox({
      decisions: answering,
      principal: undefined,
      taskId: 't',
      maximumPerTask: 20,
    });

    expect(
      await call(toolbox, {
        kind: 'structured',
        question: 'Q?',
        schema: { type: 'string', pattern: 'a' },
      }),
    ).toMatchObject({ ok: false, refusal: 'invalid-schema' });
  });
});
