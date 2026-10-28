/**
 * `bureau.run(name, input, options?)` — AB-15/AB-22 typed catalog dispatch.
 *
 * Covers the AB-22 acceptance-criteria list this issue owns directly (as
 * opposed to AB-23's repository-native integration suite): unknown names,
 * lazy failure, JavaScript callers, direct execution, durable execution, and
 * synchronous-throw validation. Catalog ordering/querying and factory
 * initialization failure are covered by `agent-catalog.test.ts` and
 * `create-bureau.test.ts` respectively.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import {
  AgentContractError,
  createAgent,
  createLazyAgent,
  createModelCatalog,
  createSubagentTool,
  type DefinitionResolvingAgent,
  type GenerateContext,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  type RunnableAgent,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { BureauError, createBureau } from './create-bureau';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { listHeldTasks, runTask } from './test';
import type { StartTaskOptions } from './types';
import type { AgentDefinitions } from './agent-catalog';
import { awakeTurns } from '@lostgradient/testing/wait-until';

const runtime = createDefaultRuntimeServices();

/**
 * One timer turn on the runtime timers. A negative assertion drains with this
 * rather than a microtask or MessageChannel turn, because those return in a
 * fraction of a millisecond and would end the observation window before
 * anything scheduled on a timer could fire.
 */
function waitOneTimerTurn(): Promise<void> {
  return new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, 0));
}

function mockGenerate(content = 'ok') {
  return async () => ({ content, toolCalls: [] });
}

