/**
 * COR-2127 — the plan a Bureau run holds: Bureau's tier, the `plugin` tier, and the agent's own,
 * each in its fixed band. The behavioral rows of the outcome matrix (which runs an every-agent
 * interceptor reaches, once, and skipped while its plugin needs setup) are in
 * `every-agent-interceptors.test.ts`; these are the plan-level rows:
 *
 * | case | result |
 * | -- | -- |
 * | a run with the plugin tier | its entries show `tier: 'plugin'`, between `bureau` and `agent` |
 * | a waterfall point with Bureau's pinned-last entries, four tiers | the pinned-last entry still last |
 * | a run with no plugin tier | Bureau's and the agent's priorities as with one (fixed bands) |
 * | a durable run resumed after a restart | the plugin tier is composed again |
 * | a new Bureau composition site | composes through `composeRunHooks` (source guard) |
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { HOOK_TIER_PRIORITY_BANDS, HookRegistry } from '@lostgradient/lifecycle';
import {
  AGENT_POLICY_PINNED_LAST_PRIORITY,
  createAgent,
  createAgentSession,
  hasDefinitionResolver,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  type DurableRunDeps,
  type HookPlanEntryDescription,
  type OperativeHookMap,
  type RunOptions,
  type SessionStore,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import {
  type AgentContributions,
  createAgentContributions,
  INTERCEPTOR_PRIORITY_CEILING,
  INTERCEPTOR_PRIORITY_FLOOR,
  interceptorsOf,
} from './agent-contributions';
import { composeRunHooks } from './run-hook-tiers';
import { BUREAU_PINNED_LAST_PRIORITY, createRuntimeComposition } from './runtime-composition';

afterEach(async () => {
  // load-proof: the work this lets finish runs on in-memory storage and settles through promise continuations only, as in runtime-composition.test.ts; no timer or I/O is pending
  await yieldToPortableEventLoop();
});

/** An every-agent set on `prepareStep` and on the `validateResponse` waterfall. */
function everyAgentContributions(): AgentContributions {
  return createAgentContributions([
    {
      plugin: 'audit',
      interceptors: [
        {
          name: 'every',
          appliesTo: 'every-agent',
          prepareStep: { handler: async () => undefined, replay: 'safe' },
          validateResponse: { handler: async () => undefined, replay: 'safe' },
        },
      ],
    },
  ]);
}

/** A catalog agent's resolved options, with an agent tier of its own on both points. */
function catalogOptions(): RunOptions {
  const agentHooks = new HookRegistry<OperativeHookMap>({ source: 'agent' });
  agentHooks.on('prepareStep', async () => undefined, { id: 'agent:own', replay: 'safe' });
  agentHooks.on('validateResponse', async () => undefined, { id: 'agent:narrow', replay: 'safe' });
  return {
    generate: async () => ({ content: 'from the agent', toolCalls: [] }),
    toolbox: createToolbox([], { context: {} }),
    conversation: createConversationHistory({ id: 'catalog-recovered' }),
    hooks: agentHooks,
  };
}

/** A runtime composition over `contributions`, with the identity invariant and the guardrails. */
async function composition(contributions: AgentContributions | undefined) {
  return createRuntimeComposition({
    // A session run and a scheduled fire are rebuilt over the Bureau's own generate and toolbox.
    generate: async () => ({ content: 'ok', toolCalls: [] }),
    toolbox: createToolbox([], { context: {} }),
    identity: { resolve: async () => 'the house agent' },
    storage: new MemoryStorage(),
    durable: true,
    ...(contributions === undefined ? {} : { agentContributions: contributions }),
  });
}

type Runtime = Awaited<ReturnType<typeof composition>>;

function planOf(services: unknown): readonly HookPlanEntryDescription[] {
  const hooks = (services as DurableRunDeps).options.hooks;
  if (hooks === undefined) throw new Error('run options carried no hook registry');
  return hooks.describePlan().entries;
}

