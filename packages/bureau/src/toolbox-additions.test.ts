/**
 * COR-1700 — adding tools to a toolbox must keep everything the toolbox carries. Before this,
 * Bureau added `requestHumanInput` and `scheduleWakeup` with armorer's `combineToolboxes`, which
 * rebuilds from tool configurations and so dropped what the base carried on itself (the same class
 * as COR-321, which dropped approval settings one property at a time). `withAddedTools` extends
 * the base instead, so the added tools share its approval policy, execution mode, operation keys,
 * and provider conversions, and re-applies the layers (`withToolboxLayer`) around it. Each test
 * holds one behavior to what it was without the addition. The class guard carries every behavior
 * at once.
 */
import { type ToolPolicy, withActiveSkillToolPolicy } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import {
  type AnyToolbox,
  createTool,
  createToolbox,
  createToolResultCache,
  type ToolRequestContext,
  withToolboxIdempotency,
} from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { ToolClashError, withAddedTools, withToolboxLayer } from './toolbox-additions';

const REQUEST_CONTEXT: ToolRequestContext = {
  authority: {
    principalId: 'alice',
    tenantId: 'bureau',
    ownerId: 'alice',
    capabilities: ['tools:execute'],
    authorizationRevision: 'bureau:1',
  },
};

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

function additionsToolbox(): AnyToolbox {
  return createToolbox([
    createTool({
      name: 'added',
      description: 'a tool Bureau adds',
      input: z.object({}),
      execute: async () => 'added',
    }),
  ]);
}

function chargeTool(effects: string[]) {
  return createTool({
    name: 'charge',
    description: 'charge an order',
    input: z.object({ orderId: z.string() }),
    idempotencyKey: (input: unknown) => (input as { orderId: string }).orderId,
    execute: async (input: { orderId: string }) => {
      effects.push(input.orderId);
      return `charged:${input.orderId}`;
    },
  });
}

function idempotent(effects: string[]): AnyToolbox {
  return withToolboxIdempotency(createToolbox([chargeTool(effects)]), {
    cache: createToolResultCache({ store: textValueStore(new MemoryStorage()) }),
    tenantId: 'bureau',
  });
}

/** The active-skill gate, as Bureau layers it, so adding a tool re-applies it. */
const gate = (inner: AnyToolbox, policy: () => ToolPolicy | undefined): AnyToolbox =>
  withToolboxLayer(inner, (rebuilt) => withActiveSkillToolPolicy(rebuilt, policy));

/** A default request context, as Bureau layers it, so adding a tool re-applies it. */
const bindRequestContext = (inner: AnyToolbox): AnyToolbox =>
  withToolboxLayer(
    inner,
    (rebuilt) =>
      new Proxy(rebuilt, {
        get(target, property, receiver) {
          if (property !== 'execute') return Reflect.get(target, property, receiver) as unknown;
          return (call: never, options?: object) =>
            target.execute(call, { requestContext: REQUEST_CONTEXT, ...options });
        },
      }),
  );

const charge = (id: string) => ({ id, name: 'charge', arguments: { orderId: 'order-1' } });

