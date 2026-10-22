/**
 * COR-1628 — `withActiveSkillToolPolicy` is an execution gate as well as a filter: a call to a
 * tool the active skills' `allowed-tools` exclude is refused with `SKILL_TOOL_DENIED` before the
 * tool runs, and the run continues.
 */
import type { AnyToolbox, ToolExecutionResult } from 'armorer';
import { createTool, createToolbox } from 'armorer';
import type { ToolCall, ToolPolicy } from 'armorer/protocol';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { withActiveSkillToolPolicy } from './agent-policy';
import { createActiveRun } from './create-run';
import type { ToolSettledBubbleEvent } from './events';
import { createMockGenerate } from './test/index';
import type { GenerateFunction } from './types';

const REFUSAL = (name: string) =>
  `Tool "${name}" is not available: the active skills' allowed-tools exclude it.`;

interface Harness {
  readonly executed: string[];
  readonly policy: { current: ToolPolicy | undefined };
  readonly toolbox: AnyToolbox;
  readonly gated: AnyToolbox;
}

/** `search` and `write` record their runs; `activate_skill` narrows the policy to `search`. */
function harness(options: { resolution?: boolean } = {}): Harness {
  const executed: string[] = [];
  const policy: { current: ToolPolicy | undefined } = { current: { allowList: ['search'] } };
  const recording = (name: string) =>
    createTool({
      name,
      description: `The ${name} tool`,
      input: z.object({}),
      execute: async () => {
        executed.push(name);
        return `${name} ran`;
      },
    });
  const activate = createTool({
    name: 'activate_skill',
    description: 'Activates a skill, which narrows the run to `search`',
    input: z.object({}),
    execute: async () => {
      executed.push('activate_skill');
      policy.current = { allowList: ['search'] };
      return 'activated';
    },
  });
  const toolbox = createToolbox(
    [recording('search'), recording('write'), activate],
    options.resolution === undefined ? {} : { resolution: options.resolution },
  );
  return {
    executed,
    policy,
    toolbox,
    gated: withActiveSkillToolPolicy(toolbox, () => policy.current),
  };
}

function expectRefusal(result: ToolExecutionResult, name: string, callId: string): void {
  expect(result.outcome).toBe('error');
  expect(result.errorCategory).toBe('permission');
  expect(result.error).toEqual({
    code: 'SKILL_TOOL_DENIED',
    category: 'permission',
    retryable: false,
    message: REFUSAL(name),
  });
  expect(result.errorMessage).toBe(REFUSAL(name));
  expect(result.content).toBe(REFUSAL(name));
  expect(result.callId).toBe(callId);
  expect(result.toolCallId).toBe(callId);
  expect(result.toolName).toBe(name);
  expect(result.result).toBeUndefined();
}

