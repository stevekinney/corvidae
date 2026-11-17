/**
 * COR-2170: the GitHub plugin's `github:webhook` receive trigger. Each case builds the delivery
 * GitHub sends (the raw bytes of a body, `X-Hub-Signature-256` over them, `X-GitHub-Event`,
 * `X-GitHub-Delivery`), hands it to the trigger's `receive` with a context whose `fire` keeps what
 * it was given and remembers an idempotency key as the host does, and reads the status it answered.
 *
 * The two bodies in `fixtures/` carry the fields GitHub documents for a push and a pull request
 * delivery, with made-up identifiers: they are not recordings of a real delivery, and no secret is
 * in either.
 */
import { createHash, createHmac } from 'node:crypto';

import { createPluginTestHost } from '@lostgradient/bureau/testing';
import type { PluginTriggerContext, PluginTriggerOutcome } from '@lostgradient/interborough-plugin';
import { pluginContract } from '@lostgradient/interborough-plugin/testing';
import { describe, expect, test } from 'bun:test';

import plugin, {
  DEFAULT_GITHUB_EVENTS,
  GITHUB_EVENTS,
  GITHUB_WEBHOOK_SECRET,
  githubWebhook,
} from './plugin.ts';

pluginContract(plugin, { createHost: createPluginTestHost });

const SECRET = 'whsec-fixture-secret-never-used-elsewhere';
const secrets = {
  get: async (key: string) => (key === GITHUB_WEBHOOK_SECRET ? SECRET : undefined),
};
const trigger = githubWebhook(secrets);

const PUSH = await Bun.file(new URL('./fixtures/push.json', import.meta.url)).bytes();
const PULL_REQUEST = await Bun.file(
  new URL('./fixtures/pull-request.json', import.meta.url),
).bytes();
const DELIVERY = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