/** The plan of a durably dispatched catalog run, recovered as a restarted Bureau resumes it. */
async function recoveredCatalogPlan(
  runtime: Runtime,
  runId: string,
  options: () => Promise<RunOptions> | RunOptions = catalogOptions,
) {
  runtime.setCatalogAgentRunOptionsResolver(async () => ({
    status: 'resolved',
    generationMode: 'selectable',
    options: await options(),
    definitionRevision: 1,
  }));
  await runtime.persistCatalogRunRecoveryRecord(runId, {
    agentName: 'echo',
    definitionRevision: 1,
    input: 'hello',
  });
  const result = await runtime.resolveRunServices({
    workflowId: runId,
    workflowType: 'agentRun',
    input: { runId, sessionId: runId, agentName: 'echo' },
  });
  if (result.status !== 'available') throw new Error(`not available: ${result.reason}`);
  return planOf(result.services);
}

/** The plan of a session run, recovered from its persisted session after a restart. */
async function recoveredSessionPlan(runtime: Runtime, runId: string) {
  await saveRecoverableSession(runtime.sessionStore!, runId);
  const result = await runtime.resolveRunServices({
    workflowId: runId,
    workflowType: 'agentRun',
    input: { runId, sessionId: runId, agentName: 'test-agent' },
  });
  if (result.status !== 'available') throw new Error(`not available: ${result.reason}`);
  return planOf(result.services);
}

/** The plan of a scheduled fire, rebuilt as a restarted Bureau rebuilds it. */
async function scheduledPlan(runtime: Runtime, runId: string) {
  const resolution = await runtime.buildScheduledRunServices(
    {
      workflowId: runId,
      workflowType: 'agentRun',
      input: {
        agentName: 'researcher',
        input: 'nightly digest',
        scheduleId: 'nightly-digest',
        sessionId: `${runId}-session`,
      },
      schedule: { id: 'nightly-digest' },
    },
    runtime.sessionStore!,
  );
  if (resolution.status !== 'available') throw new Error(`not available: ${resolution.reason}`);
  return planOf(resolution.services);
}

async function saveRecoverableSession(sessionStore: SessionStore, runId: string): Promise<void> {
  await sessionStore.save(
    createAgentSession({
      id: runId,
      agentName: 'test-agent',
      conversationHistory: createConversationHistory(),
      metadata: {
        lastRunId: runId,
        lastRunStatus: 'running',
        lastUserMessage: 'recover this session',
        lastRequestAuthority: {
          principalId: `run:${runId}`,
          tenantId: 'bureau',
          ownerId: 'test-agent',
          capabilities: ['tools:execute'],
          authorizationRevision: 'bureau:1',
          audience: 'operator',
        },
      },
    }),
  );
}

const runtimes: Runtime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.durable?.engine[Symbol.dispose]?.();
});

async function open(contributions: AgentContributions | undefined): Promise<Runtime> {
  const runtime = await composition(contributions);
  runtimes.push(runtime);
  return runtime;
}

const pointPlan = (entries: readonly HookPlanEntryDescription[], hookName: string) =>
  entries
    .filter((entry) => entry.hookName === hookName)
    .map(({ id, tier, priority }) => ({ id, tier, priority }));

