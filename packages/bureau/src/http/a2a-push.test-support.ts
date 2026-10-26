/**
 * Fixtures for the A2A push tests (COR-1543): a Bureau whose handler delivers push notifications
 * through Weft's outbox to a loopback receiver, a delivery loop a test starts and stops, and the
 * JSON-RPC helpers the suites share.
 */
import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import { MemoryStorage, Outbox, type Storage } from '@lostgradient/weft';
import {
  createEgressPolicy,
  createHttpDeliveryAdapter,
  createOutboxPushNotificationSender,
  createWeftPushNotificationStore,
  pushNotificationResolvers,
  startPushDelivery,
  type OutboxPushNotificationSender,
} from '@lostgradient/weft/a2a';

import { type OpenedBureau, openBureau } from './management/management-fixtures.test-support.ts';

export const SIGNING_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

// A JSON-RPC body read back from the wire: each test asserts the shape it needs.
export type Json = any;

export type ReceivedRequest = {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Json;
};

/** A loopback webhook receiver that records every request and answers each with 200. */
export class Receiver {
  readonly requests: ReceivedRequest[] = [];
  /** When set, requests are held open until released, as a slow receiver would. */
  held: Array<() => void> | undefined;
  /** The status each next request is answered with; 200 once the script runs out. */
  readonly statuses: number[] = [];
  readonly #server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.#server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        this.requests.push({
          headers: Object.fromEntries(request.headers.entries()),
          body: JSON.parse(await request.text()),
        });
        if (this.held !== undefined) {
          const held = this.held;
          await new Promise<void>((resolve) => held.push(resolve));
        }
        return new Response('ok', { status: this.statuses.shift() ?? 200 });
      },
    });
  }

  get host(): string {
    return `127.0.0.1:${this.#server.port}`;
  }

  url(path = '/hook'): string {
    return `http://${this.host}${path}`;
  }

  /** What each request carried: a status state, or the kind of event. */
  kinds(): string[] {
    return this.requests.map((request) => {
      const body = request.body;
      if (body.statusUpdate !== undefined) return `status:${body.statusUpdate.status.state}`;
      if (body.artifactUpdate !== undefined) return 'artifact';
      if (body.task !== undefined) return `task:${body.task.status?.state ?? 'none'}`;
      return 'other';
    });
  }

  close(): void {
    for (const release of this.held ?? []) release();
    void this.#server.stop(true);
  }
}

export type PushFixture = {
  readonly opened: OpenedBureau;
  readonly receiver: Receiver;
  readonly outbox: Outbox;
  readonly sender: OutboxPushNotificationSender;
  readonly storage: MemoryStorage;
  /** Starts delivering what the outbox holds; stopped by `dispose`. */
  startDelivery(): void;
  stopDelivery(): void;
  dispose(): Promise<void>;
};

/** A Bureau serving the `asker` agent, with push delivery to a loopback receiver. */
export async function openPushBureau(
  generate: GenerateFunction,
  options: {
    durableHistory?: boolean;
    /** The Bureau's own storage, for a test that fails its appends; the push store stays in memory. */
    bureauStorage?: Storage;
    push?: boolean;
    sweepIntervalMs?: number;
  } = {},
): Promise<PushFixture> {
  const storage = new MemoryStorage();
  const receiver = new Receiver();
  const pushStore = createWeftPushNotificationStore({ storage, namespace: 'bureau-push' });
  const adapter = createHttpDeliveryAdapter({
    ...pushNotificationResolvers(pushStore),
    signingSecrets: [SIGNING_SECRET],
    egressPolicy: createEgressPolicy({
      allowInsecureHttp: true,
      allowlist: [receiver.host],
      resolveHost: null,
    }),
  });
  const outbox = new Outbox({ storage, namespace: 'bureau-push', ownerId: 'push', adapter });
  const sender = createOutboxPushNotificationSender({ outbox, pushStore });
  const opened = await openBureau({
    agents: { asker: createAgent({ name: 'asker', generate }) },
    publish: ['asker'],
    durableHistory: options.durableHistory ?? true,
    ...(options.bureauStorage === undefined ? {} : { storage: options.bureauStorage }),
    handlerOptions: {
      publicUrl: 'http://localhost',
      ...(options.push === false
        ? {}
        : {
            pushNotifications: {
              sender,
              outbox,
              ...(options.sweepIntervalMs === undefined
                ? {}
                : { sweepIntervalMs: options.sweepIntervalMs }),
            },
          }),
    },
  });
  let delivery: AbortController | undefined;
  const stopDelivery = () => {
    delivery?.abort();
    delivery = undefined;
  };
  return {
    opened,
    receiver,
    outbox,
    sender,
    storage,
    startDelivery() {
      stopDelivery();
      delivery = new AbortController();
      void startPushDelivery({ outbox, signal: delivery.signal, intervalMs: 10 });
    },
    stopDelivery,
    async dispose() {
      stopDelivery();
      receiver.close();
      await opened.dispose();
      outbox.dispose();
      storage[Symbol.dispose]();
    },
  };
}

let counter = 0;

/** A user message with a fresh identifier. */
export function message(text: string, extra: Json = {}): Json {
  counter += 1;
  return { messageId: `push-${counter}`, role: 'ROLE_USER', parts: [{ text }], ...extra };
}

/** A JSON-RPC request to the `asker` agent as alice. */
export function rpc(method: string, params: Json, agent = 'asker', key = 'alice-key'): Request {
  return new Request(`http://localhost/a2a/${agent}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'A2A-Version': '1.0',
      'X-API-Key': key,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

/** Calls a method and returns the parsed JSON-RPC response. */
export async function call(
  fixture: PushFixture,
  method: string,
  params: Json,
  key = 'alice-key',
): Promise<Json> {
  const response = await fixture.opened.handler(rpc(method, params, 'asker', key));
  return response.json();
}

/** A webhook configuration for the fixture's receiver. */
export function webhook(fixture: PushFixture, extra: Json = {}): Json {
  return {
    url: fixture.receiver.url(),
    token: 'token-1',
    authentication: { scheme: 'Bearer', credentials: 'credential-secret' },
    ...extra,
  };
}

/** Polls `condition` every 10 ms until it holds, or fails after `timeoutMs`. */
export async function eventually(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('The condition did not hold in time.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
