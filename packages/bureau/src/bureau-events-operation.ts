/**
 * `bureau.events` — a bureau's feed, as a catalog subscription.
 *
 * The third registration into Weft's catalog, after Weft's own operations and
 * `operative.runs.events`, and the reason the catalog was made shared: one
 * dispatch pipeline, one access policy, one AsyncAPI document, whichever
 * runtime a client is watching.
 *
 * @module bureau-events-operation
 */

import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';
import {
  createReplayAwareClosableIterable,
  decodeCursor,
  defineOperation,
  type OperationFault,
  type ReplayLiveSubscribeOptions,
} from '@lostgradient/weft';
import { z } from 'zod';

import {
  type BureauEventEnvelope,
  type BureauEventFeed,
  PUBLISHED_BUREAU_EVENT_KINDS,
} from './bureau-event-feed.ts';

/** Matches the bound Weft and Operative apply, for the same reason. */
const MAX_BUREAU_SUBSCRIPTION_REPLAY_EVENTS = 1_000;

const bureauEventKindSchema = z.enum(PUBLISHED_BUREAU_EVENT_KINDS);

const bureauEventsSubscriptionInput = z.object({
  bureauId: z.string().min(1),
  /** One kind, or several. Omitting it delivers every published kind. */
  kinds: z.union([bureauEventKindSchema, z.array(bureauEventKindSchema).min(1)]).optional(),
  // Checked here, in the schema, so a malformed cursor is `InvalidParams` over
  // every transport (a WebSocket subscribe, or `Last-Event-ID` on the HTTP
  // route) instead of an error thrown later from inside the feed.
  fromCursor: z
    .string()
    .min(1)
    .refine((cursor) => decodeCursor(cursor) !== null, { message: 'Invalid cursor' })
    .optional(),
});

const bureauEventsSubscriptionEnvelope = z.object({
  subscriptionId: z.string(),
  cursor: z.string(),
});

/**
 * `payload` is a record rather than a union discriminated on `kind`, matching
 * `operative.runs.events` and Weft's own envelopes. The payloads are already
 * bounded by named-field projections; what a client does not yet get is a
 * static type per kind. Closing that is additive and worth doing once across
 * all three packages rather than differently in each.
 */
export const bureauEventEnvelopeSchema = z.object({
  sequence: z.number(),
  cursor: z.string(),
  bureauId: z.string(),
  kind: z.string(),
  emittedAtMs: z.number(),
  payload: z.record(z.string(), z.unknown()),
});

export type BureauEventsSubscriptionInput = z.infer<typeof bureauEventsSubscriptionInput>;

/** Resolves a bureau id to its feed. Supplied by whichever host owns bureau lifetimes. */
export type BureauEventRegistry = {
  get(bureauId: string): BureauEventFeed | undefined;
};

export function createBureauEventRegistry(): BureauEventRegistry & {
  set(bureauId: string, feed: BureauEventFeed): void;
  delete(bureauId: string): void;
} {
  const feeds = new Map<string, BureauEventFeed>();
  return {
    get: (bureauId) => feeds.get(bureauId),
    set: (bureauId, feed) => {
      feeds.set(bureauId, feed);
    },
    delete: (bureauId) => {
      feeds.delete(bureauId);
    },
  };
}

/** The shape a host passes as the operation's `host` value. */
export type BureauEventsOperationHost = {
  readonly bureauFeeds: BureauEventRegistry;
  readonly runtime?: Pick<RuntimeServices, 'identifiers'>;
};

/**
 * The scope that gates the feed. Weft's `events:read` is the general reader of
 * every event feed; `bureau.events:observe-all` is the Bureau operator scope
 * for the fleet-wide feed, which `createBureauHandler` requires instead.
 */
export type BureauEventsAccessScope = 'events:read' | 'bureau.events:observe-all';

/** Define `bureau.events`, gated by `scope`. */
export function defineBureauEventsSubscriptionOperation(scope: BureauEventsAccessScope) {
  return defineOperation<
    typeof bureauEventsSubscriptionInput,
    typeof bureauEventsSubscriptionEnvelope,
    typeof bureauEventEnvelopeSchema,
    BureauEventsOperationHost
  >({
    name: 'bureau.events',
    mcpExposable: false,
    kind: 'subscription',
    summary: 'Subscribe to a bureau’s lifecycle events with replay-from-cursor',
    description: `Replays the bureau’s events from \`fromCursor\` (or the beginning) and then follows live. Covers registration, recovery, disposal, and review lifecycle; supervisor task and synthesis events are not published. Requires \`${scope}\`.`,
    destructive: false,
    tags: ['Events'],
    inputSchema: bureauEventsSubscriptionInput,
    outputSchema: bureauEventsSubscriptionEnvelope,
    producibleFaults: ['InvalidParams', 'NotFound'],
    eventSchema: bureauEventEnvelopeSchema,
    access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: [scope] } },
    discoverable: true,
    // WebSocket for a session that holds a socket, and HTTP for a fetch handler
    // that cannot accept one: `GET /v1/subscriptions/bureau.events` streams the
    // feed as Server-Sent Events and resumes through `Last-Event-ID`.
    transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: ({ input, host }) => {
      try {
        const runtime = host.runtime ?? createDefaultRuntimeServices();
        const bureauFeed = host.bureauFeeds.get(input.bureauId);
        if (bureauFeed === undefined) {
          // An unknown bureau is a caller error: it may have been disposed
          // between listing it and subscribing.
          // A typed fault, which the catalog pipeline passes through intact.
          const notFound: OperationFault = {
            code: 'NotFound',
            message: `Unknown bureau "${input.bureauId}"`,
            data: { resource: 'bureau', identifier: input.bureauId },
          };
          throw notFound;
        }

        // Only the session's own signal: the feed binds its own lifetime into
        // every subscription, so disposing the bureau ends this one too.
        const controller = new AbortController();
        // Normalized here rather than by a schema `.transform()`, so `invoke`
        // behaves identically whether it is reached through the catalog pipeline
        // or called directly.
        const kinds =
          input.kinds === undefined
            ? undefined
            : new Set<string>(Array.isArray(input.kinds) ? input.kinds : [input.kinds]);
        const subscribeOptions: ReplayLiveSubscribeOptions<BureauEventEnvelope> = {
          ...(input.fromCursor === undefined ? {} : { fromCursor: input.fromCursor }),
          signal: controller.signal,
          replayLimit: MAX_BUREAU_SUBSCRIPTION_REPLAY_EVENTS,
          // No `countReplayEnvelope`: the feed filters before counting, so the
          // cap already measures matching events.
          filterEnvelope: (envelope) => kinds === undefined || kinds.has(envelope.kind),
        };
        const iterable = createReplayAwareClosableIterable<BureauEventEnvelope>(
          (onReplayComplete) =>
            bureauFeed.feed.subscribe({ ...subscribeOptions, onReplayComplete }),
          { close: () => controller.abort() },
        );

        const subscriptionId = `sub_${runtime.identifiers.next('bureau-subscription')}`;
        return Promise.resolve({
          subscriptionId,
          envelope: {
            subscriptionId,
            cursor: input.fromCursor ?? '-1',
          },
          iterable,
          close: () => iterable.close(),
        });
      } catch (error) {
        return Promise.resolve().then(() => {
          throw error;
        });
      }
    },
  });
}

export const bureauEventsSubscriptionOperation =
  defineBureauEventsSubscriptionOperation('events:read');