describe('the plugin tier in a run’s plan (COR-2127)', () => {
  it('shows every-agent entries as tier plugin, between the bureau and agent tiers', async () => {
    const entries = await recoveredCatalogPlan(
      await open(everyAgentContributions()),
      'plugin-tier-run',
    );

    expect(pointPlan(entries, 'prepareStep')).toEqual([
      { id: 'bureau:identity', tier: 'bureau', priority: HOOK_TIER_PRIORITY_BANDS.bureau },
      {
        id: 'bureau:guardrails-prepare-step',
        tier: 'bureau',
        priority: HOOK_TIER_PRIORITY_BANDS.bureau,
      },
      {
        id: 'audit:every:prepareStep',
        tier: 'plugin',
        priority: HOOK_TIER_PRIORITY_BANDS.plugin,
      },
      { id: 'agent:own', tier: 'agent', priority: HOOK_TIER_PRIORITY_BANDS.agent },
    ]);
    expect(entries.find((entry) => entry.id === 'audit:every:prepareStep')?.source).toBe('audit');
  });

  it('keeps Bureau’s pinned-last entry last on a waterfall point with four tiers', async () => {
    const entries = await recoveredCatalogPlan(
      await open(everyAgentContributions()),
      'pinned-last-run',
    );

    expect(pointPlan(entries, 'validateResponse')).toEqual([
      {
        id: 'audit:every:validateResponse',
        tier: 'plugin',
        priority: HOOK_TIER_PRIORITY_BANDS.plugin,
      },
      { id: 'agent:narrow', tier: 'agent', priority: HOOK_TIER_PRIORITY_BANDS.agent },
      {
        id: 'bureau:guardrails-validate-response',
        tier: 'bureau',
        priority: BUREAU_PINNED_LAST_PRIORITY + HOOK_TIER_PRIORITY_BANDS.bureau,
      },
    ]);
  });

  // The production path: `createAgent` already composed its own plan, stamped `agent`, and its
  // guardrails registered in that band; Bureau merging it again must not add the band twice, which
  // would put the agent's entries in the plugin band.
  it('keeps a createAgent plan in the agent band when Bureau merges it again', async () => {
    const agentHooks = new HookRegistry<OperativeHookMap>({ source: 'agent' });
    agentHooks.on('prepareStep', async () => undefined, { id: 'agent:own', replay: 'safe' });
    const agent = createAgent({
      name: 'echo',
      hooks: agentHooks,
      generate: async () => ({ content: 'from the agent', toolCalls: [] }),
    });
    if (!hasDefinitionResolver(agent)) throw new Error('expected an agent with a resolver');

    const entries = await recoveredCatalogPlan(
      await open(everyAgentContributions()),
      'create-agent-run',
      () => agent[OPERATIVE_RESOLVE_RUN_OPTIONS]('hello', {}),
    );

    expect(pointPlan(entries, 'prepareStep').filter(({ tier }) => tier !== 'bureau')).toEqual([
      {
        id: 'audit:every:prepareStep',
        tier: 'plugin',
        priority: HOOK_TIER_PRIORITY_BANDS.plugin,
      },
      { id: 'agent:own', tier: 'agent', priority: HOOK_TIER_PRIORITY_BANDS.agent },
      {
        id: 'agent:guardrails-prepare-step',
        tier: 'agent',
        priority: AGENT_POLICY_PINNED_LAST_PRIORITY + HOOK_TIER_PRIORITY_BANDS.agent,
      },
    ]);
  });

  it('gives Bureau’s and the agent’s entries the same priorities with no plugin tier', async () => {
    const withPlugin = await recoveredCatalogPlan(
      await open(everyAgentContributions()),
      'with-plugin-run',
    );
    const withoutPlugin = await recoveredCatalogPlan(await open(undefined), 'without-plugin-run');

    const priorities = (entries: readonly HookPlanEntryDescription[]) =>
      entries
        .filter((entry) => entry.tier !== 'plugin')
        .map(({ hookName, id, priority }) => ({ hookName, id, priority }));
    expect(withoutPlugin.some((entry) => entry.tier === 'plugin')).toBe(false);
    expect(priorities(withoutPlugin)).toEqual(priorities(withPlugin));
  });

  it.each([
    ['a recovered catalog run', recoveredCatalogPlan],
    ['a recovered session run', recoveredSessionPlan],
    ['a scheduled fire', scheduledPlan],
  ] as const)('composes the plugin tier again for %s after a restart', async (label, planFor) => {
    const runtime = await open(everyAgentContributions());

    const entries = await planFor(runtime, `resumed-${label.replaceAll(' ', '-')}`);

    expect(
      entries.filter((entry) => entry.tier === 'plugin').map(({ id, source }) => ({ id, source })),
    ).toEqual([
      { id: 'audit:every:prepareStep', source: 'audit' },
      { id: 'audit:every:validateResponse', source: 'audit' },
    ]);
  });

  // Ruling on decision 4: an agent that lists the set holds it in its own tier, so it refuses while
  // its plugin needs setup, and the plugin tier leaves it out of that run.
  it('registers an every-agent set once, in the agent tier, for an agent that lists it', () => {
    const contributions = everyAgentContributions();

    const listing = composeRunHooks(contributions, {
      bureau: undefined,
      agent: interceptorsOf({ interceptors: ['audit:every'] }, contributions),
    });
    const other = composeRunHooks(contributions, { bureau: undefined, agent: undefined });

    const tiers = (registry: typeof listing) =>
      registry.describePlan().entries.map(({ id, tier }) => ({ id, tier }));
    expect(tiers(listing)).toEqual([
      { id: 'audit:every:prepareStep', tier: 'agent' },
      { id: 'audit:every:validateResponse', tier: 'agent' },
    ]);
    expect(tiers(other)).toEqual([
      { id: 'audit:every:prepareStep', tier: 'plugin' },
      { id: 'audit:every:validateResponse', tier: 'plugin' },
    ]);
  });

  it('hands a Bureau-owned run’s children the plugin tier through the child seam', async () => {
    const runtime = await open(everyAgentContributions());

    const first = runtime.bureauChildInvariants({ agentResolvesGuardrails: true });
    const second = runtime.bureauChildInvariants({ agentResolvesGuardrails: true });

    expect(first.plugin?.describePlan().entries.map((entry) => entry.id)).toEqual([
      'audit:every:prepareStep',
      'audit:every:validateResponse',
    ]);
    expect(second.plugin).not.toBe(first.plugin);
  });
});

