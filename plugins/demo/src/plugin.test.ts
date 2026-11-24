import { createBureau, type AgentDefinitions, type Bureau } from '@lostgradient/bureau';
import { createPluginTestHost } from '@lostgradient/bureau/testing';
import { pluginContract, pluginContributions } from '@lostgradient/interborough-plugin/testing';
import { MemoryStorage, scopedStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHANGELOG_WRITER_REPLY, DEMO_AGENT_NAMES, RELEASE_HELPER_REPLY } from './agents.ts';
import plugin, { createDemoPlugin, DEMO_APPROVAL_SECRET } from './plugin.ts';
import { createRefundLedger } from './refund-ledger.ts';
import { createFakeProcessor } from './refund-processor.ts';
import { echoInputSchema } from './workflows.ts';

pluginContract(plugin, { createHost: createPluginTestHost });

const bureaus: Bureau<AgentDefinitions>[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

/** The demo plugin's own listing: Bureau lists its built-in plugin beside the ones it loads. */
async function demoListing(bureau: Bureau<AgentDefinitions>) {
  const listings = await bureau.plugins.list();
  return listings.find(({ descriptor }) => descriptor.name === 'demo');
}

async function start(
  options: {
    readonly enabled?: boolean;
    readonly secret?: string;
    readonly seedOnStart?: boolean;
    readonly agents?: readonly (typeof DEMO_AGENT_NAMES)[number][];
    readonly storage?: MemoryStorage;
    readonly regate?: boolean;
  } = {},
) {
  const base = createDemoPlugin({
    seedOnStart: options.seedOnStart ?? false,
    ...(options.agents === undefined ? {} : { agents: options.agents }),
  });
  let policyRound = 0;
  const descriptor = options.regate
    ? {
        ...base,
        setup: async (context: Parameters<NonNullable<typeof base.setup>>[0]) =>
          base.setup!({
            ...context,
            approvals: () => ({
              beforeExecute: ({ toolName }) =>
                toolName === 'issue-refund'
                  ? { allow: false, status: 'needs_approval', reason: `round-${++policyRound}` }
                  : { allow: true, status: 'allow' },
            }),
          }),
      }
    : base;
  const bureau = await createBureau<AgentDefinitions>({
    agents: {},
    plugins: [
      {
        descriptor,
        source: 'package',
        location: '@lostgradient/plugin-demo',
      },
    ],
    ...(options.enabled === false ? {} : { pluginConfiguration: { demo: { enabled: true } } }),
    pluginSecrets: {
      get: async (key) => (key === DEMO_APPROVAL_SECRET ? options.secret : undefined),
      watch: () => () => {},
    },
    storage: options.storage ?? new MemoryStorage(),
    durable: true,
  });
  bureaus.push(bureau);
  return bureau;
}

describe('the demo plugin', () => {
  test('provides only the agents it is given, so a disabled Demo holds back exactly those', async () => {
    const bureau = await start({
      enabled: false,
      agents: ['release-helper', 'changelog-writer'],
    });
    const listed = bureau.agents.list().filter(({ id }) => id.startsWith('demo:'));
    expect(listed.map(({ id }) => id).toSorted()).toEqual([
      'demo:changelog-writer',
      'demo:release-helper',
    ]);
  });

  test('is off until the owner turns it on, and then lists its agents unavailable and runs none (COR-2009)', async () => {
    const bureau = await start({ enabled: false });
    const listing = await demoListing(bureau);
    expect(listing).toMatchObject({ descriptor: { name: 'demo' }, status: 'disabled' });
    const listed = bureau.agents.list().filter(({ id }) => id.startsWith('demo:'));
    expect(listed.map(({ id }) => id).toSorted()).toEqual(
      DEMO_AGENT_NAMES.map((name) => `demo:${name}`).toSorted(),
    );
    for (const agent of listed) {
      expect(agent).toMatchObject({
        state: 'unavailable',
        unavailable: { code: 'plugin-disabled', message: 'Plugin Demo is disabled' },
      });
      expect(bureau.agents.find(agent.id)).toBeUndefined();
    }
  });

  test('contributes one code workflow with a title and an input schema (COR-2244)', async () => {
    const contributions = await pluginContributions(plugin);
    expect(contributions.workflows?.map(({ name, title }) => ({ name, title }))).toEqual([
      { name: 'echo-input', title: 'Echo the input' },
    ]);
    expect(contributions.workflows?.[0]?.inputSchema).toBe(echoInputSchema);
    expect(echoInputSchema.safeParse({ message: 'hi' }).success).toBe(true);
    expect(echoInputSchema.safeParse({ message: 3 }).success).toBe(false);
  });

  test('declares exactly one event, demo:greeted, whose payload names the greeting by an identifier (COR-2223)', async () => {
    const contributions = await pluginContributions(plugin);
    expect(contributions.events?.map(({ name }) => name)).toEqual(['greeted']);
    const [greeted] = contributions.events ?? [];
    expect(greeted?.payload.safeParse({ greetingId: 'greeting-1' }).success).toBe(true);
    expect(greeted?.payload.safeParse({}).success).toBe(false);

    const bureau = await start({ secret: 'fixture-demo-approval-secret' });
    expect(
      bureau.plugins
        .events()
        .map(({ kind, plugin: source, payload }) => ({ kind, source, payload })),
    ).toEqual([
      {
        kind: 'demo:greeted',
        source: 'demo',
        payload: [{ name: 'greetingId', type: 'string', optional: false }],
      },
    ]);
  });

  test('declares one generated secret of its own, never the host’s approval secret', () => {
    expect(plugin.secrets).toEqual([{ key: 'demo-approval-secret', generated: true }]);
    expect(plugin.enabled).toBe(false);
  });

  test('lists the eight agents under its prefix once enabled', async () => {
    const bureau = await start({ secret: 'fixture-demo-approval-secret' });
    const ids = bureau.agents
      .list()
      .map(({ id }) => id)
      .filter((id) => id.startsWith('demo:'))
      .toSorted();
    expect(ids).toEqual(DEMO_AGENT_NAMES.map((name) => `demo:${name}`).toSorted());
  });

  test('hides only the internal agent from Chat, which a workflow or a child still runs by name (COR-2233)', async () => {
    const bureau = await start({ secret: 'fixture-demo-approval-secret' });
    const hidden = bureau.agents
      .list()
      .filter(({ id, visibility }) => id.startsWith('demo:') && visibility === 'hidden')
      .map(({ id }) => id);
    expect(hidden).toEqual(['demo:internal']);
    expect(bureau.agents.has('demo:internal')).toBe(true);
  });

  test('answers from its scripts', async () => {
    const bureau = await start({ secret: 'fixture-demo-approval-secret' });
    const assistantTask = await bureau.tasks.start('demo:assistant', 'Hello');
    const assistant = await assistantTask.result();
    expect(assistant.content).toBe(
      'Hello from the assistant. This reply is scripted; no model was called.',
    );
    const echoTask = await bureau.tasks.start('demo:echo', 'Say this back');
    const echo = await echoTask.result();
    expect(echo.content).toBe('Say this back');
  });

  test('holds the release helper and the changelog writer, which answer from their scripts', async () => {
    const bureau = await start({ secret: 'fixture-demo-approval-secret' });
    const helperTask = await bureau.tasks.start('demo:release-helper', 'Draft');
    const helper = await helperTask.result();
    expect(helper.content).toBe(RELEASE_HELPER_REPLY);
    const writerTask = await bureau.tasks.start('demo:changelog-writer', 'Write');
    const writer = await writerTask.result();
    expect(writer.content).toBe(CHANGELOG_WRITER_REPLY);
  });

  test('tool-runner stops on a refund that waits for an operator, signed with its own secret', async () => {
    const storage = new MemoryStorage();
    const bureau = await start({ secret: 'fixture-demo-approval-secret', storage });
    const task = await bureau.tasks.start('demo:tool-runner', 'Refund order-1001');
    const result = await task.result();
    const calls = result.steps.flatMap((step) =>
      step.results.map((outcome) => [outcome.toolName, outcome.outcome] as const),
    );
    expect(calls).toEqual([
      ['lookup-order', 'success'],
      ['issue-refund', 'action_required'],
    ]);
    expect(result.steps.at(-1)?.results[0]?.pendingApproval).toBeDefined();
    const intents = [];
    for await (const [, value] of storage.scan('plugin:demo:refund-ledger:refund:'))
      intents.push(JSON.parse(new TextDecoder().decode(value)));
    expect(intents).toHaveLength(1);
    const call = result.steps.at(-1)?.results[0]?.pendingApproval;
    expect(JSON.stringify(call)).toContain(intents[0].id);
    const effects = [];
    for await (const entry of storage.scan('plugin:demo:refund-processor:processor:'))
      effects.push(entry);
    expect(effects).toHaveLength(0);
    const [review] = bureau.reviews.list();
    if (!review || review.kind !== 'tool-approval') throw new Error('Missing review');
    const resolution = await bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'operator',
    });
    expect(resolution).toMatchObject({ result: { outcome: 'success' } });
    expect(JSON.stringify(resolution)).toContain('provider-pending');
    expect(JSON.stringify(resolution)).not.toContain(intents[0].providerKey);
    expect(JSON.stringify(resolution)).not.toContain(intents[0].paymentReference);
    for await (const entry of storage.scan('plugin:demo:refund-processor:processor:'))
      effects.push(entry);
    expect(effects).toHaveLength(1);
    const effect = JSON.parse(new TextDecoder().decode(effects[0]![1]));
    expect(effect).toMatchObject({
      amount: intents[0].amount,
      currency: intents[0].currency,
      paymentReference: intents[0].paymentReference,
    });
  });

  test('is needs-setup without its secret, and a demo agent refuses to run', async () => {
    const bureau = await start({});
    const listing = await demoListing(bureau);
    expect(listing?.status).toBe('needs-setup');
    expect(listing?.problems.map(({ code }) => code)).toEqual(['secret-missing']);
    const refusal = await rejectionOf(bureau.tasks.start('demo:assistant', 'Hello'));
    expect(String(refusal)).toMatch(/needs setup/);
  });
  for (const decision of ['deny', 'reject'] as const)
    test(`${decision} releases the scripted refund`, async () => {
      const storage = new MemoryStorage();
      const bureau = await start({ secret: 'fixture-demo-approval-secret', storage });
      const task = await bureau.tasks.start('demo:tool-runner', 'Refund order-1001');
      await task.result();
      const [review] = bureau.reviews.list();
      if (!review || review.kind !== 'tool-approval') throw new Error('Missing review');
      await bureau.reviews.resolve({
        id: review.id,
        decision,
        principal: 'operator',
        ...(decision === 'reject' ? { reason: 'No refund' } : {}),
      });
      const effects = [];
      for await (const entry of storage.scan('plugin:demo:refund-processor:processor:'))
        effects.push(entry);
      expect(effects).toHaveLength(0);
      const ledger = createRefundLedger(scopedStorage(storage, 'plugin:demo:refund-ledger'));
      const intents = [];
      for await (const [, value] of storage.scan('plugin:demo:refund-ledger:refund:'))
        intents.push(JSON.parse(new TextDecoder().decode(value)));
      expect(intents[0].status).toBe('failed');
      expect(await ledger.balance(intents[0].merchant, intents[0].order)).toMatchObject({
        reserved: 0,
      });
      await ledger.admit({
        merchant: intents[0].merchant,
        order: intents[0].order,
        commandId: 'replacement',
        amount: 10000,
        toolRevision: '1.1.0',
        owner: 'demo',
      });
      expect(await ledger.balance(intents[0].merchant, intents[0].order)).toMatchObject({
        reserved: 10000,
      });
    });
  test('allow-all still requires a new refund review', async () => {
    const bureau = await start({ secret: 'fixture-demo-approval-secret' });
    const first = await bureau.tasks.start('demo:tool-runner', 'Refund order-1001', {
      principal: 'alice',
    });
    await first.result();
    const [review] = bureau.reviews.list();
    if (!review || review.kind !== 'tool-approval') throw new Error('Missing review');
    await bureau.reviews.resolve({ id: review.id, decision: 'deny', principal: 'alice' });
    await bureau.contexts.steer(first.contextId, {
      id: 'allow-all',
      principal: 'alice',
      requestedValue: { target: 'permission-mode', override: 'allow-all' },
    });
    const second = await bureau.tasks.start('demo:tool-runner', 'Refund again', {
      principal: 'alice',
      contextId: first.contextId,
    });
    const result = await second.result();
    expect(result.steps.at(-1)?.results[0]?.outcome).toBe('action_required');
  });
  test('a superseded review does not release or submit the refund', async () => {
    const storage = new MemoryStorage();
    const bureau = await start({ secret: 'fixture-demo-approval-secret', storage, regate: true });
    const task = await bureau.tasks.start('demo:tool-runner', 'Refund');
    await task.result();
    const [review] = bureau.reviews.list();
    if (!review || review.kind !== 'tool-approval') throw new Error('Missing review');
    const resolution = await bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'operator',
    });
    expect(resolution).toMatchObject({ superseded: true });
    const intents = [];
    for await (const [, value] of storage.scan('plugin:demo:refund-ledger:refund:'))
      intents.push(JSON.parse(new TextDecoder().decode(value)));
    expect(intents[0].status).toBe('admitted');
    const ledger = createRefundLedger(scopedStorage(storage, 'plugin:demo:refund-ledger'));
    expect(await ledger.balance(intents[0].merchant, intents[0].order)).toMatchObject({
      reserved: 4200,
    });
    const effects = [];
    for await (const entry of storage.scan('plugin:demo:refund-processor:processor:'))
      effects.push(entry);
    expect(effects).toHaveLength(0);
  });
  test('a stale terminal release cannot cancel a provider-admitted refund', async () => {
    const storage = new MemoryStorage();
    const descriptor = createDemoPlugin({ seedOnStart: false });
    const contributions = await descriptor.setup!({
      configuration: {},
      secrets: { get: async () => 'fixture-secret' },
      storage,
      approvals: () => ({}),
      host: {},
    } as never);
    if (!contributions) throw new Error('Missing contributions');
    const release = contributions.releases?.[0];
    if (!release) throw new Error('Missing terminal release');
    const ledger = createRefundLedger(scopedStorage(storage, 'refund-ledger'));
    await ledger.addCharge({
      merchant: 'merchant',
      order: 'order',
      amount: 10000,
      currency: 'USD',
      paymentReference: 'charge',
      providerAccount: 'account',
    });
    const intent = await ledger.admit({
      merchant: 'merchant',
      commandId: 'command',
      order: 'order',
      amount: 4000,
      toolRevision: '1.1.0',
      owner: 'demo',
      existingRunId: 'run',
    });
    const submitted = await ledger.claim(intent.id, 100);
    await release.release({
      identifier: intent.id,
      runId: 'run',
      reviewId: 'review',
      round: 0,
      toolRevision: release.toolRevision,
    });
    expect(await ledger.get(intent.id)).toEqual(submitted);
    expect(await ledger.balance('merchant', 'order')).toMatchObject({ reserved: 4000, settled: 0 });
  });
  test('an edited approval cannot submit another run’s refund', async () => {
    const storage = new MemoryStorage();
    const bureau = await start({ secret: 'fixture-demo-approval-secret', storage });
    const first = await bureau.tasks.start('demo:tool-runner', 'First');
    const second = await bureau.tasks.start('demo:tool-runner', 'Second');
    await Promise.all([first.result(), second.result()]);
    const reviews = bureau.reviews.list().filter((review) => review.kind === 'tool-approval');
    const reviewA = reviews.find((review) => review.runId === first.id);
    const reviewB = reviews.find((review) => review.runId === second.id);
    if (
      !reviewA ||
      !reviewB ||
      reviewA.kind !== 'tool-approval' ||
      reviewB.kind !== 'tool-approval'
    )
      throw new Error('Missing reviews');
    const result = await bureau.reviews.resolve({
      id: reviewA.id,
      decision: 'approve',
      principal: 'operator',
      arguments: reviewB.approval.arguments,
    });
    expect(result).toMatchObject({ superseded: true });
    const secondDecision = await bureau.reviews.resolve({
      id: reviewA.id,
      decision: 'approve',
      principal: 'operator',
    });
    expect(secondDecision).toMatchObject({ result: { outcome: 'error' } });
    const effects = [];
    for await (const entry of storage.scan('plugin:demo:refund-processor:processor:'))
      effects.push(entry);
    expect(effects).toHaveLength(0);
    const intents = [];
    for await (const [, value] of storage.scan('plugin:demo:refund-ledger:refund:'))
      intents.push(JSON.parse(new TextDecoder().decode(value)));
    expect(intents.map((intent) => intent.status)).toEqual(['admitted', 'admitted']);
  });
  test('plugin startup reconciles an accepted refund without a model call', async () => {
    const storage = new MemoryStorage();
    const ledger = createRefundLedger(scopedStorage(storage, 'plugin:demo:refund-ledger'));
    const processor = createFakeProcessor(scopedStorage(storage, 'plugin:demo:refund-processor'));
    await ledger.addCharge({
      merchant: 'merchant',
      order: 'order',
      amount: 10000,
      currency: 'USD',
      paymentReference: 'charge',
      providerAccount: 'account',
    });
    const intent = await ledger.admit({
      merchant: 'merchant',
      commandId: 'command',
      order: 'order',
      amount: 4000,
      toolRevision: '1.1.0',
      owner: 'demo',
      existingRunId: 'run',
    });
    const attempt = await ledger.claim(intent.id, Date.now() + 86400000);
    const accepted = await processor.submit(attempt);
    const bureau = await start({ secret: 'fixture-demo-approval-secret', storage });
    await bureau.plugins.ready();
    expect(await ledger.get(intent.id)).toMatchObject({
      status: 'provider-pending',
      receipt: accepted.receipt,
    });
    expect(await processor.refunds()).toHaveLength(1);
  });
  test('a continued turn locates the original refund without another review', async () => {
    const storage = new MemoryStorage();
    const bureau = await start({ secret: 'fixture-demo-approval-secret', storage });
    const original = await bureau.tasks.start('demo:tool-runner', 'Refund');
    await original.result();
    const [review] = bureau.reviews.list();
    if (!review || review.kind !== 'tool-approval') throw new Error('Missing review');
    const refundId = (review.approval.arguments as { refundId: string }).refundId;
    const replay = await bureau.tasks.start(
      'demo:tool-runner',
      { continue: true },
      { contextId: original.contextId },
    );
    const reply = await replay.result();
    expect(reply.content).toContain(refundId);
    await waitUntil(async () => {
      const current = await bureau.contexts.get(original.contextId);
      return (
        current?.conversationHistory.ids.some(
          (id) =>
            current.conversationHistory.messages[id]?.role === 'assistant' &&
            current.conversationHistory.messages[id]?.content === reply.content,
        ) ?? false
      );
    });
    expect(bureau.reviews.list().map((entry) => entry.id)).toEqual([review.id]);
    const session = await bureau.contexts.get(original.contextId);
    if (!session) throw new Error('Missing session');
    const rows = session.conversationHistory.ids.map(
      (id) => session.conversationHistory.messages[id],
    );
    const calls = rows.filter((row) => row?.role === 'tool-call').map((row) => row?.toolCall?.id);
    const results = rows
      .filter((row) => row?.role === 'tool-result')
      .map((row) => row?.toolResult?.callId);
    expect(calls).toEqual([...new Set(calls)]);
    expect(calls.filter((id) => id === 'seeded-lookup-order-1')).toHaveLength(1);
    expect(results).toEqual([...new Set(results)]);
    expect(results.filter((id) => !calls.includes(id))).toEqual([]);
    expect(
      rows
        .filter((row) => row?.role === 'tool-result')
        .map((row) => ({
          id: row?.toolResult?.callId,
          call: rows.findIndex(
            (item) => item?.role === 'tool-call' && item.toolCall?.id === row?.toolResult?.callId,
          ),
          result: rows.indexOf(row),
        }))
        .filter((row) => row.call >= row.result),
    ).toEqual([]);
    expect(rows.filter((row) => row === undefined)).toEqual([]);
    expect(session.conversationHistory.ids).toEqual([...new Set(session.conversationHistory.ids)]);
    expect(
      Object.keys(session.conversationHistory.messages).filter(
        (id) => !session.conversationHistory.ids.includes(id),
      ),
    ).toEqual([]);
    const effects = [];
    for await (const entry of storage.scan('plugin:demo:refund-processor:processor:'))
      effects.push(entry);
    expect(effects).toHaveLength(0);
    const resolved = await bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'operator',
    });
    expect(resolved).toMatchObject({ result: { outcome: 'success' } });
    for await (const entry of storage.scan('plugin:demo:refund-processor:processor:'))
      effects.push(entry);
    expect(effects).toHaveLength(1);
    const after = await bureau.contexts.get(original.contextId);
    if (!after) throw new Error('Missing resolved session');
    const afterRows = after.conversationHistory.ids.map(
      (id) => after.conversationHistory.messages[id],
    );
    expect(
      afterRows.filter(
        (row) =>
          row?.toolResult?.callId === review.approval.callId &&
          row.toolResult.outcome === 'success',
      ),
    ).toHaveLength(1);
  });
});
