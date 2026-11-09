/**
 * COR-2106 — a child dispatched under Bureau gets Bureau's invariant tier, and a child with no
 * run-options resolver is refused. A child dispatched outside Bureau is untouched.
 */
import { CompletableEventTarget, HookRegistry } from '@lostgradient/lifecycle';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  type BureauChildInvariantRequest,
  type BureauChildInvariants,
  readBureauInvariants,
  withBureauInvariants,
} from './bureau-invariants';
import { createChildRunRegistry, dispatchChildRun } from './child-run';
import { createAgent } from './create-agent';
import { createLazyAgent } from './create-lazy-agent';
import { createSubagentTool } from './create-subagent-tool';
import { AgentContractError, SubagentRunError } from './errors';
import { ChildWorkflowFailedEvent, type CombinedOperativeEventMap } from './events';
import type { OperativeHookMap } from './hooks';
import {
  type AgentInput,
  type AgentRunContext,
  hasDefinitionResolver,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  type RunnableAgent,
} from './runnable-agent';
import type { GenerateFunction, GenerateResponse } from './types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

/** A generate that records every system message it is handed, so a hook is observable in a run. */
function recordingGenerate(seen: string[], content = 'done'): GenerateFunction {
  return async (request) => {
    for (const message of request.conversation.getMessages()) {
      if (message.role === 'system' && typeof message.content === 'string') {
        seen.push(message.content);
      }
    }
    return textResponse(content);
  };
}

function markerHook(marker: string) {
  return async (context: {
    step: number;
    conversation: { appendSystemMessage(text: string): unknown };
  }) => {
    if (context.step === 0) context.conversation.appendSystemMessage(marker);
  };
}

/**
 * A stand-in for Bureau's tiers that records what each child asked it for. With `plugin`, it also
 * hands the child a plugin tier, as a Bureau whose plugins apply an interceptor to every agent does.
 */
function makeInvariants(options: { plugin?: boolean } = {}): {
  invariants: BureauChildInvariants;
  requests: BureauChildInvariantRequest[];
} {
  const requests: BureauChildInvariantRequest[] = [];
  const invariants: BureauChildInvariants = (request) => {
    requests.push(request);
    const bureau = new HookRegistry<OperativeHookMap>({ source: 'bureau' });
    bureau.on('prepareStep', markerHook('BUREAU-IDENTITY'), { id: 'bureau:identity' });
    if (options.plugin !== true) return { bureau, plugin: undefined };
    const plugin = new HookRegistry<OperativeHookMap>({ source: 'audit' });
    plugin.on('prepareStep', markerHook('PLUGIN-TIER'), { id: 'audit:marker:prepareStep' });
    return { bureau, plugin };
  };
  return { invariants, requests };
}

/** A hand-written agent with no run-options resolver: it builds its options inside `run()`. */
function makeResolverlessAgent(name: string): { agent: RunnableAgent; calls: AgentInput[] } {
  const calls: AgentInput[] = [];
  const inner = createAgent({ name, generate: async () => textResponse('resolverless ran') });
  return {
    calls,
    agent: {
      name,
      hasOutput: false,
      run(input: AgentInput, context?: AgentRunContext) {
        calls.push(input);
        return inner.run(input, context);
      },
    },
  };
}

function resolveOf(agent: object) {
  if (!hasDefinitionResolver(agent)) throw new Error('expected an agent with a resolver');
  return (input: AgentInput, context?: AgentRunContext) =>
    agent[OPERATIVE_RESOLVE_RUN_OPTIONS](input, context);
}

const dispatchOptions = { agentName: 'worker', parentRunId: 'parent-1' } as const;

