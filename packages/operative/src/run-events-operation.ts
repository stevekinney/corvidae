/**
 * `operative.runs.events` — an agent run's feed, as a catalog subscription.
 *
 * Declared with Weft's `defineOperation` rather than a bespoke endpoint, so a
 * client subscribing to a run speaks the same JSON-RPC dialect, obeys the same
 * access policy, and appears in the same AsyncAPI document as one subscribing
 * to a workflow. That consistency is the whole reason this package registers
 * into Weft's catalog instead of standing up its own.
 *
 * @module run-events-operation
 */

import {
  createReplayAwareClosableIterable,
  defineOperation,
  type OperationFault,
  type ReplayLiveSubscribeOptions,
} from '@lostgradient/weft';
import { z } from 'zod';

import {
  PUBLISHED_RUN_EVENT_KINDS,
  type AgentRunEventEnvelope,
  type AgentRunEventFeed,
} from './run-event-feed.ts';

/**
 * How many replayed envelopes a subscription will deliver before refusing.
 *
 * A run that has been executing for a while can have produced far more events
 * than a late joiner wants delivered in one burst. Weft's workflow
 * subscription applies the same bound for the same reason; exceeding it is a
 * caller error answered with a more recent cursor, not a truncated stream
 * that silently loses the middle.
 */
const MAX_RUN_SUBSCRIPTION_REPLAY_EVENTS = 1_000;

const runEventKindSchema = z.enum(PUBLISHED_RUN_EVENT_KINDS);

/**
 * `kinds` accepts one name or several, and omitting it delivers everything.
 *
 * A SET rather than a single value, because the alternatives are both bad: a
 * client wanting three of ten kinds either opens three subscriptions and
 * tracks three cursors for what is logically one stream, or takes the whole
 * feed and discards most of it across a socket. The union accepts a bare
 * string too, so narrowing to one kind stays the simple case.
 */
const runEventsSubscriptionInput = z.object({
  runId: z.string().min(1).describe('The identifier of the run whose events to follow.'),
  kinds: z
    .union([runEventKindSchema, z.array(runEventKindSchema).min(1)])
    .optional()
    .describe('One event kind, or several. Omitting it delivers every published kind.'),
  // Bound the input here; invoke checks its structure against the resolved
  // feed before opening a stream, so every transport returns `InvalidParams`.
  fromCursor: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe(
      'The cursor of the last event already seen; the replay continues after it. Omitting it replays from the beginning of what the feed retains. An opaque value taken from an event or the subscription’s envelope.',
    ),
});

const runEventsSubscriptionEnvelope = z.object({
  subscriptionId: z.string(),
  cursor: z.string(),
});

/**
 * The event envelope as the wire carries it.
 *
 * Ordinary event payloads remain records. Named-field projections in
 * `run-event-feed.ts` already bound and redact them; a client does not yet get
 * a static type for every ordinary kind. The gap variant names its required
 * recovery fields in generated schemas, as Weft's fleet gap does.
 */
const publishedRunEventEnvelopeSchema = z.object({
  sequence: z.number(),
  cursor: z.string(),
  runId: z.string(),
  // Reserve the gap discriminator for the structured branch below, while
  // retaining every ordinary event kind accepted by the previous schema.
  kind: z.string().regex(/^(?!run\.gap$)/),
  emittedAtMs: z.number(),
  payload: z.record(z.string(), z.unknown()),
});

const runEventGapEnvelopeSchema = z.object({
  sequence: z.number(),
  cursor: z.string(),
  runId: z.string(),
  kind: z.literal('run.gap'),
  emittedAtMs: z.number(),
  payload: z.object({
    requestedCursor: z.string(),
    firstRetainedSequence: z.number(),
  }),
});

/** Published run event or structured recovery gap, shared across transports. */
export const runEventEnvelopeSchema: z.ZodType<AgentRunEventEnvelope> = z.union([
  publishedRunEventEnvelopeSchema,
  runEventGapEnvelopeSchema,
]);

export type RunEventsSubscriptionInput = z.infer<typeof runEventsSubscriptionInput>;

/** Resolves a run id to its feed. Supplied by whichever host owns run lifetimes. */
export type AgentRunEventRegistry = {
  get(runId: string): AgentRunEventFeed | undefined;
};

/**
 * A registry backed by a plain map, for a host with no opinion of its own.
 *
 * Deliberately not a singleton: a gateway process may serve several tenants,
 * and a module-scoped map would make one tenant's run ids visible to another
 * by guessing.
 */
