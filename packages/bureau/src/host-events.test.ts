/**
 * COR-2098 — the plugin and secret changes a host reports through `BureauOptions.hostEvents` reach
 * the event feed as `secret.set`, `secret.removed`, `plugin.settings-changed` and
 * `plugin.status-changed`, checked at the boundary: a report that is not one of the four published
 * shapes is dropped, and nothing outside the checked fields is ever published, so a careless host
 * cannot put a secret's value, a message or a path on a feed that pushes to webhooks and hooks.
 */
import { createAgent, stopWhen } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { forwardHostEvents, hostEventOf } from './bureau-event-forwarders';
import type { BureauDiagnostic, BureauHostEvent, BureauHostEvents } from './bureau-types/options';
import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';
import { workspaceHookEvents } from './hooks/workspace-hook-events';
import { createReceiver, deliveriesOf, newEncryptionKey } from './hooks/hooks.test-support';
import { projectBureauEvent } from './bureau-event-feed';
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';

const SECRET = 'sk-CANARY-2098-value-9d3f';

/** A port a test reports through, and counts the listeners of. */
function createPort() {
  const listeners = new Set<(event: BureauHostEvent) => void>();
  const port: BureauHostEvents = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    port,
    listeners: () => listeners.size,
    /** Reports `event` as a host would, without the compiler's help: a host is outside the type system. */
    report: (event: unknown) => {
      for (const listener of listeners) listener(event as BureauHostEvent);
    },
  };
}

const SET = { kind: 'secret.set', payload: { plugin: 'kit', key: 'kit-api-key' } } as const;

describe('hostEventOf (COR-2098)', () => {
  it.each([
    [
      'secret.set',
      { plugin: 'kit', key: 'kit-api-key' },
      { kind: 'secret.set', payload: { plugin: 'kit', key: 'kit-api-key' } },
    ],
    [
      'secret.removed',
      { plugin: 'kit', key: 'kit-api-key' },
      { kind: 'secret.removed', payload: { plugin: 'kit', key: 'kit-api-key' } },
    ],
    [
      'plugin.settings-changed',
      { plugin: 'kit', enabled: false, restartRequired: true },
      {
        kind: 'plugin.settings-changed',
        payload: { plugin: 'kit', enabled: false, restartRequired: true },
      },
    ],
    [
      'plugin.status-changed',
      {
        plugin: 'kit',
        previousStatus: 'running',
        status: 'needs-setup',
        problemCodes: ['secret-missing'],
      },
      {
        kind: 'plugin.status-changed',
        payload: {
          plugin: 'kit',
          previousStatus: 'running',
          status: 'needs-setup',
          problemCodes: ['secret-missing'],
        },
      },
    ],
  ])('accepts a well-formed %s', (kind, payload, published) => {
    const event = hostEventOf({ kind, payload });

    expect(event).toBeDefined();
    expect(projectBureauEvent(event)).toEqual(published);
  });

  it('builds the event from the fields it checked, never from the payload it was handed', () => {
    const event = hostEventOf({
      kind: 'secret.set',
      payload: { plugin: 'kit', key: 'kit-api-key', value: SECRET, length: 24, digest: 'abc' },
    });

    expect(JSON.stringify(projectBureauEvent(event))).not.toContain(SECRET);
    expect(projectBureauEvent(event)?.payload).toEqual({ plugin: 'kit', key: 'kit-api-key' });
    expect(Object.keys(event ?? {})).not.toContain('value');
  });

  it.each([
    ['a report that is not an object', 'secret.set'],
    ['a report with no payload', { kind: 'secret.set' }],
    ['a payload that is not an object', { kind: 'secret.set', payload: SECRET }],
    ['a kind nobody publishes', { kind: 'secret.read', payload: { plugin: 'kit', key: 'a' } }],
    ['a kind that is not text', { kind: 7, payload: { plugin: 'kit', key: 'a' } }],
    [
      'a plugin that is text with spaces',
      { kind: 'secret.set', payload: { plugin: `kit ${SECRET}`, key: 'a' } },
    ],
    ['no plugin', { kind: 'secret.set', payload: { key: 'a' } }],
    [
      'a key that is not a secret key',
      { kind: 'secret.set', payload: { plugin: 'kit', key: `Key ${SECRET}` } },
    ],
    ['an upper-case key', { kind: 'secret.removed', payload: { plugin: 'kit', key: 'KIT-KEY' } }],
    [
      'a key of 129 characters',
      { kind: 'secret.set', payload: { plugin: 'kit', key: 'a'.repeat(129) } },
    ],
    [
      'a settings change with a flag that is not a boolean',
      {
        kind: 'plugin.settings-changed',
        payload: { plugin: 'kit', enabled: 'yes', restartRequired: false },
      },
    ],
    [
      'a settings change with no restartRequired',
      { kind: 'plugin.settings-changed', payload: { plugin: 'kit', enabled: true } },
    ],
    [
      'a status that is not a plugin status',
      {
        kind: 'plugin.status-changed',
        payload: {
          plugin: 'kit',
          previousStatus: 'running',
          status: `broken ${SECRET}`,
          problemCodes: [],
        },
      },
    ],
    [
      'a previous status that is missing',
      {
        kind: 'plugin.status-changed',
        payload: { plugin: 'kit', status: 'running', problemCodes: [] },
      },
    ],
    [
      'problem codes that are not a list',
      {
        kind: 'plugin.status-changed',
        payload: {
          plugin: 'kit',
          previousStatus: 'running',
          status: 'running',
          problemCodes: 'secret-missing',
        },
      },
    ],
    [
      'a problem code that is not a plugin problem code',
      {
        kind: 'plugin.status-changed',
        payload: {
          plugin: 'kit',
          previousStatus: 'running',
          status: 'needs-setup',
          problemCodes: ['secret-missing', `the key ${SECRET} is missing`],
        },
      },
    ],
  ])('drops %s', (_name, reported) => {
    expect(hostEventOf(reported)).toBeUndefined();
  });

  it('reads only what a payload holds itself, not what it inherits', () => {
    const payload = Object.create({ plugin: 'kit', key: 'kit-api-key' }) as Record<string, unknown>;

    expect(hostEventOf({ kind: 'secret.set', payload })).toBeUndefined();
    expect(
      hostEventOf(Object.create({ kind: 'secret.set', payload: { plugin: 'kit', key: 'a' } })),
    ).toBeUndefined();
  });

  it('publishes each problem code once, in the order it was given', () => {
    const event = hostEventOf({
      kind: 'plugin.status-changed',
      payload: {
        plugin: 'kit',
        previousStatus: 'running',
        status: 'needs-setup',
        problemCodes: ['panel-changed', 'secret-missing', 'panel-changed'],
      },
    });

    expect(projectBureauEvent(event)?.payload['problemCodes']).toEqual([
      'panel-changed',
      'secret-missing',
    ]);
  });
});