describe('a plugin interceptor stays inside its tier’s band (COR-2127)', () => {
  // A declared priority is added to its tier's band, and the bands are one band width apart, so a
  // priority past the width would carry the entry into the next tier up.
  const HUGE = 1e9;
  /** One set at `HUGE` on `prepareStep`, applying to every agent or only to one that lists it. */
  const greedy = (appliesTo: 'every-agent' | undefined) =>
    createAgentContributions([
      {
        plugin: 'audit',
        interceptors: [
          {
            name: 'greedy',
            ...(appliesTo === undefined ? {} : { appliesTo }),
            prepareStep: { handler: async () => undefined, replay: 'safe', priority: HUGE },
          },
        ],
      },
    ]);

  /** Bureau's identity invariant, as the one Bureau-tier entry a run's `prepareStep` has. */
  function bureauTier() {
    const bureau = new HookRegistry<OperativeHookMap>({ source: 'bureau' });
    bureau.on('prepareStep', async () => undefined, { id: 'bureau:identity', replay: 'safe' });
    return bureau;
  }

  it('runs a plugin-tier interceptor at a very high priority after Bureau’s invariants', () => {
    // The every-agent set is in the plugin tier for an agent that does not list it.
    const registry = composeRunHooks(greedy('every-agent'), {
      bureau: bureauTier(),
      agent: undefined,
    });

    const order = pointPlan(registry.describePlan().entries, 'prepareStep');
    expect(order.map(({ id, tier }) => ({ id, tier }))).toEqual([
      { id: 'bureau:identity', tier: 'bureau' },
      { id: 'audit:greedy:prepareStep', tier: 'plugin' },
    ]);
    expect(order[1]?.priority).toBe(INTERCEPTOR_PRIORITY_CEILING + HOOK_TIER_PRIORITY_BANDS.plugin);
    expect(order[1]?.priority).toBeLessThan(HOOK_TIER_PRIORITY_BANDS.bureau);
  });

  it('runs an agent-tier interceptor at a very high priority after Bureau’s invariants', () => {
    const contributions = greedy(undefined);
    const plan = composeRunHooks(contributions, {
      bureau: bureauTier(),
      agent: interceptorsOf({ interceptors: ['audit:greedy'] }, contributions),
    }).describePlan().entries;

    const order = pointPlan(plan, 'prepareStep');
    expect(order.map(({ id }) => id)).toEqual(['bureau:identity', 'audit:greedy:prepareStep']);
    expect(order[1]?.tier).toBe('agent');
    expect(order[1]?.priority).toBe(INTERCEPTOR_PRIORITY_CEILING + HOOK_TIER_PRIORITY_BANDS.agent);
    expect(order[1]?.priority).toBeLessThan(HOOK_TIER_PRIORITY_BANDS.bureau);
  });
});

