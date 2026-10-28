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
  DEFAULT_MAXIMUM_STEPS,
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
import { listHeldTasks, waitForTaskState } from './test';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import type { Bureau, BureauOptions } from './types';
import { storageOverTextStore } from './testing/text-store-storage.test-support';

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
    ...(options.storage === undefined ? { storage: { type: 'memory' }, durable: false } : {}),
    ...options,
  });
  bureaus.push(bureau);
  return bureau;
}

async function replies(bureau: Bureau<AgentDefinitions>, sessionId: string): Promise<string[]> {
  const session = await bureau.contexts.get(sessionId);
  if (session === undefined) throw new Error(`Expected session "${sessionId}".`);
  return getMessages(session.conversationHistory)
    .filter((message) => message.role === 'assistant')
    .map((message) => (typeof message.content === 'string' ? message.content : ''));
}

async function finish(bureau: Bureau<AgentDefinitions>, runId: string): Promise<void> {
  await waitForTaskState(bureau, runId);
  // Let the terminal session save land: a macrotask turn advances Weft's deferred launch queue.
  // load-proof: the work these turns let finish runs on in-memory storage and doubles and settles through promise continuations only, so a microtask drain completes it (checked by replacing the turns with one); no timer or I/O is pending
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

describe('tasks.start with a named agent', () => {
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
        default: createAgent({
          generate: scripted('bureau speaking', wide),
          toolbox: createToolbox([namedTool('bureau-tool')]),
        }),
      },
    });

    const alpha = await bureau.tasks.start('alpha', 'hello');
    const beta = await bureau.tasks.start('beta', 'hello');
    await finish(bureau, alpha.id);
    await finish(bureau, beta.id);

    expect(await replies(bureau, alpha.contextId)).toEqual(['alpha speaking']);
    expect(await replies(bureau, beta.contextId)).toEqual(['beta speaking']);
    expect(first.map((seen) => seen.tools)).toEqual([['alpha-tool']]);
    expect(second.map((seen) => seen.tools)).toEqual([['beta-extra', 'beta-tool']]);
    expect(wide).toEqual([]);
  });

  it('offers the Bureau’s tools beside the agent’s own on a durable Bureau', async () => {
    const seen: Observation[] = [];
    const bureau = await start({
      agents: {
        alpha: createAgent({
          generate: scripted('ok', seen),
          toolbox: createToolbox([namedTool('alpha-tool')]),
        }),
        default: createAgent({
          generate: scripted('wide'),
          toolbox: createToolbox([namedTool('bureau-tool')]),
        }),
      },
      storage: { type: 'memory' },
      durable: true,
    });

    const run = await bureau.tasks.start('alpha', 'hello');
    await finish(bureau, run.id);

    expect(seen.map((entry) => entry.tools)).toEqual([
      ['alpha-tool', 'requestHumanInput', 'scheduleWakeup'],
    ]);
  });

  it('leaves requestHumanInput out under humanInput: false or without a durable engine', async () => {
    const optedOut: Observation[] = [];
    const nonDurable: Observation[] = [];
    const optedOutBureau = await start({
      agents: {
        alpha: createAgent({ generate: scripted('ok', optedOut) }),
        default: createAgent({ generate: scripted('wide'), toolbox: createToolbox([]) }),
      },
      storage: { type: 'memory' },
      durable: true,
      humanInput: false,
    });
    const nonDurableBureau = await start({
      agents: {
        alpha: createAgent({ generate: scripted('ok', nonDurable) }),
        default: createAgent({ generate: scripted('wide'), toolbox: createToolbox([]) }),
      },
    });

    const one = await optedOutBureau.tasks.start('alpha', 'hi');
    const two = await nonDurableBureau.tasks.start('alpha', 'hi');
    await finish(optedOutBureau, one.id);
    await finish(nonDurableBureau, two.id);

    expect(optedOut.flatMap((entry) => entry.tools)).not.toContain('requestHumanInput');
    expect(nonDurable.flatMap((entry) => entry.tools)).not.toContain('requestHumanInput');
  });
});

