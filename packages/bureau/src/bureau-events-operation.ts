import { authorizeWorkspaceOperation } from './http/workspace-authorization.ts';

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
import { isPublishedEventKind } from './bureau-event-catalog.ts';
import type { BureauPlugins } from './plugins/plugin-types.ts';

/** Matches the bound Weft and Operative apply, for the same reason. */
const MAX_BUREAU_SUBSCRIPTION_REPLAY_EVENTS = 1_000;

/**
 * A kind Bureau publishes, or one a plugin declares (COR-2224). A plugin's kind is `plugin:name`
 * and which ones exist depends on the plugins a Bureau loaded, so the schema admits the shape and
 * `invoke` checks the name against what the bureau's plugins declare.
 */
const bureauEventKindSchema = z.union([
  z.enum(PUBLISHED_BUREAU_EVENT_KINDS),
  z
    .string()
    .max(256)
    .regex(/^[^:\s]+:\S+$/),
]);

const bureauEventsSubscriptionInput = z.object({
  bureauId: z.string().min(1).describe('The identifier of the Bureau whose events to follow.'),
  kinds: z
    .union([bureauEventKindSchema, z.array(bureauEventKindSchema).min(1)])
    .optional()
    .describe(
      'One event kind, or several: a kind Bureau publishes, or a `plugin:name` kind a loaded plugin declares. Omitting it delivers every published kind.',
    ),
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

const bureauEventsSubscriptionEnvelope = z.object({
  subscriptionId: z.string(),
  cursor: z.string(),
});

/**
 * Ordinary event payloads remain records because their named-field projections
 * already bound what crosses the wire. The gap variant names its required
 * recovery fields in generated schemas, as Weft's fleet gap does.
 */
const publishedBureauEventEnvelopeSchema = z.object({
  sequence: z.number(),
  cursor: z.string(),
  bureauId: z.string(),
  // Reserve the gap discriminator for the structured branch below, while
  // retaining every ordinary event kind accepted by the previous schema.
  kind: z.string().regex(/^(?!feed\.gap$)/),
  emittedAtMs: z.number(),
  payload: z.record(z.string(), z.unknown()),
  source: z
    .string()
    .optional()
    .describe(
      'The plugin whose contribution emitted the event. Absent for an event from Bureau core. Not a payload field.',
    ),
});

const bureauEventGapEnvelopeSchema = z.object({
  sequence: z.number(),
  cursor: z.string(),
  bureauId: z.string(),
  kind: z.literal('feed.gap'),
  emittedAtMs: z.number(),
  payload: z.object({
    requestedCursor: z.string(),
    firstRetainedSequence: z.number(),
  }),
});

/** Published bureau event or structured recovery gap, shared across transports. */
export const bureauEventEnvelopeSchema: z.ZodType<BureauEventEnvelope> = z.union([
  publishedBureauEventEnvelopeSchema,
  bureauEventGapEnvelopeSchema,
]);

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
  /**
   * The plugins whose declared event kinds a `kinds` filter may name (COR-2224). A host without it
   * serves the kinds Bureau itself publishes.
   */
  readonly plugins?: Pick<BureauPlugins, 'events'>;
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
    authorize: authorizeWorkspaceOperation('bureau.events'),
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
        if (
          input.fromCursor !== undefined &&
          bureauFeed.feed.decodeCursor(input.fromCursor) === 'invalid'
        ) {
          const invalid: OperationFault = {
            code: 'InvalidParams',
            message: 'Invalid cursor',
            data: { issues: [{ path: ['fromCursor'], message: 'Invalid cursor', code: 'custom' }] },
          };
          throw invalid;
        }

        // A kind outside the catalog is refused, as an unknown one always was: a plugin's kind is
        // known only while the plugin that declares it is loaded.
        const requestedKinds =
          input.kinds === undefined ? [] : Array.isArray(input.kinds) ? input.kinds : [input.kinds];
        const declaredKinds = host.plugins?.events().map((declared) => declared.kind) ?? [];
        const unknownKinds = requestedKinds.filter(
          (kind) => !isPublishedEventKind(kind, declaredKinds),
        );
        if (unknownKinds.length > 0) {
          const unknown: OperationFault = {
            code: 'InvalidParams',
            message: `Unknown event kind: ${unknownKinds.join(', ')}`,
            data: {
              issues: unknownKinds.map((kind) => ({
                path: ['kinds'],
                message: `Unknown event kind "${kind}"`,
                code: 'custom',
              })),
            },
          };
          throw unknown;
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
          // The feed filters before counting, so the cap measures matching
          // events; the gap marker is recovery metadata and is not counted.
          countReplayEnvelope: (envelope) => envelope.kind !== 'feed.gap',
          filterEnvelope: (envelope) =>
            envelope.kind === 'feed.gap' || kinds === undefined || kinds.has(envelope.kind),
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