describe('forwardHostEvents (COR-2098)', () => {
  it('dispatches each well-formed report, drops the rest with a diagnostic that names no content, and stops when told', () => {
    const { port, report, listeners } = createPort();
    const dispatched: Event[] = [];
    const diagnostics: BureauDiagnostic[] = [];
    const stop = forwardHostEvents(
      port,
      (event) => dispatched.push(event),
      (d) => diagnostics.push(d),
    );

    report(SET);
    report({ kind: 'secret.set', payload: { plugin: 'kit', key: `Key ${SECRET}`, value: SECRET } });
    report(SET);

    expect(dispatched.map((event) => event.type)).toEqual(['secret.set', 'secret.set']);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ level: 'warn', scope: 'events' });
    expect(JSON.stringify(diagnostics)).not.toContain(SECRET);

    stop();
    expect(listeners()).toBe(0);
    report(SET);
    expect(dispatched).toHaveLength(2);
  });

  it('diagnoses a dispatch that throws and goes on with the next report', () => {
    const { port, report } = createPort();
    let calls = 0;
    const diagnostics: BureauDiagnostic[] = [];
    forwardHostEvents(
      port,
      () => {
        calls += 1;
        if (calls === 1) throw new Error('the feed is down');
      },
      (d) => diagnostics.push(d),
    );

    expect(() => report(SET)).not.toThrow();
    report(SET);

    expect(calls).toBe(2);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.level).toBe('error');
  });
});