export function createAgentRunEventRegistry(): AgentRunEventRegistry & {
  set(runId: string, feed: AgentRunEventFeed): void;
  delete(runId: string): void;
  /**
   * The registered run ids, snapshotted.
   *
   * On the mutable half only: the operation needs `get` and nothing else,
   * while a host shutting down needs to reap whatever it still holds. A
   * snapshot rather than a live view, so a caller can dispose as it iterates.
   */
  runIds(): readonly string[];
} {
  const feeds = new Map<string, AgentRunEventFeed>();
  return {
    get: (runId) => feeds.get(runId),
    set: (runId, feed) => {
      feeds.set(runId, feed);
    },
    delete: (runId) => {
      feeds.delete(runId);
    },
    runIds: () => Array.from(feeds.keys()),
  };
}

/** The shape a host passes as the operation's `host` value. */
export type RunEventsOperationHost = { readonly runFeeds: AgentRunEventRegistry };

export const runEventsSubscriptionOperation = defineOperation<
  typeof runEventsSubscriptionInput,
  typeof runEventsSubscriptionEnvelope,
  typeof runEventEnvelopeSchema,
  RunEventsOperationHost
>({
  name: 'operative.runs.events',
  mcpExposable: false,
  kind: 'subscription',
  summary: 'Subscribe to an agent run’s events with replay-from-cursor',
  description:
    'Replays the run’s events from `fromCursor` (or the beginning) and then follows live. Requires `events:read`. The grant is checked when the subscription starts and remains active until unsubscribe, socket close, or feed termination.',
  destructive: false,
  tags: ['Events'],
  inputSchema: runEventsSubscriptionInput,
  outputSchema: runEventsSubscriptionEnvelope,
  producibleFaults: ['InvalidParams', 'NotFound'],
  eventSchema: runEventEnvelopeSchema,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['events:read'] } },
  discoverable: true,
  // WebSocket for a session that holds a socket, and HTTP for a fetch handler
  // that cannot accept one. A run's event feed is long-lived and resumable;
  // over HTTP it streams as Server-Sent Events through
  // `GET /v1/subscriptions/operative.runs.events` and resumes with
  // `Last-Event-ID`. The handler ends a response after its maximum stream
  // duration, so a client reconnects with the last cursor it saw.
  transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host }) => {
    // The subscription session passes `{ runFeeds }` as this operation's
    // host value, the same way Weft's workflow subscription receives
    // `{ feed }`.
    const runFeed = host.runFeeds.get(input.runId);
    if (runFeed === undefined) {
      // An unknown run is a caller error, not a transport failure: the run may
      // have completed and been reaped between listing it and subscribing.
      // A typed fault, which the catalog pipeline passes through intact.
      const notFound: OperationFault = {
        code: 'NotFound',
        message: `Unknown run "${input.runId}"`,
        data: { resource: 'run', identifier: input.runId },
      };
      throw notFound;
    }
    if (
      input.fromCursor !== undefined &&
      runFeed.feed.decodeCursor(input.fromCursor) === 'invalid'
    ) {
      const invalid: OperationFault = {
        code: 'InvalidParams',
        message: 'Invalid cursor',
        data: { issues: [{ path: ['fromCursor'], message: 'Invalid cursor', code: 'custom' }] },
      };
      throw invalid;
    }

    // Only the session's own signal is needed: `createAgentRunEventFeed`
    // binds the feed's lifetime into every subscription it hands out, so
    // reaping the run ends this subscription too.
    const controller = new AbortController();
    // Normalized HERE rather than by a schema `.transform()`, so `invoke`
    // behaves identically whether it is reached through the catalog pipeline
    // or called directly. A transform would make the parsed and declared
    // input types differ, which is the kind of difference that only shows up
    // in whichever of the two paths has no test.
    const kinds =
      input.kinds === undefined
        ? undefined
        : new Set<string>(Array.isArray(input.kinds) ? input.kinds : [input.kinds]);
    const matches = (envelope: AgentRunEventEnvelope): boolean =>
      envelope.kind === 'run.gap' || kinds === undefined || kinds.has(envelope.kind);
    const subscribeOptions: ReplayLiveSubscribeOptions<AgentRunEventEnvelope> = {
      ...(input.fromCursor === undefined ? {} : { fromCursor: input.fromCursor }),
      signal: controller.signal,
      replayLimit: MAX_RUN_SUBSCRIPTION_REPLAY_EVENTS,
      // The feed applies `filterEnvelope` first and only counts what survives
      // it, so the cap measures matching events; the `run.gap` marker is
      // recovery metadata and is not counted.
      countReplayEnvelope: (envelope) => envelope.kind !== 'run.gap',
      filterEnvelope: matches,
    };
    const iterable = createReplayAwareClosableIterable<AgentRunEventEnvelope>(
      (onReplayComplete) => runFeed.feed.subscribe({ ...subscribeOptions, onReplayComplete }),
      { close: () => controller.abort() },
    );

    const subscriptionId = `sub_${crypto.randomUUID()}`;
    return {
      subscriptionId,
      envelope: {
        subscriptionId,
        cursor: input.fromCursor ?? '-1',
      },
      iterable,
      close: () => iterable.close(),
    };
  },
});
