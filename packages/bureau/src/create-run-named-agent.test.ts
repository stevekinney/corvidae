/**
 * COR-1577 — a session run that names a catalog agent runs that agent: its own `generate`, tools,
 * system prompt and stop conditions, under the Bureau's policy. These tests drive `createRun`
 * through a Bureau with two scripted agents beside a Bureau-wide runtime that must never answer a
 * named run.
 */
import {
  createAgent,
  createAgentSession,
  createSessionStore,
  type GenerateFunction,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory, getMessages } from 'conversationalist';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import { BureauError, createBureau } from './create-bureau';
import { waitForRunState } from './test';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { Bureau, BureauOptions } from './types';

const bureaus: Bureau<AgentDefinitions>[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

function namedTool(name: string) {
  return createTool({
    name,
    description: name,
    input: z.object({}),
    execute: async () => name,
  });
}

/** What a scripted `generate` saw on each of its calls. */
type Observation = {
  readonly tools: string[];
  readonly systemPrompt: string | undefined;
  readonly maximumTokens: number | undefined;
};

/** A generate that answers `reply` once, recording what it was offered. */
function scripted(reply: string, observed: Observation[] = []): GenerateFunction {
  return async ({ toolbox, conversation, maximumTokens }) => {
    const system = conversation.getFirstSystemMessage()?.content;
    observed.push({
      tools: toolbox
        .tools()
        .map((tool) => tool.name)
        .toSorted(),
      systemPrompt: typeof system === 'string' ? system : undefined,
      maximumTokens,
    });
    return { content: reply, toolCalls: [] };
  };
}

/** A generate that calls a tool on every step, so only a cap or a stop condition ends the run. */
function forever(observed: Observation[]): GenerateFunction {
  return async ({ toolbox, conversation, maximumTokens }) => {
    const system = conversation.getFirstSystemMessage()?.content;
    observed.push({
      tools: toolbox.tools().map((tool) => tool.name),
      systemPrompt: typeof system === 'string' ? system : undefined,
      maximumTokens,
    });
    return { content: 'again', toolCalls: [{ name: 'tick', arguments: {} }] };
  };
}

async function start(
  options: Partial<BureauOptions<AgentDefinitions>> & { agents: AgentDefinitions },
): Promise<Bureau<AgentDefinitions>> {
  const bureau = await createBureau<AgentDefinitions>({
    ...(options.storage === undefined ? { persistence: textValueStore(new MemoryStorage()) } : {}),
    stopWhen: stopWhen.noToolCalls(),
    ...options,
  });
  bureaus.push(bureau);
  return bureau;
}

async function replies(bureau: Bureau<AgentDefinitions>, sessionId: string): Promise<string[]> {
  const session = await bureau.getSession(sessionId);
  if (session === undefined) throw new Error(`Expected session "${sessionId}".`);
  return getMessages(session.conversationHistory)
    .filter((message) => message.role === 'assistant')
    .map((message) => (typeof message.content === 'string' ? message.content : ''));
}

async function finish(bureau: Bureau<AgentDefinitions>, runId: string): Promise<void> {
  await waitForRunState(bureau, runId);
  // Let the terminal session save land: a macrotask turn advances Weft's deferred launch queue.
  for (let turn = 0; turn < 10; turn += 1) await yieldToPortableEventLoop();
}

/** `agent`, resolving the token cap a `createAgent` agent has no option for. */
function withMaximumTokens<TAgent extends AgentDefinitions[string]>(
  agent: TAgent,
  maximumTokens: number,
): TAgent {
  const resolve = Reflect.get(agent, OPERATIVE_RESOLVE_RUN_OPTIONS) as (
    ...args: unknown[]
  ) => Promise<Record<string, unknown>>;
  return {
    ...agent,
    [OPERATIVE_RESOLVE_RUN_OPTIONS]: async (...args: unknown[]) => ({
      ...(await resolve.apply(agent, args)),
      maximumTokens,
    }),
  };
}

describe('createRun with a named agent', () => {
  it('runs each agent’s own script and tools, never the Bureau-wide ones', async () => {
    const wide: Observation[] = [];
    const first: Observation[] = [];
    const second: Observation[] = [];
    const bureau = await start({
      agents: {
        alpha: createAgent({
          generate: scripted('alpha speaking', first),
          toolbox: createToolbox([namedTool('alpha-tool')]),
        }),
        beta: createAgent({
          generate: scripted('beta speaking', second),
          toolbox: createToolbox([namedTool('beta-tool'), namedTool('beta-extra')]),
        }),
      },
      generate: scripted('bureau speaking', wide),
      toolbox: createToolbox([namedTool('bureau-tool')]),
    });

    const alpha = await bureau.createRun({ message: 'hello', agentName: 'alpha' });
    const beta = await bureau.createRun({ message: 'hello', agentName: 'beta' });
    await finish(bureau, alpha.id);
    await finish(bureau, beta.id);

    expect(await replies(bureau, alpha.sessionId)).toEqual(['alpha speaking']);
    expect(await replies(bureau, beta.sessionId)).toEqual(['beta speaking']);
    expect(first.map((seen) => seen.tools)).toEqual([['alpha-tool']]);
    expect(second.map((seen) => seen.tools)).toEqual([['beta-extra', 'beta-tool']]);
    expect(wide).toEqual([]);
  });

  it('offers the Bureau’s opt-in tools beside the agent’s own on a durable Bureau', async () => {
    const seen: Observation[] = [];
    const bureau = await start({
      agents: {
        alpha: createAgent({
          generate: scripted('ok', seen),
          toolbox: createToolbox([namedTool('alpha-tool')]),
        }),
      },
      generate: scripted('wide'),
      toolbox: createToolbox([namedTool('bureau-tool')]),
      storage: { type: 'memory' },
      durableExecution: true,
      humanInput: true,
    });

    const run = await bureau.createRun({ message: 'hello', agentName: 'alpha' });
    await finish(bureau, run.id);

    expect(seen.map((entry) => entry.tools)).toEqual([['alpha-tool', 'requestHumanInput']]);
  });

  it('leaves requestHumanInput out without the option or without a durable engine', async () => {
    const withoutOption: Observation[] = [];
    const nonDurable: Observation[] = [];
    const durableWithoutOption = await start({
      agents: { alpha: createAgent({ generate: scripted('ok', withoutOption) }) },
      generate: scripted('wide'),
      toolbox: createToolbox([]),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    const optionWithoutEngine = await start({
      agents: { alpha: createAgent({ generate: scripted('ok', nonDurable) }) },
      generate: scripted('wide'),
      toolbox: createToolbox([]),
      humanInput: true,
    });

    const one = await durableWithoutOption.createRun({ message: 'hi', agentName: 'alpha' });
    const two = await optionWithoutEngine.createRun({ message: 'hi', agentName: 'alpha' });
    await finish(durableWithoutOption, one.id);
    await finish(optionWithoutEngine, two.id);

    expect(withoutOption.flatMap((entry) => entry.tools)).not.toContain('requestHumanInput');
    expect(nonDurable.flatMap((entry) => entry.tools)).not.toContain('requestHumanInput');
  });

  it('leaves an unnamed run on a new session with the Bureau-wide runtime', async () => {
    const wide: Observation[] = [];
    const agent: Observation[] = [];
    const bureau = await start({
      agents: { alpha: createAgent({ generate: scripted('alpha', agent) }) },
      generate: scripted('bureau speaking', wide),
      toolbox: createToolbox([namedTool('bureau-tool')]),
      systemPrompt: 'BUREAU PROMPT',
    });

    const run = await bureau.createRun({ message: 'hello' });
    await finish(bureau, run.id);

    expect(await replies(bureau, run.sessionId)).toEqual(['bureau speaking']);
    expect(wide).toEqual([
      { tools: ['bureau-tool'], systemPrompt: 'BUREAU PROMPT', maximumTokens: undefined },
    ]);
    expect(agent).toEqual([]);
    const stored = await bureau.getSession(run.sessionId);
    expect(stored?.agentName).toBe('bureau');
  });
});

describe('an agent that is not in the catalog', () => {
  it('is refused with NOT_FOUND before anything is persisted', async () => {
    const bureau = await start({
      agents: { alpha: createAgent({ generate: scripted('alpha') }) },
      generate: scripted('wide'),
      toolbox: createToolbox([]),
    });

    const refusal = await rejectionOf(
      bureau.createRun({ message: 'hello', agentName: 'ghost', sessionId: 'session-ghost' }),
    );

    expect(refusal).toBeInstanceOf(BureauError);
    expect((refusal as BureauError).code).toBe('NOT_FOUND');
    expect(bureau.listRuns()).toEqual([]);
    expect(await bureau.listSessions()).toEqual([]);
  });

  it('is refused for an unnamed run on a session whose stored agent is gone', async () => {
    const persistence = textValueStore(new MemoryStorage());
    const bureau = await start({
      agents: { alpha: createAgent({ generate: scripted('alpha') }) },
      generate: scripted('wide'),
      toolbox: createToolbox([]),
      persistence,
    });
    // A session an earlier process bound to an agent this catalog no longer has.
    await createSessionStore(persistence).save(
      createAgentSession({
        id: 'session-orphan',
        agentName: 'retired',
        conversationHistory: createConversationHistory({ id: 'session-orphan' }),
      }),
    );
    const before = await bureau.getSession('session-orphan');

    const refusal = await rejectionOf(
      bureau.createRun({ message: 'hello', sessionId: 'session-orphan' }),
    );

    expect((refusal as BureauError).code).toBe('NOT_FOUND');
    expect(bureau.listRuns()).toEqual([]);
    expect(await bureau.getSession('session-orphan')).toEqual(before);
  });
});

describe('a session’s agent', () => {
  it('is the one that created it, and a run that names another is refused', async () => {
    const bureau = await start({
      agents: {
        alpha: createAgent({ generate: scripted('alpha speaking') }),
        beta: createAgent({ generate: scripted('beta speaking') }),
      },
      generate: scripted('bureau speaking'),
      toolbox: createToolbox([]),
    });
    const first = await bureau.createRun({ message: 'one', agentName: 'alpha' });
    await finish(bureau, first.id);

    const other = await rejectionOf(
      bureau.createRun({ message: 'two', agentName: 'beta', sessionId: first.sessionId }),
    );

    expect((other as BureauError).code).toBe('BAD_REQUEST');
    expect(bureau.listRuns().map((run) => run.id)).toEqual([first.id]);
  });

  it('is never promoted from the default agent to a named one', async () => {
    const bureau = await start({
      agents: { assistant: createAgent({ generate: scripted('assistant speaking') }) },
      generate: scripted('bureau speaking'),
      toolbox: createToolbox([]),
    });
    const first = await bureau.createRun({ message: 'one' });
    await finish(bureau, first.id);

    const promotion = await rejectionOf(
      bureau.createRun({ message: 'two', agentName: 'assistant', sessionId: first.sessionId }),
    );

    expect((promotion as BureauError).code).toBe('BAD_REQUEST');
    const stored = await bureau.getSession(first.sessionId);
    expect(stored?.agentName).toBe('bureau');
  });

  it('is inherited by a later run that names no agent, or the same one', async () => {
    const bureau = await start({
      agents: { alpha: createAgent({ generate: scripted('alpha speaking') }) },
      generate: scripted('bureau speaking'),
      toolbox: createToolbox([]),
    });
    const first = await bureau.createRun({ message: 'one', agentName: 'alpha' });
    await finish(bureau, first.id);
    const second = await bureau.createRun({ message: 'two', sessionId: first.sessionId });
    await finish(bureau, second.id);
    const third = await bureau.createRun({
      message: 'three',
      agentName: 'alpha',
      sessionId: first.sessionId,
    });
    await finish(bureau, third.id);

    expect(await replies(bureau, first.sessionId)).toEqual([
      'alpha speaking',
      'alpha speaking',
      'alpha speaking',
    ]);
  });
});

/** `agent`, whose resolution waits at `barrier` until every run racing on it has reached it. */
function withResolveBarrier<TAgent extends AgentDefinitions[string]>(
  agent: TAgent,
  barrier: { arrive(): Promise<void> },
): TAgent {
  const resolve = Reflect.get(agent, OPERATIVE_RESOLVE_RUN_OPTIONS) as (
    ...args: unknown[]
  ) => Promise<Record<string, unknown>>;
  return {
    ...agent,
    [OPERATIVE_RESOLVE_RUN_OPTIONS]: async (...args: unknown[]) => {
      await barrier.arrive();
      return resolve.apply(agent, args);
    },
  };
}

function barrierOf(parties: number) {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    async arrive() {
      arrived += 1;
      if (arrived >= parties) open();
      await opened;
    },
  };
}

describe('two runs creating one new session', () => {
  it('lets the first agent bind it and refuses the other before it executes', async () => {
    const barrier = barrierOf(2);
    const calls = { alpha: 0, beta: 0 };
    const counting = (name: 'alpha' | 'beta'): GenerateFunction => {
      return async () => {
        calls[name] += 1;
        return { content: `${name} speaking`, toolCalls: [] };
      };
    };
    const bureau = await start({
      agents: {
        alpha: withResolveBarrier(createAgent({ generate: counting('alpha') }), barrier),
        beta: withResolveBarrier(createAgent({ generate: counting('beta') }), barrier),
      },
    });

    const outcomes = await Promise.allSettled([
      bureau.createRun({ message: 'a', agentName: 'alpha', sessionId: 'shared-session' }),
      bureau.createRun({ message: 'b', agentName: 'beta', sessionId: 'shared-session' }),
    ]);

    const [first, second] = outcomes;
    const winnerIndex = first?.status === 'fulfilled' ? 0 : 1;
    const winnerName = winnerIndex === 0 ? 'alpha' : 'beta';
    const loserName = winnerIndex === 0 ? 'beta' : 'alpha';
    const winner = outcomes[winnerIndex];
    const loser = outcomes[1 - winnerIndex];
    expect(winner?.status).toBe('fulfilled');
    expect(loser?.status).toBe('rejected');
    expect(((loser as PromiseRejectedResult).reason as BureauError).code).toBe('BAD_REQUEST');
    await finish(bureau, (winner as PromiseFulfilledResult<{ id: string }>).value.id);

    // Only the winner's run exists, the session is bound to the winner, and the loser never ran.
    expect(bureau.listRuns()).toHaveLength(1);
    const stored = await bureau.getSession('shared-session');
    expect(stored?.agentName).toBe(winnerName);
    expect(calls[winnerName]).toBe(1);
    expect(calls[loserName]).toBe(0);
    expect(second).toBeDefined();
  });
});

describe('run settings', () => {
  const tick = createTool({
    name: 'tick',
    description: 'tick',
    input: z.object({}),
    execute: async () => 'tick',
  });

  it('take the request’s value, then the agent’s, then the Bureau’s', async () => {
    const seen: Observation[] = [];
    const bureau = await start({
      agents: {
        alpha: withMaximumTokens(
          createAgent({
            generate: scripted('alpha', seen),
            toolbox: createToolbox([]),
            instructions: 'AGENT PROMPT',
          }),
          111,
        ),
        plain: createAgent({ generate: scripted('plain', seen), toolbox: createToolbox([]) }),
      },
      generate: scripted('wide'),
      toolbox: createToolbox([]),
      systemPrompt: 'BUREAU PROMPT',
    });

    const fromAgent = await bureau.createRun({ message: 'a', agentName: 'alpha' });
    const fromRequest = await bureau.createRun({
      message: 'b',
      agentName: 'alpha',
      systemPrompt: 'REQUEST PROMPT',
      maximumTokens: 222,
    });
    const fromBureau = await bureau.createRun({ message: 'c', agentName: 'plain' });
    await finish(bureau, fromAgent.id);
    await finish(bureau, fromRequest.id);
    await finish(bureau, fromBureau.id);

    expect(seen).toEqual([
      { tools: [], systemPrompt: 'AGENT PROMPT', maximumTokens: 111 },
      { tools: [], systemPrompt: 'REQUEST PROMPT', maximumTokens: 222 },
      { tools: [], systemPrompt: 'BUREAU PROMPT', maximumTokens: undefined },
    ]);
  });

  it('cap the steps by the request, then the agent, then the Bureau', async () => {
    const stepsOf = async (
      agentSteps: number | undefined,
      requestSteps: number | undefined,
    ): Promise<number> => {
      const seen: Observation[] = [];
      const bureau = await start({
        agents: {
          alpha: createAgent({
            generate: forever(seen),
            toolbox: createToolbox([tick]),
            stopWhen: [],
            ...(agentSteps === undefined ? {} : { maximumSteps: agentSteps }),
          }),
        },
        generate: scripted('wide'),
        toolbox: createToolbox([]),
        maximumSteps: 6,
      });
      const run = await bureau.createRun({
        message: 'go',
        agentName: 'alpha',
        ...(requestSteps === undefined ? {} : { maximumSteps: requestSteps }),
      });
      await finish(bureau, run.id);
      return seen.length;
    };

    expect(await stepsOf(undefined, undefined)).toBe(6);
    expect(await stepsOf(3, undefined)).toBe(3);
    expect(await stepsOf(3, 2)).toBe(2);
  });

  it('stop the run on the agent’s conditions rather than the Bureau’s', async () => {
    const seen: Observation[] = [];
    const bureau = await start({
      agents: {
        alpha: createAgent({
          generate: forever(seen),
          toolbox: createToolbox([tick]),
          stopWhen: stopWhen.toolCalled('tick'),
        }),
      },
      generate: scripted('wide'),
      toolbox: createToolbox([]),
      // Never stops on its own: a run that used it would go to the step cap.
      stopWhen: [],
      maximumSteps: 5,
    });

    const run = await bureau.createRun({ message: 'go', agentName: 'alpha' });
    await finish(bureau, run.id);

    expect(seen).toHaveLength(1);
  });
});

describe('a Bureau with only catalog agents', () => {
  it('accepts a named run and refuses an unnamed one as not configured', async () => {
    const bureau = await start({
      agents: { alpha: createAgent({ generate: scripted('alpha speaking') }) },
    });

    const named = await bureau.createRun({ message: 'hello', agentName: 'alpha' });
    await finish(bureau, named.id);
    const unnamed = await rejectionOf(bureau.createRun({ message: 'hello' }));

    expect(await replies(bureau, named.sessionId)).toEqual(['alpha speaking']);
    expect((unnamed as BureauError).code).toBe('NOT_CONFIGURED');
  });
});