describe('an agent that is not in the catalog', () => {
  it('is refused with NOT_FOUND before anything is persisted', async () => {
    const bureau = await start({
      agents: {
        alpha: createAgent({ generate: scripted('alpha') }),
        default: createAgent({ generate: scripted('wide'), toolbox: createToolbox([]) }),
      },
    });

    const refusal = await rejectionOf(
      bureau.tasks.start('ghost', 'hello', { contextId: 'session-ghost' }),
    );

    expect(refusal).toBeInstanceOf(BureauError);
    expect((refusal as BureauError).code).toBe('NOT_FOUND');
    expect(listHeldTasks(bureau)).toEqual([]);
    expect(await bureau.contexts.list()).toEqual([]);
  });

  it('is refused for a run on a session whose stored agent is gone', async () => {
    const persistence = textValueStore(new MemoryStorage());
    const bureau = await start({
      agents: {
        alpha: createAgent({ generate: scripted('alpha') }),
        default: createAgent({ generate: scripted('wide'), toolbox: createToolbox([]) }),
      },
      storage: storageOverTextStore(persistence),
      durable: false,
    });
    // A session an earlier process bound to an agent this catalog no longer has.
    await createSessionStore(persistence).save(
      createAgentSession({
        id: 'session-orphan',
        agentName: 'retired',
        conversationHistory: createConversationHistory({ id: 'session-orphan' }),
      }),
    );
    const before = await bureau.contexts.get('session-orphan');

    const refusal = await rejectionOf(
      bureau.tasks.start('retired', 'hello', { contextId: 'session-orphan' }),
    );

    expect((refusal as BureauError).code).toBe('NOT_FOUND');
    expect(listHeldTasks(bureau)).toEqual([]);
    expect(await bureau.contexts.get('session-orphan')).toEqual(before);
  });
});