describe('bureau.tasks.start of a catalog agent', () => {
  it('rejects with BureauError NOT_FOUND for an unknown agent name', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate() }) },
    });
    try {
      // `'missing'` is not a literal key of this bureau's `agents` — cast to
      // `never` to exercise the runtime guard for a name that arrived from
      // outside the static type (an HTTP path parameter, a webhook payload).
      const error = await rejectionOf(bureau.tasks.start('missing' as never, 'hi'));
      expect(error).toBeInstanceOf(BureauError);
      expect((error as BureauError).code).toBe('NOT_FOUND');
    } finally {
      await bureau.dispose();
    }
  });

  it('rejects with BureauError BAD_REQUEST for input that is not a task input', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate() }) },
    });
    try {
      for (const malformed of [42, null]) {
        // @ts-expect-error — deliberately malformed input, exercising the runtime guard
        const error = await rejectionOf(bureau.tasks.start('echo', malformed));
        expect(error).toBeInstanceOf(BureauError);
        expect((error as BureauError).code).toBe('BAD_REQUEST');
      }
    } finally {
      await bureau.dispose();
    }
  });

  describe('a part-array input (COR-716)', () => {
    const parts = [
      { type: 'text', text: 'look at this' },
      {
        type: 'image',
        mimeType: 'image/png',
        source: { kind: 'inline', data: 'QUJD', encoding: 'base64' },
      },
      { type: 'text', text: 'and say what it is' },
    ] as const;

    function recordingAgent(seen: GenerateContext[]) {
      const descriptors = createModelCatalog().descriptors.filter(
        (descriptor) => descriptor.provider === 'anthropic',
      );
      return createAgent({
        generate: withBackendDescriptors(async (context: GenerateContext) => {
          seen.push(context);
          return { content: 'ok', toolCalls: [] };
        }, descriptors),
      });
    }

    it('delivers the parts to the agent as one user message, in order', async () => {
      const seen: GenerateContext[] = [];
      const bureau = await createBureau({ agents: { echo: recordingAgent(seen) } });
      try {
        await runTask(bureau, 'echo', parts);
        const user = seen[0]?.conversation.getMessages().find((m) => m.role === 'user');
        expect(user?.content).toEqual(parts);
      } finally {
        await bureau.dispose();
      }
    });

    it.each([
      ['an empty list', []],
      ['a part that fails the content schema', [{ type: 'image' }]],
      ['a provider-generated part', [{ type: 'thinking', thinking: 'x', signature: 's' }]],
      ['text carrying citations', [{ type: 'text', text: 'x', citations: [] }]],
    ])('rejects with BureauError BAD_REQUEST for %s', async (_label, input) => {
      const bureau = await createBureau({ agents: { echo: recordingAgent([]) } });
      try {
        let thrown: unknown;
        try {
          await bureau.tasks.start('echo', input as never);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(BureauError);
        expect((thrown as BureauError).code).toBe('BAD_REQUEST');
      } finally {
        await bureau.dispose();
      }
    });
  });

  it('rejects with BureauError BAD_REQUEST when options is an array (typeof [] === "object" does not make it a valid options bag)', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate() }) },
    });
    try {
      // @ts-expect-error — deliberately an array, not a StartTaskOptions object
      const error = await rejectionOf(bureau.tasks.start('echo', 'hi', []));
      expect(error).toBeInstanceOf(BureauError);
      expect((error as BureauError).code).toBe('BAD_REQUEST');
    } finally {
      await bureau.dispose();
    }
  });

  it('rejects with BureauError BAD_REQUEST when options.signal is not an AbortSignal', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate() }) },
    });
    try {
      // @ts-expect-error — deliberately malformed options.signal
      const error = await rejectionOf(bureau.tasks.start('echo', 'hi', { signal: 'nope' }));
      expect(error).toBeInstanceOf(BureauError);
      expect((error as BureauError).code).toBe('BAD_REQUEST');
    } finally {
      await bureau.dispose();
    }
  });

  it('rejects with BureauError BAD_REQUEST when options.withTraceContext is not a function', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate() }) },
    });
    try {
      const error = await rejectionOf(
        // @ts-expect-error — deliberately malformed options.withTraceContext
        bureau.tasks.start('echo', 'hi', { withTraceContext: 'nope' }),
      );
      expect(error).toBeInstanceOf(BureauError);
      expect((error as BureauError).code).toBe('BAD_REQUEST');
    } finally {
      await bureau.dispose();
    }
  });

  it('rejects with BureauError CONFLICT once the bureau is disposed', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate() }) },
    });
    await bureau.dispose();
    const error = await rejectionOf(bureau.tasks.start('echo', 'hi'));
    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('CONFLICT');
  });

  it('resolves with a non-thenable handle (in-memory execution, no durable engine)', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate('hello from echo') }) },
    });
    try {
      const run = await bureau.tasks.start('echo', 'hi');
      // The handle is deliberately non-thenable — `await handle` must not resolve through a
      // `.then` on the handle itself.
      expect(typeof (run as unknown as { then?: unknown }).then).toBe('undefined');
      const result = await run.result();
      expect(result.content).toBe('hello from echo');
    } finally {
      await bureau.dispose();
    }
  });

  it('carries the literal output schema through an in-memory task', async () => {
    const outputSchema = z.object({ greeting: z.string() });
    const bureau = await createBureau({
      agents: {
        structured: createAgent({
          generate: mockGenerate('{"greeting":"hi"}'),
          output: outputSchema,
        }),
      },
    });
    try {
      const run = await bureau.tasks.start('structured', 'hi');
      const { output } = await run.result();
      expect(output?.greeting).toBe('hi');
    } finally {
      await bureau.dispose();
    }
  });

  it('drives the run through the durable engine when one is composed, checkpointed and discoverable via listDurableRuns', async () => {
    // Title deliberately does NOT claim "survives a crash simulation" — this
    // test only proves the run went through the durable engine and is
    // checkpointed/discoverable mid-flight. A process-restart reattach test
    // (AB-240) lives in `create-bureau.test.ts` alongside the other
    // cross-process recovery tests — see "reattaches a catalog-dispatched
    // bureau.run() across a process restart, rebuilding deps from the
    // catalog agent's own OPERATIVE_RESOLVE_RUN_OPTIONS".
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate('durable hello') }) },
      // No bureau-level generate/provider needed — `run()` dispatches through
      // the catalog agent's own generate; only the durable engine + storage
      // matter here.
      storage: { type: 'memory' },
      durable: true,
    });
    try {
      const before = await bureau.tasks.workflows();
      const run = await bureau.tasks.start('echo', 'hi');
      const result = await run.result();
      expect(result.content).toBe('durable hello');

      const after = await bureau.tasks.workflows();
      expect(after?.total ?? 0).toBeGreaterThan(before?.total ?? 0);
      // The workflow id the start minted is discoverable through the
      // engine's own durable-run listing — proof this went through the
      // durable engine, not the agent's in-memory loop.
      expect(after?.items.some((item) => item.id === run.id)).toBe(true);
    } finally {
      await bureau.dispose();
    }
  });

  it('forwards abort() to the dispatched durable ActiveRun (AB-22 review fix: the outer wrapper going terminal must not leave the already-started durable workflow running unobserved)', async () => {
    let releaseGenerate: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      releaseGenerate = resolve;
    });
    const bureau = await createBureau({
      agents: {
        echo: createAgent({
          generate: async () => {
            await pending;
            return { content: 'too late', toolCalls: [] };
          },
        }),
      },
      storage: { type: 'memory' },
      durable: true,
    });
    try {
      const run = await bureau.tasks.start('echo', 'hi');
      // Abort immediately. The durable workflow must not keep running, and eventually call the
      // generate function with real side effects, after the handle reports itself terminal.
      run.abort('caller cancelled immediately');
      releaseGenerate?.();
      const result = await run.result();
      expect(result.finishReason).toBe('aborted');
    } finally {
      await bureau.dispose();
    }
  });

  it('runs the task’s generate calls under the start’s trace context', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate('traced') }) },
    });
    try {
      const parent = { span: 'parent-span' };
      const parents: unknown[] = [];
      const run = await bureau.tasks.start('echo', 'hi', {
        traceContext: parent,
        withTraceContext: (traceParent, fn) => {
          parents.push(traceParent);
          return fn();
        },
      });
      const result = await run.result();
      expect(result.content).toBe('traced');
      expect(parents.length).toBeGreaterThan(0);
      expect(parents.every((traceParent) => traceParent === parent)).toBe(true);
    } finally {
      await bureau.dispose();
    }
  });

  it('removes its abort listener from the start signal once the task settles', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate('done') }) },
    });
    try {
      const controller = new AbortController();
      const listening = new Set<unknown>();
      const signal = controller.signal;
      const add = signal.addEventListener.bind(signal);
      const remove = signal.removeEventListener.bind(signal);
      signal.addEventListener = (type: string, listener: unknown, options?: unknown) => {
        if (type === 'abort') listening.add(listener);
        add(type, listener as EventListener, options as AddEventListenerOptions);
      };
      signal.removeEventListener = (type: string, listener: unknown, options?: unknown) => {
        if (type === 'abort') listening.delete(listener);
        remove(type, listener as EventListener, options as EventListenerOptions);
      };

      const run = await bureau.tasks.start('echo', 'hi', { signal });
      expect(listening.size).toBe(1);
      await run.result();

      expect(listening.size).toBe(0);
    } finally {
      await bureau.dispose();
    }
  });

  it('ends the task, generating nothing, when its start signal is already aborted', async () => {
    let generateCalls = 0;
    const bureau = await createBureau({
      agents: {
        echo: createAgent({
          name: 'echo',
          generate: async () => {
            generateCalls += 1;
            return { content: 'ok', toolCalls: [] };
          },
        }),
      },
      storage: { type: 'memory' },
    });
    try {
      const controller = new AbortController();
      controller.abort('cancelled before the start');
      const task = await bureau.tasks.start('echo', 'hi', { signal: controller.signal });
      const result = await task.result();

      // The run exists once the start resolves, and the abort ends it before its first step.
      expect([result.finishReason, task.snapshot().status, generateCalls]).toEqual([
        'aborted',
        'terminal',
        0,
      ]);
    } finally {
      await bureau.dispose();
    }
  });

  it('refuses an agent that does not support definition resolution with UNSUPPORTED_CAPABILITY, starting nothing', async () => {
    const nonResolvingAgent: RunnableAgent = {
      name: 'plain',
      hasOutput: false,
      run: (input, context) =>
        createAgent({ generate: mockGenerate('plain hello') }).run(input, context),
    };
    const bureau = await createBureau({
      agents: { plain: nonResolvingAgent },
      storage: { type: 'memory' },
      durable: true,
    });
    try {
      const before = await bureau.tasks.workflows();
      const error = await rejectionOf(bureau.tasks.start('plain', 'hi'));
      expect(error).toBeInstanceOf(BureauError);
      expect((error as BureauError).code).toBe('UNSUPPORTED_CAPABILITY');
      // The refusal lands before anything is persisted: no workflow, no task.
      const after = await bureau.tasks.workflows();
      expect(after?.total ?? 0).toBe(before?.total ?? 0);
      expect(listHeldTasks(bureau)).toEqual([]);
    } finally {
      await bureau.dispose();
    }
  });

  it('rejects with the failure of a lazy agent that cannot load, starting nothing', async () => {
    const failingLazyAgent = createLazyAgent(() => Promise.reject(new Error('load failed')));
    const bureau = await createBureau({ agents: { lazy: failingLazyAgent } });
    try {
      const error = await rejectionOf(bureau.tasks.start('lazy', 'hi'));
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Failed to load lazy agent');
      expect(((error as Error).cause as Error).message).toBe('load failed');
      expect(listHeldTasks(bureau)).toEqual([]);
    } finally {
      await bureau.dispose();
    }
  });

  it('rejects with an AgentContractError for a lazy agent that resolves to something without run()', async () => {
    const brokenLazyAgent = createLazyAgent(
      // @ts-expect-error — deliberately not a valid RunnableAgent, to exercise the runtime contract guard
      () => Promise.resolve({ name: 'broken' }),
    );
    const bureau = await createBureau({ agents: { broken: brokenLazyAgent } });
    try {
      expect(await rejectionOf(bureau.tasks.start('broken', 'hi'))).toBeInstanceOf(
        AgentContractError,
      );
    } finally {
      await bureau.dispose();
    }
  });

  it('dispatches by a runtime string name — a JavaScript caller with no static AgentDefinitions type', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate('js caller hello') }) },
    });
    try {
      const dynamicName: string = ['echo'][0] ?? '';
      // `run` is typed to accept only `AgentNames<D>`, but at the JavaScript
      // boundary (no static types) any string is accepted and dispatched
      // through the same runtime `agentCatalog.find` lookup `find` uses.
      const run = await bureau.tasks.start(dynamicName as 'echo', 'hi');
      const result = await run.result();
      expect(result.content).toBe('js caller hello');
    } finally {
      await bureau.dispose();
    }
  });

  describe('options.principal (AB-241)', () => {
    it('rejects with BureauError BAD_REQUEST when options.principal is not a string', async () => {
      const bureau = await createBureau({
        agents: { echo: createAgent({ generate: mockGenerate() }) },
      });
      try {
        // @ts-expect-error — deliberately malformed options.principal
        const error = await rejectionOf(bureau.tasks.start('echo', 'hi', { principal: 42 }));
        expect(error).toBeInstanceOf(BureauError);
        expect((error as BureauError).code).toBe('BAD_REQUEST');
      } finally {
        await bureau.dispose();
      }
    });

    it('rejects a principal getter whose FIRST read is malformed, never giving it a second chance to look valid (AB-241 review finding)', async () => {
      const bureau = await createBureau({
        agents: { echo: createAgent({ generate: mockGenerate() }) },
      });
      try {
        let reads = 0;
        const options = {} as StartTaskOptions;
        Object.defineProperty(options, 'principal', {
          // First read (the only one a correct implementation performs) is
          // malformed; a second, independent read would return a valid
          // string. A caller reading `options.principal` twice — once to
          // validate, once to use — could see this getter validate the
          // FIRST read then use the second, silently accepting an option
          // this call is supposed to reject synchronously.
          get: () => (reads++ === 0 ? 42 : 'alice'),
        });
        const error = await rejectionOf(bureau.tasks.start('echo', 'hi', options));
        expect(error).toBeInstanceOf(BureauError);
        expect(reads).toBe(1);
      } finally {
        await bureau.dispose();
      }
    });

    it('validates and attributes the SAME captured principal value even when options.principal is a getter whose result changes on a later read (AB-241 review finding)', async () => {
      const bureau = await createBureau({
        agents: { echo: createAgent({ generate: mockGenerate('durable hello') }) },
        storage: { type: 'memory' },
        durable: true,
      });
      try {
        let reads = 0;
        const options = {} as StartTaskOptions;
        Object.defineProperty(options, 'principal', {
          // First read (the only one this call should perform) is a valid
          // string; a later, independent read would return a different,
          // malformed value. A caller re-reading `options.principal` after
          // validation — at `persistCatalogRunRecoveryRecord` or the
          // `createActiveRun` owner argument, both after an `await` — could
          // otherwise attribute this run to a DIFFERENT, unvalidated value
          // than the one that was checked.
          get: () => (reads++ === 0 ? 'alice' : 42),
        });
        const run = await bureau.tasks.start('echo', 'hi', options);
        await run.result();
        expect(run.snapshot().owner).toBe('alice');
        expect(reads).toBe(1);
      } finally {
        await bureau.dispose();
      }
    });

    it("records options.principal as the durable ActiveRun's LivenessSnapshot.owner, as the session run records the principal that started it", async () => {
      const bureau = await createBureau({
        agents: { echo: createAgent({ generate: mockGenerate('durable hello') }) },
        storage: { type: 'memory' },
        durable: true,
      });
      try {
        const run = await bureau.tasks.start('echo', 'hi', { principal: 'alice' });
        await run.result();
        expect(run.snapshot().owner).toBe('alice');
      } finally {
        await bureau.dispose();
      }
    });

    it("records the anonymous owner as the durable ActiveRun's LivenessSnapshot.owner when options omits principal", async () => {
      const bureau = await createBureau({
        agents: { echo: createAgent({ generate: mockGenerate('durable hello') }) },
        storage: { type: 'memory' },
        durable: true,
      });
      try {
        const run = await bureau.tasks.start('echo', 'hi');
        await run.result();
        expect(run.snapshot().owner).toBe('anonymous:local');
      } finally {
        await bureau.dispose();
      }
    });
  });

  it('accepts an empty agents catalog', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {},
    });
    try {
      expect(bureau.agents.names()).toEqual([]);
      expect(bureau.agents.has('anything')).toBe(false);
    } finally {
      await bureau.dispose();
    }
  });

  it('snapshots agents before the first await — a caller mutating the same object after calling createBureau() does not leak into bureau.agents', async () => {
    // Review round 2 (Codex): createRuntimeComposition(options) used to be
    // awaited BEFORE the catalog was built from options.agents, leaving a
    // real mutation window. createBureau() is an async function: it runs
    // synchronously up to its first `await`, so if the snapshot happens
    // before that point (the fix), a caller's mutation on the very next
    // line — necessarily AFTER createBureau() has already returned control
    // — can never affect it, regardless of how many microtask hops
    // composition itself takes.
    const agents: Record<string, RunnableAgent<unknown, boolean>> = {
      echo: createAgent({ generate: mockGenerate() }),
    };
    const bureauPromise = createBureau({ agents });
    agents['mutated'] = createAgent({ generate: mockGenerate() });
    delete agents['echo'];

    const bureau = await bureauPromise;
    try {
      expect(bureau.agents.names()).toEqual(['echo']);
      expect(bureau.agents.has('mutated')).toBe(false);
    } finally {
      await bureau.dispose();
    }
  });
});

