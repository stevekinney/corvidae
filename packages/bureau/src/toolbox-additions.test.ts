/**
 * COR-1700 — adding tools to a toolbox must not rebuild it. Before this, Bureau added
 * `requestHumanInput` and `scheduleWakeup` with armorer's `combineToolboxes`, which rebuilds from
 * tool configurations and so dropped everything the base toolbox carried on itself (the same
 * class as COR-321, which dropped approval settings one property at a time). Each test builds a
 * base toolbox with one toolbox-level behavior, adds a tool, and holds the behavior to what it
 * was without the addition. The last test is the class guard: it carries every behavior at once.
 */
import { type ToolPolicy, withActiveSkillToolPolicy } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
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

import { recordToolPolicy, toolPolicyOf, withAddedTools } from './toolbox-additions';

const REQUEST_CONTEXT: ToolRequestContext = {
  authority: {
    principalId: 'alice',
    tenantId: 'bureau',
    ownerId: 'alice',
    capabilities: ['tools:execute'],
    authorizationRevision: 'bureau:1',
  },
} as ToolRequestContext;

function additionsToolbox(): AnyToolbox {
  return createToolbox([
    createTool({
      name: 'added',
      description: 'a tool Bureau adds',
      input: z.object({}),
      execute: async () => 'added',
    }),
  ]) as unknown as AnyToolbox;
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
    const base = recordToolPolicy(
      withActiveSkillToolPolicy(
        createToolbox([
          chargeTool(effects),
          createTool({
            name: 'visible',
            description: 'visible',
            input: z.object({}),
            execute: async () => 'visible',
          }),
        ]) as unknown as AnyToolbox,
        () => policy,
      ),
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
    const base = recordToolPolicy(
      withActiveSkillToolPolicy(createToolbox([]) as unknown as AnyToolbox, () => ({
        allowList: [],
      })),
      () => ({ allowList: [] }),
    );
    expect(withAddedTools(base, additionsToolbox()).tools()).toEqual([]);
  });

  it('records the policy on what it returns, so a second addition is narrowed too', () => {
    const policy = () => ({ allowList: [] }) as ToolPolicy;
    const base = recordToolPolicy(
      withActiveSkillToolPolicy(createToolbox([]) as unknown as AnyToolbox, policy),
      policy,
    );
    const once = withAddedTools(base, additionsToolbox());
    expect(toolPolicyOf(once)).toBe(policy);
    expect(withAddedTools(once, additionsToolbox()).tools()).toEqual([]);
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
    const inner = createToolbox([probe]) as unknown as AnyToolbox;
    const bound = new Proxy(inner, {
      get(target, property, receiver) {
        if (property !== 'execute') return Reflect.get(target, property, receiver) as unknown;
        return (call: never, options?: object) =>
          target.execute(call, { requestContext: REQUEST_CONTEXT, ...options });
      },
    });

    await withAddedTools(bound, additionsToolbox()).execute({
      id: 'probe-1',
      name: 'probe',
      arguments: {},
    });

    expect(seen).toEqual(['alice']);
  });

  it('answers for the added tools, in the order the calls came in', async () => {
    const effects: string[] = [];
    const toolbox = withAddedTools(
      createToolbox([chargeTool(effects)]) as unknown as AnyToolbox,
      additionsToolbox(),
    );
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

  it('keeps the base’s tool when an addition shares its name', async () => {
    const base = createToolbox([
      createTool({
        name: 'added',
        description: 'the host’s own',
        input: z.object({}),
        execute: async () => 'host',
      }),
    ]) as unknown as AnyToolbox;
    const toolbox = withAddedTools(base, additionsToolbox());
    expect(toolbox.tools().map((tool) => tool.name)).toEqual(['added']);
    const result = await toolbox.execute({ id: 'x', name: 'added', arguments: {} });
    expect(result.result).toBe('host');
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
  const bindRequestContext = (inner: AnyToolbox): AnyToolbox =>
    new Proxy(inner, {
      get(target, property, receiver) {
        if (property !== 'execute') return Reflect.get(target, property, receiver) as unknown;
        return (call: never, options?: object) =>
          target.execute(call, { requestContext: REQUEST_CONTEXT, ...options });
      },
    });

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
        const policy = allowOnly(['charge']);
        return recordToolPolicy(
          withActiveSkillToolPolicy(
            createToolbox([chargeTool([])]) as unknown as AnyToolbox,
            policy,
          ),
          policy,
        );
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
        ) as unknown as AnyToolbox,
      holds: async (toolbox) => {
        const paused = await toolbox.execute(
          { id: 'p', name: 'pay', arguments: { cents: 1 } },
          {
            requestContext: {
              ...REQUEST_CONTEXT,
              audience: 'operator',
              agentId: 'guard',
              runId: 'guard-run',
            } as ToolRequestContext,
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
    const stacked = recordToolPolicy(
      bindRequestContext(withActiveSkillToolPolicy(idempotent(effects), policy)),
      policy,
    );
    const toolbox = withAddedTools(stacked, additionsToolbox());

    expect((await toolbox.execute(charge('1'))).outcome).toBe('success');
    expect((await toolbox.execute(charge('2'))).outcome).toBe('success');
    expect(effects).toEqual(['order-1']);
    expect(toolbox.tools().map((tool) => tool.name)).toEqual(['charge']);
    expect((await toolbox.execute({ id: 'g', name: 'added', arguments: {} })).outcome).toBe(
      'error',
    );
  });
});