describe('withAddedTools keeps the base toolbox in force', () => {
  it('runs an idempotent tool once when its call is retried with a tool added', async () => {
    const effects: string[] = [];
    const toolbox = withAddedTools(idempotent(effects), additionsToolbox());

    await toolbox.execute(charge('first'), { requestContext: REQUEST_CONTEXT });
    await toolbox.execute(charge('retry'), { requestContext: REQUEST_CONTEXT });

    expect(effects).toEqual(['order-1']);
  });

  it('keeps the idempotency of a clone made with extend()', async () => {
    const effects: string[] = [];
    const toolbox = withAddedTools(idempotent(effects), additionsToolbox()).extend();

    await toolbox.execute(charge('first'), { requestContext: REQUEST_CONTEXT });
    await toolbox.execute(charge('retry'), { requestContext: REQUEST_CONTEXT });

    expect(effects).toEqual(['order-1']);
    expect(toolbox.tools().map((tool) => tool.name)).toEqual(['charge', 'added']);
  });

  it('leaves a tool the active skill hid uncallable, and narrows the added tools by the same policy', async () => {
    let policy: ToolPolicy | undefined = { allowList: ['visible'] };
    const effects: string[] = [];
    const base = gate(
      createToolbox([
        chargeTool(effects),
        createTool({
          name: 'visible',
          description: 'visible',
          input: z.object({}),
          execute: async () => 'visible',
        }),
      ]),
      () => policy,
    );
    const toolbox = withAddedTools(base, additionsToolbox());

    expect(toolbox.tools().map((tool) => tool.name)).toEqual(['visible']);
    const refused = await toolbox.execute(charge('hidden'));
    expect(refused.outcome).toBe('error');
    expect(effects).toEqual([]);
    const addedRefused = await toolbox.execute({ id: 'added-1', name: 'added', arguments: {} });
    expect(addedRefused.outcome).toBe('error');

    // The policy is live: once the skill allows the added tool, it is offered and runs.
    policy = { allowList: ['visible', 'added'] };
    expect(toolbox.tools().map((tool) => tool.name)).toEqual(['visible', 'added']);
    const ran = await toolbox.execute({ id: 'added-2', name: 'added', arguments: {} });
    expect(ran.outcome).toBe('success');
  });

  it('offers none of the added tools when the policy allows nothing', () => {
    const base = gate(createToolbox([]), () => ({ allowList: [] }));
    expect(withAddedTools(base, additionsToolbox()).tools()).toEqual([]);
  });

  it('keeps its layers through a second addition, so that one is narrowed too', () => {
    const base = gate(createToolbox([]), () => ({ allowList: [] }));
    const once = withAddedTools(base, additionsToolbox());
    const second = createToolbox([
      createTool({
        name: 'second',
        description: 'a second tool Bureau adds',
        input: z.object({}),
        execute: async () => 'second',
      }),
    ]);
    expect(withAddedTools(once, second).tools()).toEqual([]);
  });

  it('leaves the base’s own request-context binding in charge of its tools', async () => {
    const seen: Array<string | undefined> = [];
    const probe = createTool({
      name: 'probe',
      description: 'reports the principal it ran as',
      input: z.object({}),
      execute: async (_input, context) => {
        const principal = (context as { requestContext?: ToolRequestContext }).requestContext
          ?.authority.principalId;
        seen.push(principal);
        return principal ?? 'none';
      },
    });
    const inner = createToolbox([probe]);
    const bound = bindRequestContext(inner);

    await withAddedTools(bound, additionsToolbox()).execute({
      id: 'probe-1',
      name: 'probe',
      arguments: {},
    });

    expect(seen).toEqual(['alice']);
  });

  it('answers for the added tools, in the order the calls came in', async () => {
    const effects: string[] = [];
    const toolbox = withAddedTools(createToolbox([chargeTool(effects)]), additionsToolbox());
    const results = await toolbox.execute([
      { id: 'a', name: 'added', arguments: {} },
      charge('b'),
      { id: 'c', name: 'added', arguments: {} },
    ]);
    expect(results.map((result) => result.toolName)).toEqual(['added', 'charge', 'added']);
    expect(toolbox.getTool('added')).toBeDefined();
    expect(toolbox.hasAllTools(['charge', 'added'])).toBe(true);
    expect(toolbox.getMissingTools(['added', 'nope'])).toEqual(['nope']);
  });

  it('throws ToolClashError naming both ids when an addition shares a tool’s name (COR-1875)', () => {
    const base = createToolbox([
      createTool({
        name: 'added',
        description: 'the host’s own',
        namespace: 'host',
        input: z.object({}),
        execute: async () => 'host',
      }),
    ]);
    const clash = thrownBy(() => withAddedTools(base, additionsToolbox()));
    expect(clash).toBeInstanceOf(ToolClashError);
    const error = clash as ToolClashError;
    expect(error.addedId).toBe('default:added');
    expect(error.existingIds).toEqual(['host:added']);
    expect(error.message).toContain('default:added');
    expect(error.message).toContain('host:added');
    // Nothing was added: the base is as it was.
    expect(base.tools().map((tool) => tool.id)).toEqual(['host:added']);
  });

  it('throws before adding any tool when only some of the additions clash (COR-1875)', () => {
    const base = createToolbox([
      createTool({
        name: 'added',
        description: 'the host’s own',
        input: z.object({}),
        execute: async () => 'host',
      }),
    ]);
    const additions = createToolbox([
      createTool({
        name: 'fresh',
        description: 'fresh',
        input: z.object({}),
        execute: async () => 'fresh',
      }),
      ...additionsToolbox().tools(),
    ]);
    expect(() => withAddedTools(base, additions)).toThrow(ToolClashError);
    expect(base.tools().map((tool) => tool.name)).toEqual(['added']);
  });

  it('throws through a layer too, so a gated base refuses a clash (COR-1875)', () => {
    const base = gate(createToolbox([]), () => ({ allowList: [] }));
    const once = withAddedTools(base, additionsToolbox());
    expect(() => withAddedTools(once, additionsToolbox())).toThrow(ToolClashError);
  });
});