describe('Bureau invariants on catalog-agent dispatch (COR-1265, COR-1277)', () => {
  // A catalog agent resolves its own provider, toolbox, memory and skills
  // (AB-240), so Bureau's tier can only reach it where an options bag exists
  // outside the agent to merge into. COR-1277 made that true of every dispatch
  // whose agent exposes `OPERATIVE_RESOLVE_RUN_OPTIONS`, durable or not, so
  // `durable` is no longer part of the answer — only the resolver is.
  //
  // Observed behaviorally rather than by introspection: `AgentRun` exposes no
  // `describeHookPlan` (that is on `ActiveRun`), and behavior is the stronger
  // assertion anyway. `bureau:identity` appends its system message on step 0,
  // and a tripped guardrail halts the run, so a generate that sees the message
  // and a run that halts are both runs whose plan composed Bureau's tier.
  function captureSystemMessages(seen: string[]) {
    return async (request: { conversation?: { getMessages?: () => readonly unknown[] } }) => {
      const messages = request.conversation?.getMessages?.() ?? [];
      for (const message of messages as ReadonlyArray<{ role?: string; content?: unknown }>) {
        if (message.role === 'system' && typeof message.content === 'string') {
          seen.push(message.content);
        }
      }
      return { content: 'ok', toolCalls: [] };
    };
  }

  /** A detector that always trips, so the assertion is about composition and not about detection. */
  const alwaysTrip = {
    mode: 'tripwire' as const,
    input: {
      detectors: [
        {
          name: 'always-trip',
          detect: async () => ({ triggered: true, confidence: 1, category: 'test' }),
        },
      ],
    },
  };

  it('applies them to a durably dispatched catalog agent', async () => {
    const seen: string[] = [];
    const bureau = await createBureau({
      agents: {
        echo: createAgent({
          generate: captureSystemMessages(seen),
        }),
      },
      identity: { resolve: async () => 'You are the house agent.' },
      storage: { type: 'memory' },
      durable: true,
    });

    try {
      await runTask(bureau, 'echo', 'hi');
      expect(seen).toContain('You are the house agent.');
    } finally {
      await bureau.dispose();
    }
  });

  // COR-1277 criterion 13. The case the whole issue exists for: a bureau that
  // was simply not built durable, dispatching an ordinary `createAgent` result.
  it('applies them to a NON-durable dispatch of a resolver-capable agent', async () => {
    const seen: string[] = [];
    const bureau = await createBureau({
      agents: { echo: createAgent({ name: 'echo', generate: captureSystemMessages(seen) }) },
      identity: { resolve: async () => 'You are the house agent.' },
      storage: { type: 'memory' },
    });

    try {
      const result = await runTask(bureau, 'echo', 'hi');
      expect(seen).toContain('You are the house agent.');
      // Not vacuous, and not a run that merely failed early: it completed with
      // the agent's own answer.
      expect(result.content).toBe('ok');
    } finally {
      await bureau.dispose();
    }
  });

  it('applies the guardrail tier to a NON-durable dispatch, not just identity', async () => {
    let generateCalls = 0;
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        echo: createAgent({
          name: 'echo',
          generate: async () => {
            generateCalls += 1;
            return { content: 'ok', toolCalls: [] };
          },
          guardrails: alwaysTrip,
        }),
      },
      storage: { type: 'memory' },
    });

    try {
      const result = await runTask(bureau, 'echo', 'hi');
      // The agent's own guardrails, registered as `agent:guardrails-prepare-step`, run before generate and
      // hard-halt, so the provider is never reached.
      expect(result.finishReason).toBe('tripwire');
      expect(generateCalls).toBe(0);
    } finally {
      await bureau.dispose();
    }
  });

  it('leaves the agent’s own provider and toolbox in place on a NON-durable dispatch', async () => {
    // AB-240's rollback trigger. Bureau contributes a hook tier and nothing
    // else: the answer still comes from the agent's own generate, not from any
    // Bureau default — this bureau has none to fall back to.
    const bureau = await createBureau({
      agents: {
        echo: createAgent({
          name: 'echo',
          generate: async () => ({ content: 'from the agent', toolCalls: [] }),
        }),
      },
      identity: { resolve: async () => 'You are the house agent.' },
      storage: { type: 'memory' },
    });

    try {
      const result = await runTask(bureau, 'echo', 'hi');
      expect(result.content).toBe('from the agent');
    } finally {
      await bureau.dispose();
    }
  });

  // COR-1277 criterion 3. `createActiveRun` derives `LivenessSnapshot.owner`
  // from its third argument alone, never from `RunOptions.principal`.
  // `agent.run()` used to supply it internally; now this path builds the run
  // itself and has to pass it, or every principal-carrying non-durable catalog
  // run silently reports no owner.
  it('attributes a NON-durable catalog run to its principal', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ name: 'echo', generate: mockGenerate('ok') }) },
      identity: { resolve: async () => 'You are the house agent.' },
      storage: { type: 'memory' },
    });

    try {
      const run = await bureau.tasks.start('echo', 'hi', { principal: 'api-key:alice' });
      await run.result();
      expect(run.snapshot().owner).toBe('api-key:alice');
    } finally {
      await bureau.dispose();
    }
  });

  // COR-1277 criterion 7. A genuine resolver failure is refused as it is, before anything is persisted.
  it('rejects with a genuine resolver failure as it is', async () => {
    const base = createAgent({ name: 'broken', generate: mockGenerate() });
    const agent: RunnableAgent & DefinitionResolvingAgent = {
      name: base.name,
      hasOutput: base.hasOutput,
      run: base.run,
      [OPERATIVE_RESOLVE_RUN_OPTIONS]: () => {
        throw new Error('resolution exploded');
      },
    };
    const bureau = await createBureau({
      agents: { broken: agent },
      storage: { type: 'memory' },
    });

    try {
      const error = await rejectionOf(bureau.tasks.start('broken', 'hi'));
      expect((error as Error).message).toBe('resolution exploded');
      expect(listHeldTasks(bureau)).toEqual([]);
    } finally {
      await bureau.dispose();
    }
  });

  // COR-1277 criterion 5. The AB-260 stamp is parity with the durable branch,
  // and its effect is deliberately invisible for an ordinary `createAgent`
  // agent: `buildRunOptions` always populates `runtime`, so the spread leaves
  // the agent's value in place. Only a hand-written resolver that omits the
  // field can reach the stamp at all.
  //
  // What this pins is survivability, not the stamp's effect. Nothing on this
  // dispatch path's public surface reports which `RuntimeServices` instance a
  // run used, so a test asserting the stamp took hold cannot be written here
  // without reaching into internals — stated rather than faked with an
  // assertion that would pass either way.
  it('dispatches a resolver that omits runtime, which is the only shape the stamp reaches', async () => {
    const base = createAgent({ name: 'bare', generate: mockGenerate('bare ok') });
    const agent: RunnableAgent & DefinitionResolvingAgent = {
      name: base.name,
      hasOutput: base.hasOutput,
      run: base.run,
      [OPERATIVE_RESOLVE_RUN_OPTIONS]: async (input, context) => {
        const resolved = await base[OPERATIVE_RESOLVE_RUN_OPTIONS]!(input, context);
        const { runtime: _dropped, ...withoutRuntime } = resolved;
        return withoutRuntime;
      },
    };
    const bureau = await createBureau({
      agents: { bare: agent },
      identity: { resolve: async () => 'You are the house agent.' },
      storage: { type: 'memory' },
    });

    try {
      const result = await runTask(bureau, 'bare', 'hi');
      expect(result.content).toBe('bare ok');
    } finally {
      await bureau.dispose();
    }
  });
});