describe('withActiveSkillToolPolicy as an execution gate (COR-1628)', () => {
  it('refuses a hidden tool with SKILL_TOOL_DENIED and never runs it', async () => {
    const { gated, executed } = harness();

    const result = await gated.execute({ id: 'call-write', name: 'write', arguments: {} });

    expectRefusal(result, 'write', 'call-write');
    expect(executed).toEqual([]);
  });

  it('runs a visible tool exactly as the toolbox would', async () => {
    const { gated, executed } = harness();

    const result = await gated.execute({ id: 'call-search', name: 'search', arguments: {} });

    expect(result.outcome).toBe('success');
    expect(result.result).toBe('search ran');
    expect(executed).toEqual(['search']);
  });

  it('answers a refused call in a run, settles it as an error, and lets the next step see it', async () => {
    const { gated, executed } = harness();
    const seenByNextStep: Array<{ callId: string; outcome: string; code?: string }> = [];
    const generate: GenerateFunction = async (context) => {
      if (context.step === 0) {
        return {
          content: '',
          toolCalls: [{ id: 'call-write', name: 'write', arguments: {} }],
        };
      }
      for (const message of context.conversation.getMessages()) {
        if (message.toolResult === undefined) continue;
        seenByNextStep.push({
          callId: message.toolResult.callId,
          outcome: message.toolResult.outcome,
          ...(message.toolResult.error === undefined
            ? {}
            : { code: message.toolResult.error.code }),
        });
      }
      return { content: 'done', toolCalls: [] };
    };
    const run = createActiveRun({
      generate,
      toolbox: gated,
      conversation: new Conversation(),
      runId: 'gated-run',
      stopWhen: ({ toolCalls }) => toolCalls.length === 0,
    });
    const settled: ToolSettledBubbleEvent[] = [];
    run.addEventListener('tool.settled', (event) => settled.push(event));

    const result = await run.result;

    expect(result.finishReason).toBe('stop-condition');
    expect(executed).toEqual([]);
    expect(settled.map((event) => [event.toolCallId, event.status])).toEqual([
      ['call-write', 'error'],
    ]);
    expect(seenByNextStep).toEqual([
      { callId: 'call-write', outcome: 'error', code: 'SKILL_TOOL_DENIED' },
    ]);
  });

  it('throws the SKILL_TOOL_DENIED ToolError under errorMode failFast, as Armorer does', async () => {
    const { gated, executed } = harness();

    const thrown = await gated
      .execute({ id: 'call-write', name: 'write', arguments: {} }, { errorMode: 'failFast' })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(thrown).toEqual({
      code: 'SKILL_TOOL_DENIED',
      category: 'permission',
      retryable: false,
      message: REFUSAL('write'),
    });
    expect(executed).toEqual([]);
  });

  it('runs search, refuses write, and returns both results in call order', async () => {
    const { gated, executed } = harness();

    const results = await gated.execute([
      { id: 'call-write', name: 'write', arguments: {} },
      { id: 'call-search', name: 'search', arguments: {} },
      { id: 'call-write-2', name: 'write', arguments: {} },
    ]);

    expect(results.map((result) => result.toolCallId)).toEqual([
      'call-write',
      'call-search',
      'call-write-2',
    ]);
    expectRefusal(results[0]!, 'write', 'call-write');
    expect(results[1]?.outcome).toBe('success');
    expectRefusal(results[2]!, 'write', 'call-write-2');
    expect(executed).toEqual(['search']);
  });

  it('refuses every call of a batch when nothing is visible, without reaching the toolbox', async () => {
    const { gated, policy, executed } = harness();
    policy.current = { allowList: [] };

    const results = await gated.execute([
      { id: 'a', name: 'search', arguments: {} },
      { id: 'b', name: 'write', arguments: {} },
    ]);

    expect(results.map((result) => result.error?.code)).toEqual([
      'SKILL_TOOL_DENIED',
      'SKILL_TOOL_DENIED',
    ]);
    expect(executed).toEqual([]);
  });

  it('under failFast throws for a refused call in a mixed batch before running any call', async () => {
    const { gated, executed } = harness();

    const thrown = await gated
      .execute(
        [
          { id: 'call-search', name: 'search', arguments: {} },
          { id: 'call-write', name: 'write', arguments: {} },
        ],
        { errorMode: 'failFast' },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect((thrown as { code?: string } | undefined)?.code).toBe('SKILL_TOOL_DENIED');
    expect(executed).toEqual([]);
  });

  it('reads the policy once per batch, so a batch that activates a skill still runs write', async () => {
    const { gated, policy, executed } = harness();
    policy.current = undefined;

    const first = await gated.execute(
      [
        { id: 'call-activate', name: 'activate_skill', arguments: {} },
        { id: 'call-write', name: 'write', arguments: {} },
      ],
      { mode: 'sequential' },
    );

    expect(first.map((result) => result.outcome)).toEqual(['success', 'success']);
    expect(executed).toEqual(['activate_skill', 'write']);
    expect({ ...policy }.current).toEqual({ allowList: ['search'] });

    const next = await gated.execute({ id: 'call-write-2', name: 'write', arguments: {} });

    expectRefusal(next, 'write', 'call-write-2');
    expect(executed).toEqual(['activate_skill', 'write']);
  });

  it('leaves an unknown tool to the toolbox, which answers NOT_FOUND', async () => {
    const { gated, executed } = harness();

    const result = await gated.execute({ id: 'call-missing', name: 'nonexistent', arguments: {} });

    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe('NOT_FOUND');
    expect(executed).toEqual([]);
  });

  it.each([
    ['a toolbox built with resolution', true],
    ['a toolbox without resolution', false],
  ])('refuses a resolved name that would reach a hidden tool on %s', async (_label, resolution) => {
    const { gated, executed } = harness({ resolution });

    const result = await gated.execute({ id: 'call-Write', name: 'Write', arguments: {} });

    expectRefusal(result, 'write', 'call-Write');
    expect(executed).toEqual([]);
  });

  it('still lets a toolbox without resolution answer NOT_FOUND for a near-miss of a visible tool', async () => {
    const { gated, executed } = harness({ resolution: false });

    const result = await gated.execute({ id: 'call-Search', name: 'Search', arguments: {} });

    expect(result.error?.code).toBe('NOT_FOUND');
    expect(executed).toEqual([]);
  });

  it.each([
    ['a toolbox built with resolution', true],
    ['a toolbox without resolution', false],
  ])(
    'refuses a near-miss name of a hidden tool registered in two versions on %s',
    async (_label, resolution) => {
      const executed: string[] = [];
      const versioned = (name: string, version: string) =>
        createTool({
          name,
          version,
          description: `The ${name} tool at ${version}`,
          input: z.object({}),
          execute: async () => {
            executed.push(`${name}@${version}`);
            return `${name}@${version} ran`;
          },
        });
      const toolbox = createToolbox(
        [versioned('search', '1.0.0'), versioned('write', '1.0.0'), versioned('write', '2.0.0')],
        { resolution },
      );
      expect(toolbox.tools().filter((tool) => tool.name === 'write')).toHaveLength(2);
      const gated = withActiveSkillToolPolicy(toolbox, () => ({ allowList: ['search'] }));

      const results = await gated.execute([
        { id: 'call-Write', name: 'Write', arguments: {} },
        { id: 'call-namespaced', name: 'tools.write', arguments: {} },
        { id: 'call-write', name: 'write', arguments: {} },
      ]);

      expect(results.map((result) => result.error?.code)).toEqual([
        'SKILL_TOOL_DENIED',
        'SKILL_TOOL_DENIED',
        'SKILL_TOOL_DENIED',
      ]);
      expect(executed).toEqual([]);
    },
  );

  it('refuses a call that names a hidden tool by its id', async () => {
    const { gated, toolbox, executed } = harness();
    const writeId = toolbox.getTool('write')!.id;
    expect(writeId).not.toBe('write');

    const result = await gated.execute({ id: 'call-by-id', name: writeId, arguments: {} });

    expectRefusal(result, 'write', 'call-by-id');
    expect(executed).toEqual([]);
  });

  it('gives a call with no id a generated id in its refusal', async () => {
    const { gated } = harness();

    const result = await gated.execute({ name: 'write', arguments: {} });

    expect(result.error?.code).toBe('SKILL_TOOL_DENIED');
    expect(result.toolCallId.length).toBeGreaterThan(0);
    expect(result.callId).toBe(result.toolCallId);
  });

  it('keeps an allowed call durableOperationKey stable when an earlier call in its batch is refused', async () => {
    const refusedBatch = harness();
    const keysWhenRefused: Array<[string, number]> = [];
    await refusedBatch.gated.execute(
      [
        { id: 'call-write', name: 'write', arguments: {} },
        { id: 'call-search', name: 'search', arguments: {} },
      ],
      {
        durableOperationKey: (call: ToolCall, index: number) => {
          keysWhenRefused.push([call.name, index]);
          return `key:${call.name}:${index}`;
        },
      },
    );

    const allowedBatch = harness();
    allowedBatch.policy.current = undefined;
    const keysWhenAllowed: Array<[string, number]> = [];
    await allowedBatch.gated.execute(
      [
        { id: 'call-write', name: 'write', arguments: {} },
        { id: 'call-search', name: 'search', arguments: {} },
      ],
      {
        durableOperationKey: (call: ToolCall, index: number) => {
          keysWhenAllowed.push([call.name, index]);
          return `key:${call.name}:${index}`;
        },
      },
    );

    expect(keysWhenRefused).toEqual([['search', 1]]);
    expect(keysWhenAllowed.find(([name]) => name === 'search')).toEqual(['search', 1]);
  });

  it('passes every other option, and a string durableOperationKey, through unchanged', async () => {
    const { gated, toolbox } = harness();
    const seen: unknown[] = [];
    const original = toolbox.execute.bind(toolbox) as (...args: unknown[]) => Promise<unknown>;
    toolbox.execute = ((...args: unknown[]) => {
      seen.push(args[1]);
      return original(...args);
    }) as typeof toolbox.execute;
    const signal = new AbortController().signal;

    await gated.execute(
      [
        { id: 'call-write', name: 'write', arguments: {} },
        { id: 'call-search', name: 'search', arguments: {} },
      ],
      { signal, mode: 'sequential', durableOperationKey: 'fixed-key' },
    );

    expect(seen).toEqual([{ signal, mode: 'sequential', durableOperationKey: 'fixed-key' }]);
  });

  it('does not touch a batch with no refused call', async () => {
    const { gated, toolbox } = harness();
    const original = toolbox.execute.bind(toolbox) as (...args: unknown[]) => Promise<unknown>;
    const received: unknown[][] = [];
    toolbox.execute = ((...args: unknown[]) => {
      received.push(args);
      return original(...args);
    }) as typeof toolbox.execute;
    const calls = [{ id: 'call-search', name: 'search', arguments: {} }];
    const options = { mode: 'sequential' as const };

    await gated.execute(calls, options);

    expect(received).toHaveLength(1);
    expect(received[0]?.[0]).toBe(calls);
    expect(received[0]?.[1]).toBe(options);
  });

  it('settles an allowed call and a refused call once each in the same step', async () => {
    const { gated } = harness();
    const run = createActiveRun({
      generate: createMockGenerate([
        {
          content: '',
          toolCalls: [
            { id: 'call-search', name: 'search', arguments: {} },
            { id: 'call-write', name: 'write', arguments: {} },
          ],
        },
        { content: 'done', toolCalls: [] },
      ]),
      toolbox: gated,
      conversation: new Conversation(),
      runId: 'settle-once-run',
      stopWhen: ({ toolCalls }) => toolCalls.length === 0,
    });
    const settled: ToolSettledBubbleEvent[] = [];
    run.addEventListener('tool.settled', (event) => settled.push(event));

    await run.result;

    const statuses = Object.fromEntries(settled.map((event) => [event.toolCallId, event.status]));
    expect(settled).toHaveLength(2);
    expect(statuses).toEqual({ 'call-search': 'success', 'call-write': 'error' });
  });

  it('settles a streamed call once, when its stream ends', async () => {
    const stream = createTool({
      name: 'stream-tool',
      description: 'Streams',
      input: z.object({}),
      execute: async () =>
        (async function* () {
          yield 'a';
          yield 'b';
        })(),
    });
    const run = createActiveRun({
      generate: createMockGenerate([
        { content: '', toolCalls: [{ id: 'stream-1', name: 'stream-tool', arguments: {} }] },
        { content: 'done', toolCalls: [] },
      ]),
      toolbox: createToolbox([stream]),
      conversation: new Conversation(),
      runId: 'stream-run',
      collectAsync: true,
      executeOptions: { stream: true },
      stopWhen: ({ toolCalls }) => toolCalls.length === 0,
    });
    const settled: ToolSettledBubbleEvent[] = [];
    run.addEventListener('tool.settled', (event) => settled.push(event));

    await run.result;

    expect(settled.map((event) => [event.toolCallId, event.status])).toEqual([
      ['stream-1', 'success'],
    ]);
  });

  it('carries the reason on the tool.settled of a call the toolbox rejects before it runs', async () => {
    const { gated } = harness();
    const run = createActiveRun({
      generate: createMockGenerate([
        {
          content: '',
          toolCalls: [
            { id: 'call-missing', name: 'nonexistent', arguments: {} },
            { id: 'call-write', name: 'write', arguments: {} },
          ],
        },
        { content: 'done', toolCalls: [] },
      ]),
      toolbox: gated,
      conversation: new Conversation(),
      runId: 'reason-run',
      stopWhen: ({ toolCalls }) => toolCalls.length === 0,
    });
    const settled: ToolSettledBubbleEvent[] = [];
    run.addEventListener('tool.settled', (event) => settled.push(event));

    await run.result;

    const byCall = Object.fromEntries(settled.map((event) => [event.toolCallId, event]));
    expect(byCall['call-missing']?.status).toBe('error');
    expect(JSON.stringify(byCall['call-missing']?.error)).toContain('NOT_FOUND');
    expect(JSON.stringify(byCall['call-write']?.error)).toContain('SKILL_TOOL_DENIED');
  });

  it('records the refusal in the run when a model asks for a hidden tool and then a visible one', async () => {
    const { gated, executed } = harness();
    const run = createActiveRun({
      generate: createMockGenerate([
        {
          content: '',
          toolCalls: [
            { id: 'call-write', name: 'write', arguments: {} },
            { id: 'call-search', name: 'search', arguments: {} },
          ],
        },
        { content: 'done', toolCalls: [] },
      ]),
      toolbox: gated,
      conversation: new Conversation(),
      stopWhen: ({ toolCalls }) => toolCalls.length === 0,
    });

    const result = await run.result;

    expect(executed).toEqual(['search']);
    const firstStep = result.steps[0]!;
    expect(firstStep.results.map((entry) => [entry.toolCallId, entry.outcome])).toEqual([
      ['call-write', 'error'],
      ['call-search', 'success'],
    ]);
  });
});