const APPROVAL_CONTEXT: ToolRequestContext = {
  ...REQUEST_CONTEXT,
  audience: 'operator',
  agentId: 'default',
  runId: 'approval-run',
};

/** A versioned tool, as approval requires, that records each run. */
function versionedTool(name: string, ran: string[]) {
  return createTool({
    name,
    version: '1.0.0',
    description: name,
    input: z.object({}),
    execute: async () => {
      ran.push(name);
      return name;
    },
  });
}

describe('an added tool is held to the base toolbox’s approval policy', () => {
  const withApproval = (mode: 'always' | 'deny', ran: string[]) =>
    withAddedTools(
      createToolbox([versionedTool('host', ran)], {
        approvalSecret: 'additions-secret',
        approvalPolicy: { mode },
      }),
      createToolbox([versionedTool('added', ran)]),
    );
  const call = { id: 'a', name: 'added', arguments: {} };

  it('refuses it under mode: deny, as it refuses the host’s own tool', async () => {
    const ran: string[] = [];
    const toolbox = withApproval('deny', ran);
    const host = await toolbox.execute(
      { ...call, name: 'host' },
      { requestContext: APPROVAL_CONTEXT },
    );
    const added = await toolbox.execute(call, { requestContext: APPROVAL_CONTEXT });
    expect(host.outcome).toBe(added.outcome);
    expect(added.outcome).not.toBe('success');
    expect(ran).toEqual([]);
  });

  it('asks for approval under mode: always, and does not run it', async () => {
    const ran: string[] = [];
    const added = await withApproval('always', ran).execute(call, {
      requestContext: APPROVAL_CONTEXT,
    });
    expect(added).toMatchObject({ outcome: 'action_required' });
    expect(ran).toEqual([]);
  });

  it('runs it on a reusable grant once, then asks again', async () => {
    const ran: string[] = [];
    const toolbox = withApproval('always', ran);
    await toolbox.issueGrant({
      principalId: 'alice',
      tenantId: 'bureau',
      ownerId: 'alice',
      agentId: 'default',
      toolName: 'added',
      scope: 'principal',
      expiresAt: Number.MAX_SAFE_INTEGER,
      maxUses: 1,
      delegationBehavior: 'does-not-propagate',
    });
    const first = await toolbox.execute(call, { requestContext: APPROVAL_CONTEXT });
    const second = await toolbox.execute(
      { ...call, id: 'b' },
      { requestContext: APPROVAL_CONTEXT },
    );
    expect(first.outcome).toBe('success');
    expect(second).toMatchObject({ outcome: 'action_required' });
    expect(ran).toEqual(['added']);
  });
});

describe('a batch keeps its execution mode and its order across base and added tools', () => {
  /** Tools that log when they start and end, yielding in between so overlap would show. */
  function loggingToolbox(log: string[]) {
    const logging = (name: string) =>
      createTool({
        name,
        description: name,
        input: z.object({}),
        execute: async () => {
          log.push(`start:${name}`);
          for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
          log.push(`end:${name}`);
          return name;
        },
      });
    return withAddedTools(
      createToolbox([logging('first'), logging('third')]),
      createToolbox([logging('second')]),
    );
  }
  const calls = ['first', 'second', 'third'].map((name) => ({
    id: name,
    name,
    arguments: {},
  }));

  it('runs a sequential batch one call at a time, in the order the calls came in', async () => {
    const log: string[] = [];
    const results = await loggingToolbox(log).execute(calls, { mode: 'sequential' });
    expect(log).toEqual([
      'start:first',
      'end:first',
      'start:second',
      'end:second',
      'start:third',
      'end:third',
    ]);
    expect(results.map((result) => result.toolName)).toEqual(['first', 'second', 'third']);
  });

  it('returns a parallel batch’s results at the calls’ positions', async () => {
    const results = await loggingToolbox([]).execute(calls, { mode: 'parallel' });
    expect(results.map((result) => result.toolName)).toEqual(['first', 'second', 'third']);
  });

  it('gives each call the key of its position in the whole batch', async () => {
    const keys: string[] = [];
    const keyed = (name: string) =>
      createTool({
        name,
        description: name,
        input: z.object({}),
        execute: async (_input, context) => {
          keys.push(`${name}=${(context as { durableOperationKey?: string }).durableOperationKey}`);
          return name;
        },
      });
    const toolbox = withAddedTools(createToolbox([keyed('host')]), createToolbox([keyed('added')]));
    await toolbox.execute(
      [
        { id: '0', name: 'added', arguments: {} },
        { id: '1', name: 'host', arguments: {} },
        { id: '2', name: 'added', arguments: {} },
      ],
      { durableOperationKey: (_call, index) => `key-${index}` },
    );
    expect(keys.toSorted()).toEqual(['added=key-0', 'added=key-2', 'host=key-1']);
  });
});