describe('every Bureau hook hand-off is a merge (COR-1265 criterion 3)', () => {
  // Three of the five sites build `RunOptions` for a handle no public surface
  // returns — `bureau.createRun()` resolves a `RunSummary`, and the scheduler
  // and mocked-reattach paths produce no caller-visible run at all — so
  // `describeHookPlan()` cannot reach them the way it reaches the scheduled and
  // recovered paths tested in `runtime-composition.test.ts`.
  //
  // This is the assertion that does reach all five: no site hands a run the
  // live registry. It is a source invariant rather than a behavior, and it is
  // stated as one rather than dressed up as coverage it is not.
  it('leaves no site handing a run the live runRuntime registry', async () => {
    const sources = ['./create-bureau.ts', './runtime-composition.ts'];
    for (const source of sources) {
      const text = await Bun.file(new URL(source, import.meta.url).pathname).text();
      // The raw hand-off, in any whitespace shape. A match means a run received
      // the registry Bureau keeps mutating instead of a snapshot of it.
      expect(text, source).not.toMatch(/hooks:\s*runRuntime\.hooks\b/u);
      expect(text, source).not.toMatch(/hooks:\s*registerTrailingOnStep\(/u);
    }
  });

  it('carries Bureau’s tier into an interactive bureau.tasks.start run', async () => {
    const seen: string[] = [];
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async (request) => {
            for (const message of request.conversation.getMessages()) {
              if (message.role === 'system' && typeof message.content === 'string') {
                seen.push(message.content);
              }
            }
            return { content: 'ok', toolCalls: [] };
          },
        }),
      },
      identity: { resolve: async () => 'BUREAU-TIER-REACHED' },
      storage: { type: 'memory' },
    });

    try {
      const run = await bureau.tasks.start('default', 'hi');
      for await (const _turn of awakeTurns()) {
        if (!(seen.length === 0)) break;
        await waitOneTimerTurn();
      }
      expect(bureau.tasks.detail(run.id)).toBeDefined();
      expect(seen).toContain('BUREAU-TIER-REACHED');
    } finally {
      await bureau.dispose();
    }
  });
});