describe('the host events on a Bureau’s feed (COR-2098)', () => {
  const bureaus: Bureau[] = [];
  afterEach(async () => {
    for (const bureau of bureaus.splice(0)) await bureau.dispose();
  });

  interface Envelope {
    readonly kind: string;
    readonly payload: Record<string, unknown>;
  }

  async function open(port: BureauHostEvents, diagnostics: BureauDiagnostic[] = []) {
    const receiver = createReceiver();
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => ({ content: 'done', toolCalls: [] }),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: new MemoryStorage(),
      hostEvents: port,
      answerEncryption: { current: await newEncryptionKey() },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      hooks: {},
      webhooks: { targets: [], fetch: receiver.fetch, sleep: () => Promise.resolve() },
    });
    bureaus.push(bureau);
    return { bureau, receiver };
  }

  async function everything(bureau: Bureau): Promise<Envelope[]> {
    const found: Envelope[] = [];
    for await (const envelope of bureau.internals.eventFeed.feed.replay()) {
      found.push(envelope);
    }
    return found;
  }

  const HOST_KINDS = new Set([
    'secret.set',
    'secret.removed',
    'plugin.settings-changed',
    'plugin.status-changed',
  ]);
  const hostKinds = (feed: readonly Envelope[]) =>
    feed.filter((entry) => HOST_KINDS.has(entry.kind));

  it('publishes each report once, as its kind with exactly its fields, and nothing a report carried beyond them', async () => {
    const { port, report } = createPort();
    const { bureau, receiver } = await open(port);
    const hook = await bureau.hooks!.create({
      action: { type: 'webhook', url: 'https://receiver.example/host' },
      events: [...HOST_KINDS],
    });

    report({ ...SET, payload: { ...SET.payload, value: SECRET } });
    report({ kind: 'secret.removed', payload: { plugin: 'kit', key: 'kit-api-key' } });
    report({
      kind: 'plugin.settings-changed',
      payload: { plugin: 'kit', enabled: false, restartRequired: true, configuration: SECRET },
    });
    report({
      kind: 'plugin.status-changed',
      payload: {
        plugin: 'kit',
        previousStatus: 'running',
        status: 'needs-setup',
        problemCodes: ['secret-missing'],
        message: SECRET,
      },
    });
    await waitUntil(
      async () => {
        const deliveries = await deliveriesOf(bureau, hook.id);
        return (
          deliveries.length === 4 && deliveries.every((delivery) => delivery.status !== 'pending')
        );
      },
      { message: 'the hook delivered the four events' },
    );
    await quietFor(50);

    const feed = await everything(bureau);
    expect(hostKinds(feed).map(({ kind, payload }) => ({ kind, payload }))).toEqual([
      { kind: 'secret.set', payload: { plugin: 'kit', key: 'kit-api-key' } },
      { kind: 'secret.removed', payload: { plugin: 'kit', key: 'kit-api-key' } },
      {
        kind: 'plugin.settings-changed',
        payload: { plugin: 'kit', enabled: false, restartRequired: true },
      },
      {
        kind: 'plugin.status-changed',
        payload: {
          plugin: 'kit',
          previousStatus: 'running',
          status: 'needs-setup',
          problemCodes: ['secret-missing'],
        },
      },
    ]);
    // No envelope, webhook body or stored delivery holds what the host put beside the fields.
    expect(JSON.stringify(feed)).not.toContain(SECRET);
    expect(receiver.calls.map((call) => call.body).join('\n')).not.toContain(SECRET);
    expect(JSON.stringify(await deliveriesOf(bureau, hook.id))).not.toContain(SECRET);
    expect(
      receiver.calls.map((call) => (JSON.parse(call.body) as Envelope).kind).toSorted(),
    ).toEqual([...HOST_KINDS].toSorted());
  });

  it('drops a report that is not one of the four shapes, with a diagnostic that names no content', async () => {
    const { port, report } = createPort();
    const diagnostics: BureauDiagnostic[] = [];
    const { bureau } = await open(port, diagnostics);

    report({ kind: 'secret.set', payload: { plugin: 'kit', key: `Key ${SECRET}` } });
    report({
      kind: 'plugin.status-changed',
      payload: {
        plugin: 'kit',
        previousStatus: 'running',
        status: 'running',
        problemCodes: [SECRET],
      },
    });
    report(SET);
    await bureau.internals.taskRegistry.flush();

    expect(hostKinds(await everything(bureau))).toHaveLength(1);
    const dropped = diagnostics.filter((diagnostic) => diagnostic.scope === 'events');
    expect(dropped).toHaveLength(2);
    expect(JSON.stringify(dropped)).not.toContain(SECRET);
  });

  it('stops listening to the host when the Bureau is disposed', async () => {
    const { port, listeners } = createPort();
    const { bureau } = await open(port);
    expect(listeners()).toBe(1);

    await bureau.dispose();

    expect(listeners()).toBe(0);
  });

  it('publishes nothing when no host reports', async () => {
    const { bureau } = await open(createPort().port);
    await bureau.internals.taskRegistry.flush();

    expect(hostKinds(await everything(bureau))).toEqual([]);
  });
});

describe('who may be given a host event (COR-2098)', () => {
  const workspace = {
    workspaceId: 'workspace-a',
    resolveMembership: async ({ subject }: { readonly subject?: string }) => ({
      version: 1 as const,
      workspaceId: 'workspace-a',
      actorId: subject,
      actorKind: 'user' as const,
      owner: `api-key:${subject}`,
      membershipRevision: 'membership-1',
      capabilities: ['workspace:use' as const, 'workspace:manage' as const],
    }),
    resolveOwnerMembership: async (owner: string) => ({
      version: 1 as const,
      workspaceId: 'workspace-a',
      actorId: owner,
      actorKind: 'user' as const,
      owner,
      membershipRevision: 'membership-1',
      capabilities: ['workspace:use' as const, 'workspace:manage' as const],
    }),
  };

  it('is no workspace hook: none of the four kinds names a run, session or owner a hook’s owner could be matched to', async () => {
    const project = workspaceHookEvents(workspace, async () => 'owner-a');
    for (const [kind, payload] of [
      ['secret.set', { plugin: 'kit', key: 'kit-api-key' }],
      ['secret.removed', { plugin: 'kit', key: 'kit-api-key' }],
      ['plugin.settings-changed', { plugin: 'kit', enabled: true, restartRequired: false }],
      [
        'plugin.status-changed',
        { plugin: 'kit', previousStatus: 'running', status: 'running', problemCodes: [] },
      ],
    ] as const) {
      const event = { kind, payload, bureauId: 'bureau-a', emittedAtMs: 1 };
      expect(await project('owner-a', event)).toBeUndefined();
      expect(await project('owner-b', event)).toBeUndefined();
    }
  });
});