describe('the bands keep each tier’s pinned entries in order (COR-2127)', () => {
  it('sorts Bureau’s pinned-last entry below the agent’s guardrails and every interceptor', () => {
    const bureauPinned = BUREAU_PINNED_LAST_PRIORITY + HOOK_TIER_PRIORITY_BANDS.bureau;
    const agentGuardrails = AGENT_POLICY_PINNED_LAST_PRIORITY + HOOK_TIER_PRIORITY_BANDS.agent;
    const agentInterceptorFloor = INTERCEPTOR_PRIORITY_FLOOR + HOOK_TIER_PRIORITY_BANDS.agent;
    const pluginInterceptorFloor = INTERCEPTOR_PRIORITY_FLOOR + HOOK_TIER_PRIORITY_BANDS.plugin;

    expect(Number.isSafeInteger(bureauPinned)).toBe(true);
    expect(bureauPinned).toBeLessThan(agentGuardrails);
    expect(agentGuardrails).toBeLessThan(agentInterceptorFloor);
    expect(agentInterceptorFloor).toBeLessThan(pluginInterceptorFloor);
  });
});

/**
 * Every Bureau site that hands a run its hooks composes them through `composeRunHooks`, which adds
 * the plugin tier itself, so a new site cannot forget it. A source guard rather than a behavior,
 * stated as one: a site that merged its own tiers would still produce a working plan, only without
 * the plugin tier.
 */
describe('one composition helper (COR-2127)', () => {
  const HELPER = 'run-hook-tiers.ts';

  async function bureauSources(directory: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) found.push(...(await bureauSources(path)));
      else if (
        entry.name.endsWith('.ts') &&
        !/\.test(-d)?\.ts$|\.test-support\.ts$/u.test(entry.name) &&
        !path.includes(`${join('src', 'test')}/`)
      ) {
        found.push(path);
      }
    }
    return found;
  }

  /** Whether `text` names `mergeHookRegistries` outside a comment. */
  function mergesDirectly(text: string): boolean {
    const code = text.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/\/\/.*$/gmu, '');
    return /\bmergeHookRegistries\b/u.test(code);
  }

  it('finds no Bureau source file but the helper that merges hook registries itself', async () => {
    const root = new URL('.', import.meta.url).pathname;
    const offenders: string[] = [];
    for (const path of await bureauSources(root)) {
      if (path.endsWith(`/${HELPER}`)) continue;
      if (mergesDirectly(await Bun.file(path).text())) offenders.push(path.slice(root.length));
    }

    expect(offenders).toEqual([]);
    expect(mergesDirectly(await Bun.file(join(root, HELPER)).text())).toBe(true);
  });

  it('catches a site that merges its own tiers', () => {
    expect(mergesDirectly("import { mergeHookRegistries } from '@lostgradient/lifecycle';\n")).toBe(
      true,
    );
    expect(mergesDirectly('// `mergeHookRegistries` is described here only\n')).toBe(false);
  });
});