describe('a child run is outside Bureau’s hook authority (COR-1269)', () => {
  it('does not carry the dispatching Bureau’s invariants into a child run', async () => {
    const supervisorSaw: string[] = [];
    const childSaw: string[] = [];
    function recordInto(seen: string[]) {
      return async (request: {
        conversation: { getMessages: () => ReadonlyArray<{ role?: string; content?: unknown }> };
      }) => {
        for (const message of request.conversation.getMessages()) {
          if (message.role === 'system' && typeof message.content === 'string') {
            seen.push(message.content);
          }
        }
        return { content: 'done', toolCalls: [] };
      };
    }

    const child = createAgent({ name: 'researcher', generate: recordInto(childSaw) });
    const delegate = createSubagentTool({
      name: 'delegate',
      description: 'Delegate',
      agent: child,
      agentName: 'researcher',
      input: z.object({ q: z.string() }),
    });

    let step = 0;
    const bureau = await createBureau({
      agents: {
        supervisor: createAgent({
          name: 'supervisor',
          toolbox: createToolbox([delegate]),
          generate: async (request) => {
            const settled = await recordInto(supervisorSaw)(request);
            return step++ === 0
              ? {
                  content: '',
                  toolCalls: [{ id: 'c1', name: 'delegate', arguments: { q: 'hi' } }],
                }
              : settled;
          },
        }),
      },
      identity: { resolve: async () => 'BUREAU-IDENTITY' },
      storage: { type: 'memory' },
      durable: true,
    });

    try {
      await runTask(bureau, 'supervisor', 'go');

      // The supervisor is Bureau-owned and carries the invariant. Its child does
      // not, and cannot: `dispatchChildRun` calls `agent.run()`, which builds
      // its `RunOptions` inside the agent, so there is no options bag for a
      // Bureau tier to be merged into — structurally the same gap as the two
      // catalog rows above, closed only by a caller-facing hook field that
      // COR-567 Decision 4 declines.
      //
      // Pinned rather than left implicit. COR-1269's criterion 1 originally
      // claimed a child of a Bureau-owned agent DOES receive that child's
      // Bureau invariants; it was amended to match reality once this was
      // verified by probe. If this ever starts failing, the gap closed: delete
      // the test and update the child section of
      // `documentation/hierarchical-hook-composition.md`.
      expect(supervisorSaw).toContain('BUREAU-IDENTITY');
      expect(childSaw).not.toContain('BUREAU-IDENTITY');
    } finally {
      await bureau.dispose();
    }
  });
});