describe('a session’s agent', () => {
  it('is the one that created it, and a run that names another is refused', async () => {
    const bureau = await start({
      agents: {
        alpha: createAgent({ generate: scripted('alpha speaking') }),
        beta: createAgent({ generate: scripted('beta speaking') }),
        default: createAgent({ generate: scripted('bureau speaking'), toolbox: createToolbox([]) }),
      },
    });
    const first = await bureau.tasks.start('alpha', 'one');
    await finish(bureau, first.id);

    const other = await rejectionOf(
      bureau.tasks.start('beta', 'two', { contextId: first.contextId }),
    );

    expect((other as BureauError).code).toBe('BAD_REQUEST');
    expect(listHeldTasks(bureau).map((run) => run.id)).toEqual([first.id]);
  });

  it('is never promoted from the default agent to a named one', async () => {
    const bureau = await start({
      agents: {
        assistant: createAgent({ generate: scripted('assistant speaking') }),
        default: createAgent({ generate: scripted('bureau speaking'), toolbox: createToolbox([]) }),
      },
    });
    const first = await bureau.tasks.start('default', 'one');
    await finish(bureau, first.id);

    const promotion = await rejectionOf(
      bureau.tasks.start('assistant', 'two', { contextId: first.contextId }),
    );

    expect((promotion as BureauError).code).toBe('BAD_REQUEST');
    const stored = await bureau.contexts.get(first.contextId);
    expect(stored?.agentName).toBe('default');
  });

  it('runs every later task that names it', async () => {
    const bureau = await start({
      agents: {
        alpha: createAgent({ generate: scripted('alpha speaking') }),
        default: createAgent({ generate: scripted('bureau speaking'), toolbox: createToolbox([]) }),
      },
    });
    const first = await bureau.tasks.start('alpha', 'one');
    await finish(bureau, first.id);
    const second = await bureau.tasks.start('alpha', 'two', { contextId: first.contextId });
    await finish(bureau, second.id);
    const third = await bureau.tasks.start('alpha', 'three', { contextId: first.contextId });
    await finish(bureau, third.id);

    expect(await replies(bureau, first.contextId)).toEqual([
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
      bureau.tasks.start('alpha', 'a', { contextId: 'shared-session' }),
      bureau.tasks.start('beta', 'b', { contextId: 'shared-session' }),
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
    expect(listHeldTasks(bureau)).toHaveLength(1);
    const stored = await bureau.contexts.get('shared-session');
    expect(stored?.agentName).toBe(winnerName);
    expect(calls[winnerName]).toBe(1);
    expect(calls[loserName]).toBe(0);
    expect(second).toBeDefined();
  });
});

describe('an agent named bureau', () => {
  it('is refused at construction, because the name is the Bureau-wide default agent', async () => {
    const attempt = createBureau<AgentDefinitions>({
      agents: {
        bureau: createAgent({ generate: scripted('catalog bureau') }),
        default: createAgent({
          generate: scripted('house default'),
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: { type: 'memory' },
      durable: false,
    });

    const refusal = await rejectionOf(attempt);

    expect(refusal).toBeInstanceOf(BureauError);
    expect((refusal as BureauError).code).toBe('BAD_REQUEST');
    expect((refusal as BureauError).message).toContain('"bureau"');
    expect((refusal as BureauError).message).toContain('reserved');
  });

  it('leaves other names, including ones that contain it, alone', async () => {
    const bureau = await start({
      agents: {
        'bureau-2': createAgent({ generate: scripted('second') }),
        Bureau: createAgent({ generate: scripted('capitalized') }),
        default: createAgent({ generate: scripted('house default'), toolbox: createToolbox([]) }),
      },
    });

    const run = await bureau.tasks.start('bureau-2', 'hi');
    await finish(bureau, run.id);

    expect(await replies(bureau, run.contextId)).toEqual(['second']);
  });
});

describe('run settings', () => {
  const tick = createTool({
    name: 'tick',
    description: 'tick',
    input: z.object({}),
    execute: async () => 'tick',
  });

  it('take the agent’s value: a task carries no prompt or token cap of its own', async () => {
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
    });

    const fromAgent = await bureau.tasks.start('alpha', 'a');
    const fromNeither = await bureau.tasks.start('plain', 'c');
    await finish(bureau, fromAgent.id);
    await finish(bureau, fromNeither.id);

    expect(seen).toEqual([
      { tools: [], systemPrompt: 'AGENT PROMPT', maximumTokens: 111 },
      { tools: [], systemPrompt: undefined, maximumTokens: undefined },
    ]);
  });

  it('cap the steps by the agent, then operative’s default', async () => {
    const stepsOf = async (agentSteps: number | undefined): Promise<number> => {
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
      });
      const run = await bureau.tasks.start('alpha', 'go');
      await finish(bureau, run.id);
      return seen.length;
    };

    expect(await stepsOf(undefined)).toBe(DEFAULT_MAXIMUM_STEPS);
    expect(await stepsOf(3)).toBe(3);
  });

  it('stop the run on the agent’s conditions', async () => {
    const seen: Observation[] = [];
    const bureau = await start({
      agents: {
        alpha: createAgent({
          generate: forever(seen),
          toolbox: createToolbox([tick]),
          stopWhen: stopWhen.toolCalled('tick'),
        }),
      },
    });

    const run = await bureau.tasks.start('alpha', 'go');
    await finish(bureau, run.id);

    expect(seen).toHaveLength(1);
  });
});

describe('a Bureau with only catalog agents', () => {
  it('accepts a named run and refuses the implicit `bureau` agent as an unknown one', async () => {
    const bureau = await start({
      agents: { alpha: createAgent({ generate: scripted('alpha speaking') }) },
    });

    const named = await bureau.tasks.start('alpha', 'hello');
    await finish(bureau, named.id);
    const unnamed = await rejectionOf(bureau.tasks.start('bureau', 'hello'));

    expect(await replies(bureau, named.contextId)).toEqual(['alpha speaking']);
    expect((unnamed as BureauError).code).toBe('NOT_FOUND');
  });
});