describe('child dispatch under Bureau (COR-2106)', () => {
  it('merges Bureau’s tier in front of a child that has a resolver, keeping the child’s own', async () => {
    const seen: string[] = [];
    const childHooks = new HookRegistry<OperativeHookMap>({ source: 'agent' });
    childHooks.on('prepareStep', markerHook('CHILD-TIER'), { id: 'child:marker' });
    const child = createAgent({
      name: 'worker',
      generate: recordingGenerate(seen),
      hooks: childHooks,
    });
    const { invariants, requests } = makeInvariants();

    const handle = dispatchChildRun(child, 'go', withBureauInvariants(dispatchOptions, invariants));
    const result = await handle.result();

    expect(result.content).toBe('done');
    expect(seen).toContain('BUREAU-IDENTITY');
    expect(seen).toContain('CHILD-TIER');
    // A `createAgent` child resolves its own guardrails, so Bureau registers none for it.
    expect(requests).toMatchObject([{ agentResolvesGuardrails: true }]);
  });

  // COR-2127 — the plugin tier reaches a child through the same seam, between Bureau's and the
  // child's own.
  it('merges the plugin tier between Bureau’s and the child’s own', async () => {
    const seen: string[] = [];
    const childHooks = new HookRegistry<OperativeHookMap>({ source: 'agent' });
    childHooks.on('prepareStep', markerHook('CHILD-TIER'), { id: 'child:marker' });
    const child = createAgent({
      name: 'worker',
      generate: recordingGenerate(seen),
      hooks: childHooks,
    });
    const { invariants } = makeInvariants({ plugin: true });

    await dispatchChildRun(child, 'go', withBureauInvariants(dispatchOptions, invariants)).result();

    expect(seen).toEqual(['BUREAU-IDENTITY', 'PLUGIN-TIER', 'CHILD-TIER']);
  });

  it('asks for Bureau’s guardrails for a resolver-bearing agent that does not resolve its own', async () => {
    const seen: string[] = [];
    const inner = createAgent({ name: 'worker', generate: recordingGenerate(seen) });
    const handWritten: RunnableAgent = {
      name: 'worker',
      hasOutput: false,
      run: (input, context) => inner.run(input, context),
      [OPERATIVE_RESOLVE_RUN_OPTIONS]: (input: AgentInput, context?: AgentRunContext) =>
        resolveOf(inner)(input, context),
    } as RunnableAgent;
    const { invariants, requests } = makeInvariants();

    await dispatchChildRun(
      handWritten,
      'go',
      withBureauInvariants(dispatchOptions, invariants),
    ).result();

    expect(requests).toMatchObject([{ agentResolvesGuardrails: false }]);
    expect(seen).toContain('BUREAU-IDENTITY');
  });

  it('refuses a child with no resolver, names it, runs nothing, and fails through the child path', () => {
    const { agent, calls } = makeResolverlessAgent('worker');
    const { invariants } = makeInvariants();
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const failed: string[] = [];
    emitter.addEventListener('multiagent.child-workflow.failed', (event) => {
      if (event instanceof ChildWorkflowFailedEvent) failed.push(event.reason ?? '');
    });
    const registry = createChildRunRegistry();

    let thrown: unknown;
    try {
      dispatchChildRun(
        agent,
        'go',
        withBureauInvariants({ ...dispatchOptions, emitter, registry }, invariants),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AgentContractError);
    expect((thrown as Error).message).toContain('"worker"');
    expect(calls).toEqual([]);
    expect(failed).toHaveLength(1);
    expect(registry.children().map((child) => child.status)).toEqual(['failed']);
  });

  it('refuses a lazy child whose module has no resolver, naming the child, and runs nothing', async () => {
    const { agent, calls } = makeResolverlessAgent('worker');
    const lazy = createLazyAgent(async () => agent, { label: 'worker-module' });
    const { invariants } = makeInvariants();

    const result = await dispatchChildRun(
      lazy,
      'go',
      withBureauInvariants(dispatchOptions, invariants),
    ).result();

    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(AgentContractError);
    expect(String(result.error)).toContain('Child agent "worker" exposes no run-options');
    expect(calls).toEqual([]);
  });

  it('shows the parent the refusal as the failure of its delegate tool call', async () => {
    const { agent } = makeResolverlessAgent('worker');
    const { invariants } = makeInvariants();
    const tool = createSubagentTool({
      name: 'delegate',
      description: 'Delegate',
      agent,
      agentName: 'worker',
      input: z.object({ q: z.string() }),
    });
    const parentSaw: string[] = [];
    let step = 0;
    const parent = createAgent({
      name: 'supervisor',
      toolbox: createToolbox([tool]),
      generate: async (request) => {
        const settled = await recordingGenerate(parentSaw, 'parent done')(request);
        return step++ === 0
          ? { content: '', toolCalls: [{ id: 'c1', name: 'delegate', arguments: { q: 'hi' } }] }
          : settled;
      },
    });

    const run = parent.run('go', withBureauInvariants({}, invariants));
    const result = await run.result();

    const messages = JSON.stringify(result.conversation.getMessages());
    expect(messages).toContain('exposes no run-options resolver');
    expect(messages).toContain('worker');
  });

  it('hands a child created through a Bureau-owned parent’s tool call Bureau’s tier', async () => {
    const childSaw: string[] = [];
    const child = createAgent({ name: 'worker', generate: recordingGenerate(childSaw) });
    const tool = createSubagentTool({
      name: 'delegate',
      description: 'Delegate',
      agent: child,
      agentName: 'worker',
      input: z.object({ q: z.string() }),
    });
    const { invariants } = makeInvariants();
    let step = 0;
    const parent = createAgent({
      name: 'supervisor',
      toolbox: createToolbox([tool]),
      generate: async () =>
        step++ === 0
          ? { content: '', toolCalls: [{ id: 'c1', name: 'delegate', arguments: { q: 'hi' } }] }
          : textResponse('parent done'),
    });

    await parent.run('go', withBureauInvariants({}, invariants)).result();

    expect(childSaw).toContain('BUREAU-IDENTITY');
  });

  it('carries the tier through to a grandchild', async () => {
    const grandchildSaw: string[] = [];
    const grandchild = createAgent({
      name: 'grandchild',
      generate: recordingGenerate(grandchildSaw),
    });
    const toGrandchild = createSubagentTool({
      name: 'delegate-again',
      description: 'Delegate',
      agent: grandchild,
      agentName: 'grandchild',
      input: z.object({ q: z.string() }),
    });
    let childStep = 0;
    const child = createAgent({
      name: 'worker',
      toolbox: createToolbox([toGrandchild]),
      generate: async () =>
        childStep++ === 0
          ? {
              content: '',
              toolCalls: [{ id: 'g1', name: 'delegate-again', arguments: { q: 'hi' } }],
            }
          : textResponse('child done'),
    });
    const { invariants } = makeInvariants();

    await dispatchChildRun(child, 'go', withBureauInvariants(dispatchOptions, invariants)).result();

    expect(grandchildSaw).toContain('BUREAU-IDENTITY');
  });

  it('ignores a key a caller invents for the tier: the symbol is private to the module', async () => {
    const seen: string[] = [];
    const child = createAgent({ name: 'worker', generate: recordingGenerate(seen) });
    const { invariants, requests } = makeInvariants();
    const forged = {
      ...dispatchOptions,
      [Symbol.for('@lostgradient/operative/bureau-invariants')]: invariants,
      bureauInvariants: invariants,
      invariants,
    };

    await dispatchChildRun(child, 'go', forged).result();

    // No declared field to write it under, so a caller's context cannot name the tier either.
    // @ts-expect-error — `AgentRunContext` has no `bureauInvariants` field.
    const context: AgentRunContext = { bureauInvariants: invariants };
    expect(readBureauInvariants(context)).toBeUndefined();
    expect(readBureauInvariants(forged)).toBeUndefined();
    expect(requests).toEqual([]);
    expect(seen).not.toContain('BUREAU-IDENTITY');
  });
});

describe('child dispatch outside Bureau (COR-2106)', () => {
  it('still runs a child with no resolver through agent.run()', async () => {
    const { agent, calls } = makeResolverlessAgent('worker');

    const result = await dispatchChildRun(agent, 'go', dispatchOptions).result();

    expect(calls).toEqual(['go']);
    expect(result.content).toBe('resolverless ran');
  });

  it('leaves a child that has a resolver exactly as it was: no tier is added', async () => {
    const seen: string[] = [];
    const child = createAgent({ name: 'worker', generate: recordingGenerate(seen) });

    await dispatchChildRun(child, 'go', dispatchOptions).result();

    expect(seen).not.toContain('BUREAU-IDENTITY');
  });

  it('surfaces a resolver-less child of a standalone parent through createSubagentTool as before', async () => {
    const { agent } = makeResolverlessAgent('worker');
    const tool = createSubagentTool({
      name: 'delegate',
      description: 'Delegate',
      agent,
      agentName: 'worker',
      input: z.object({ q: z.string() }),
    });

    const output = await tool.execute({ q: 'hi' }, {}).catch((error: unknown) => error);

    expect(output).not.toBeInstanceOf(SubagentRunError);
    expect(JSON.stringify(output)).toContain('resolverless ran');
  });
});