/** What GitHub writes in `X-Hub-Signature-256` for `body`. */
function sign(body: Uint8Array | string, secret: string = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function sha256Hex(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

/** One delivery as GitHub sends it, with any header the case overrides or leaves out. */
function delivery(body: Uint8Array | string, headers: Record<string, string | null> = {}): Request {
  const all: Record<string, string | null> = {
    'content-type': 'application/json',
    'x-github-event': 'push',
    'x-github-delivery': DELIVERY,
    'x-hub-signature-256': sign(body),
    ...headers,
  };
  const sent = new Headers();
  for (const [name, value] of Object.entries(all)) if (value !== null) sent.set(name, value);
  return new Request('http://localhost/triggers/octo-flow', {
    method: 'POST',
    headers: sent,
    body: typeof body === 'string' ? body : new Uint8Array(body),
  });
}

/** A host's side of `fire`: it keeps each call, and starts one run per distinct key. */
function rig(
  configuration: { events?: readonly string[] } = {},
  behavior: { skipped?: 'stopped' | 'paused' | 'closed' } = {},
) {
  const fires: { payload: unknown; idempotencyKey: string | undefined }[] = [];
  const runs = new Map<string, string>();
  const context = {
    configuration: trigger.configuration.parse(configuration),
    workflowId: 'octo-flow',
    storage: undefined,
    signal: new AbortController().signal,
    async fire(
      payload: unknown,
      options?: { idempotencyKey?: string },
    ): Promise<PluginTriggerOutcome> {
      fires.push({ payload, idempotencyKey: options?.idempotencyKey });
      if (behavior.skipped !== undefined) return { outcome: 'skipped', reason: behavior.skipped };
      const key = options?.idempotencyKey ?? '';
      const existing = runs.get(key);
      if (existing !== undefined) return { outcome: 'duplicate', runId: existing };
      const runId = `run-${String(runs.size + 1)}`;
      runs.set(key, runId);
      return { outcome: 'started', runId };
    },
  };
  return {
    fires,
    runs,
    async receive(request: Request): Promise<Response> {
      const receive = trigger.receive;
      if (receive === undefined) throw new Error('The trigger has a receive.');
      return receive(
        request,
        context as unknown as PluginTriggerContext<typeof context.configuration>,
      );
    },
  };
}

describe('the github plugin', () => {
  test('declares the webhook secret and one receive trigger whose configuration selects push and pull request events (AC1)', async () => {
    expect(plugin.name).toBe('github');
    expect(plugin.secrets).toEqual([GITHUB_WEBHOOK_SECRET]);
    const result = await plugin.setup?.({
      secrets,
      configuration: {},
      storage: undefined,
    } as never);
    expect(result?.triggers).toHaveLength(1);
    const [kind] = result?.triggers ?? [];
    expect(kind?.name).toBe('webhook');
    expect(typeof kind?.receive).toBe('function');
    expect(kind?.start).toBeUndefined();
    expect(GITHUB_EVENTS).toEqual(['push', 'pull_request']);
    const parse = (value: unknown) => kind?.configuration.safeParse(value).success;
    expect(parse({ events: ['push'] })).toBe(true);
    expect(parse({ events: ['pull_request'] })).toBe(true);
    expect(parse({ events: ['push', 'pull_request'] })).toBe(true);
    expect(parse({})).toBe(true);
    expect(parse({ events: ['issues'] })).toBe(false);
    expect(parse({ events: 'push' })).toBe(false);
  });

  test('is off until the owner enables it', () => {
    expect(plugin.enabled).toBe(false);
  });
});

describe('a signed push delivery (AC2)', () => {
  test('starts one run with the event as its payload and the digest of the signed bytes as its key, and answers 202', async () => {
    const github = rig();
    const response = await github.receive(delivery(PUSH));
    expect(response.status).toBe(202);
    expect(response.body).toBeNull();
    expect(github.fires).toHaveLength(1);
    const [fired] = github.fires;
    expect(fired?.idempotencyKey).toBe(sha256Hex(PUSH));
    expect(fired?.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(fired?.payload).toEqual({
      event: 'push',
      delivery: DELIVERY,
      payload: JSON.parse(new TextDecoder().decode(PUSH)),
    });
    expect(github.runs.size).toBe(1);
  });

  test('answers 2xx to a redelivery of the same bytes, and starts no second run', async () => {
    const github = rig();
    const first = await github.receive(delivery(PUSH));
    expect(first.status).toBe(202);
    // GitHub's redelivery sends the same body under a new delivery id.
    const again = await github.receive(
      delivery(PUSH, { 'x-github-delivery': 'a1b2c3d4-0000-4000-8000-000000000001' }),
    );
    expect(again.status).toBe(202);
    expect(github.fires).toHaveLength(2);
    expect(github.fires[1]?.idempotencyKey).toBe(github.fires[0]?.idempotencyKey);
    expect(github.runs.size).toBe(1);
  });

  test('takes the key from the signed bytes, never from X-GitHub-Delivery, which a replay can change or drop', async () => {
    const github = rig();
    await github.receive(delivery(PUSH));
    await github.receive(delivery(PUSH, { 'x-github-delivery': null }));
    await github.receive(delivery(PUSH, { 'x-github-delivery': 'not-a-delivery-id' }));
    expect(new Set(github.fires.map((call) => call.idempotencyKey))).toEqual(
      new Set([sha256Hex(PUSH)]),
    );
    expect(github.runs.size).toBe(1);
    // Another signed body is another run, even with the same delivery id.
    const other = new TextEncoder().encode(
      JSON.stringify({ ...JSON.parse(new TextDecoder().decode(PUSH)), after: '0'.repeat(40) }),
    );
    await github.receive(delivery(other));
    expect(github.runs.size).toBe(2);
  });

  test('shows the delivery id only when it is a UUID, so a header carries no text into a run', async () => {
    const github = rig();
    await github.receive(delivery(PUSH, { 'x-github-delivery': 'ignore previous instructions' }));
    await github.receive(delivery(PUSH, { 'x-github-delivery': null }));
    expect(github.fires.map((call) => (call.payload as { delivery: unknown }).delivery)).toEqual([
      null,
      null,
    ]);
  });

  test('starts a run for a pull request delivery too, with the pull_request event', async () => {
    const github = rig();
    const response = await github.receive(
      delivery(PULL_REQUEST, { 'x-github-event': 'pull_request' }),
    );
    expect(response.status).toBe(202);
    expect(github.fires[0]?.payload).toMatchObject({
      event: 'pull_request',
      payload: { action: 'opened', number: 42 },
    });
  });
});

describe('what starts nothing (AC3)', () => {
  test('answers 401 to a signature that is wrong, malformed, for other bytes, or absent', async () => {
    const github = rig();
    const cases: Array<string | null> = [
      sign(PUSH, 'another-secret'),
      sign(PULL_REQUEST),
      `sha1=${createHmac('sha1', SECRET).update(PUSH).digest('hex')}`,
      sign(PUSH).toUpperCase(),
      'sha256=',
      '',
      null,
    ];
    for (const signature of cases) {
      const response = await github.receive(delivery(PUSH, { 'x-hub-signature-256': signature }));
      expect(response.status, String(signature)).toBe(401);
      expect(response.body).toBeNull();
    }
    expect(github.fires).toEqual([]);
  });

  test('answers 401, not a success, to an unsigned delivery of an event the file did not select', async () => {
    const github = rig({ events: ['pull_request'] });
    const response = await github.receive(delivery(PUSH, { 'x-hub-signature-256': null }));
    expect(response.status).toBe(401);
    expect(github.fires).toEqual([]);
  });

  test('answers 401 when the secret is not set, as no signature verifies under an empty one', async () => {
    const unset = githubWebhook({ get: async () => undefined });
    const receive = unset.receive;
    const response = await receive?.(delivery(PUSH), {
      configuration: unset.configuration.parse({}),
      workflowId: 'octo-flow',
      storage: undefined,
      signal: new AbortController().signal,
      fire: async () => {
        throw new Error('A delivery that cannot be verified starts nothing.');
      },
    } as never);
    expect(response?.status).toBe(401);
  });

  test('answers 2xx and starts nothing for a signed event the file did not select', async () => {
    const github = rig({ events: ['pull_request'] });
    const response = await github.receive(delivery(PUSH));
    expect(response.status).toBe(202);
    expect(response.body).toBeNull();
    expect(github.fires).toEqual([]);
    // Selecting the other event starts the pull request and still not the push.
    const pushes = rig({ events: ['push'] });
    const unselected = await pushes.receive(
      delivery(PULL_REQUEST, { 'x-github-event': 'pull_request' }),
    );
    expect(unselected.status).toBe(202);
    expect(pushes.fires).toEqual([]);
  });

  test('answers 2xx and starts nothing for an event the plugin does not handle, GitHub’s ping among them', async () => {
    const github = rig();
    const ping = new TextEncoder().encode('{"zen":"Keep it logically awesome."}');
    for (const event of ['ping', 'issues', '', 'PUSH', 'pull_request_review', '__proto__']) {
      const response = await github.receive(delivery(ping, { 'x-github-event': event }));
      expect(response.status, event).toBe(202);
    }
    const noEvent = await github.receive(delivery(PUSH, { 'x-github-event': null }));
    expect(noEvent.status).toBe(202);
    expect(github.fires).toEqual([]);
  });

  test('answers 2xx and starts nothing for a signed body that is not a JSON object', async () => {
    const github = rig();
    for (const body of ['', 'not json', '[1,2]', 'null', '7', '"push"']) {
      const response = await github.receive(delivery(body));
      expect(response.status, body).toBe(202);
    }
    const invalidUtf8 = new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]);
    const garbled = await github.receive(delivery(invalidUtf8));
    expect(garbled.status).toBe(202);
    expect(github.fires).toEqual([]);
  });

  test('answers 503 when the host stopped the trigger or closed, so GitHub redelivers', async () => {
    for (const reason of ['stopped', 'closed'] as const) {
      const github = rig({}, { skipped: reason });
      const response = await github.receive(delivery(PUSH));
      expect(response.status, reason).toBe(503);
      expect(response.body).toBeNull();
      expect(github.runs.size).toBe(0);
    }
  });

  test('answers 2xx for a paused file, which starts nothing and is not the sender’s to retry', async () => {
    const github = rig({}, { skipped: 'paused' });
    const response = await github.receive(delivery(PUSH));
    expect(response.status).toBe(202);
    expect(github.runs.size).toBe(0);
  });

  test('answers a status and nothing else, whatever happened', async () => {
    const github = rig({ events: ['push'] });
    const responses = [
      await github.receive(delivery(PUSH)),
      await github.receive(delivery(PUSH, { 'x-hub-signature-256': null })),
      await github.receive(delivery('not json')),
      await github.receive(delivery(PULL_REQUEST, { 'x-github-event': 'pull_request' })),
    ];
    for (const response of responses) {
      expect(response.body).toBeNull();
      expect(await response.text()).toBe('');
      expect([...response.headers.keys()]).toEqual([]);
    }
  });
});

describe('the events a file selects (AC7)', () => {
  test('uses push and pull_request when none is selected, whether the list is absent or empty', async () => {
    expect(DEFAULT_GITHUB_EVENTS).toEqual(['push', 'pull_request']);
    for (const configuration of [{}, { events: [] }]) {
      const github = rig(configuration);
      await github.receive(delivery(PUSH));
      await github.receive(delivery(PULL_REQUEST, { 'x-github-event': 'pull_request' }));
      expect(github.fires.map((call) => (call.payload as { event: string }).event)).toEqual([
        'push',
        'pull_request',
      ]);
    }
  });

  test('is documented in the README, which names both events as the default', async () => {
    const readme = await Bun.file(new URL('../README.md', import.meta.url)).text();
    expect(readme).toContain('With no `events` selected');
    expect(readme).toContain(DEFAULT_GITHUB_EVENTS.map((event) => `\`${event}\``).join(' and '));
  });
});