describe('class guard: every toolbox-level behavior survives an addition', () => {
  /** One toolbox-level behavior, the base that carries it, and what must still hold. */
  type Behavior = {
    readonly name: string;
    readonly base: () => AnyToolbox;
    readonly holds: (toolbox: AnyToolbox) => Promise<void>;
  };

  const allowOnly = (names: readonly string[]) => (): ToolPolicy => ({ allowList: [...names] });
  const behaviors: readonly Behavior[] = [
    {
      name: 'idempotency',
      base: () => idempotent([]),
      holds: async (toolbox) => {
        const effects: string[] = [];
        const counted = withToolboxIdempotency(createToolbox([chargeTool(effects)]), {
          cache: createToolResultCache({ store: textValueStore(new MemoryStorage()) }),
          tenantId: 'bureau',
        });
        const wrapped = withAddedTools(counted, additionsToolbox());
        await wrapped.execute(charge('1'), { requestContext: REQUEST_CONTEXT });
        await wrapped.execute(charge('2'), { requestContext: REQUEST_CONTEXT });
        expect(effects).toEqual(['order-1']);
        expect(toolbox.tools().map((tool) => tool.name)).toContain('added');
      },
    },
    {
      name: 'skill gate',
      base: () => {
        return gate(createToolbox([chargeTool([])]), allowOnly(['charge']));
      },
      holds: async (toolbox) => {
        expect(toolbox.tools().map((tool) => tool.name)).toEqual(['charge']);
        const refused = await toolbox.execute({ id: 'g', name: 'added', arguments: {} });
        expect(refused.outcome).toBe('error');
      },
    },
    {
      name: 'request context',
      base: () => bindRequestContext(idempotent([])),
      holds: async (toolbox) => {
        // No `requestContext` is passed: the idempotency layer refuses a call without authority,
        // so a success shows the base's own binding supplied it.
        const result = await toolbox.execute(charge('bound'));
        expect(result.outcome).toBe('success');
      },
    },
    {
      name: 'approval policy',
      base: () =>
        createToolbox(
          [
            createTool({
              name: 'pay',
              version: '1.0.0',
              description: 'pay',
              input: z.object({ cents: z.number() }),
              execute: async ({ cents }: { cents: number }) => cents,
            }),
          ],
          { approvalSecret: 'class-guard-secret', approvalPolicy: { mode: 'always' } },
        ),
      holds: async (toolbox) => {
        const paused = await toolbox.execute(
          { id: 'p', name: 'pay', arguments: { cents: 1 } },
          {
            requestContext: {
              ...REQUEST_CONTEXT,
              audience: 'operator',
              agentId: 'guard',
              runId: 'guard-run',
            },
          },
        );
        expect(paused).toMatchObject({ outcome: 'action_required' });
      },
    },
  ];

  it.each(behaviors.map((behavior) => [behavior.name, behavior] as const))(
    'keeps %s',
    async (_name, behavior) => {
      await behavior.holds(withAddedTools(behavior.base(), additionsToolbox()));
    },
  );

  it('keeps all of them when they are stacked on one base', async () => {
    const effects: string[] = [];
    const policy = allowOnly(['charge']);
    const stacked = bindRequestContext(gate(idempotent(effects), policy));
    const toolbox = withAddedTools(stacked, additionsToolbox());

    const first = await toolbox.execute(charge('1'));
    const second = await toolbox.execute(charge('2'));
    const hidden = await toolbox.execute({ id: 'g', name: 'added', arguments: {} });
    expect([first.outcome, second.outcome]).toEqual(['success', 'success']);
    expect(effects).toEqual(['order-1']);
    expect(toolbox.tools().map((tool) => tool.name)).toEqual(['charge']);
    expect(hidden.outcome).toBe('error');
  });
});
