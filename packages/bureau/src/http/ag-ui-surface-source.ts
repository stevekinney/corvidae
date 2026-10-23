/**
 * A2UI surfaces as the second source of an AG-UI stream (COR-837).
 *
 * A run's native events and its interactive surfaces share one durable history, keyed by the task
 * (`{ kind: 'run', id }`): the surface store appends `surface.created`, `surface.updated`,
 * `surface.closed` and `surface.frozen` beside the run's own `run.*` records, so there is one
 * cursor space. This module is the second consumer of it. It projects the surfaces as
 * `ACTIVITY_SNAPSHOT` events (`activityType: 'a2ui-surface'`, `messageId` the surface id,
 * `replace: true`), whole-surface snapshots only: an `updated` record carries changes, and a
 * snapshot is what a reconnecting client needs anyway.
 *
 * Ordering. The AG-UI mount has no resume cursor (the SSE `id:` is output only), so a reconnect is
 * an attach, and the fence is taken at open: the stream reads the run's history, subscribes to it
 * strictly after the highest cursor it held, and then reads the surfaces as they stand. Nothing
 * falls in the gap, and a surface that changed in both the snapshot and the tail is sent once per
 * revision. Surface events are ordered among themselves by revision (the cursor order); against
 * the run's live frames, which are ordered by in-process sequence and carry text deltas with no
 * cursor, they interleave in arrival order through the stream's serial queue.
 *
 * Activation. AG-UI has no extension negotiation, so a client opts in the way A2A's does: the
 * `a2uiClientCapabilities` forwarded prop on a start or resume, or, on any route, the
 * `X-A2A-Extensions` header naming the A2UI extension and/or an `X-A2UI-Client-Capabilities`
 * header carrying the same JSON. A client that does not opt in receives no surface event. The
 * declared catalogs gate each surface: the basic catalog by default, Cinder's only when listed; a
 * surface in a catalog the client did not list is skipped (AG-UI has no text fallback to send).
 *
 * @experimental The envelope in `content` (`surfaceId`, `surfaceRevision`, `liveness`, `messages`)
 * follows the A2UI adapter, which is experimental until A2UI 1.0.
 *
 * @module ag-ui-surface-source
 */

import { type Event, EventType } from '@ag-ui/core';

import {
  A2UI_EXTENSION_URI,
  A2UI_SPECIFICATION_VERSION,
  offeredCatalogIds,
  supportedCatalogIdsOf,
} from '../a2ui/catalogs.ts';
import { a2uiMessagesOf } from '../a2ui/messages.ts';
import {
  INTERACTIVE_SURFACE_EVENT_KINDS,
  type InteractiveSurfaces,
} from '../interactive-surface/store.ts';
import type { InteractiveSurface } from '../interactive-surface/types.ts';
import type { Bureau } from '../types.ts';
import { type EventStamp, stamp } from './ag-ui-vocabulary.ts';

/** The `activityType` of a surface's `ACTIVITY_SNAPSHOT`. */
export const AG_UI_A2UI_ACTIVITY_TYPE = 'a2ui-surface';

/** The forwarded prop (on a start or resume) that opts a client into surface events. */
export const A2UI_CAPABILITIES_FORWARDED_PROP = 'a2uiClientCapabilities';

/** The header that carries the same declaration on any route (an attach has no body). */
export const A2UI_CAPABILITIES_HEADER = 'x-a2ui-client-capabilities';

/** The A2UI alias of A2A's `A2A-Extensions` header; naming the A2UI extension opts in. */
export const A2UI_EXTENSIONS_HEADER = 'x-a2a-extensions';

/**
 * What an opted-in client declared. `supportedCatalogIds` is `undefined` for a client that opted in
 * without listing catalogs, which is offered the basic catalog only.
 */
export type AgUiA2uiDeclaration = {
  readonly supportedCatalogIds: readonly string[] | undefined;
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Whether a request opted into A2UI surface events, and with which catalogs. The forwarded prop
 * wins over the header when both are present.
 */
export function a2uiDeclarationOf(
  headers: Headers,
  forwardedProps?: unknown,
): AgUiA2uiDeclaration | undefined {
  if (typeof forwardedProps === 'object' && forwardedProps !== null) {
    const declared = (forwardedProps as Record<string, unknown>)[A2UI_CAPABILITIES_FORWARDED_PROP];
    if (declared !== undefined && declared !== null) {
      return { supportedCatalogIds: supportedCatalogIdsOf(declared) };
    }
  }
  const capabilities = headers.get(A2UI_CAPABILITIES_HEADER);
  if (capabilities !== null) {
    return { supportedCatalogIds: supportedCatalogIdsOf(parseJson(capabilities)) };
  }
  const extensions = headers.get(A2UI_EXTENSIONS_HEADER) ?? '';
  if (extensions.split(',').some((entry) => entry.trim() === A2UI_EXTENSION_URI)) {
    return { supportedCatalogIds: undefined };
  }
  return undefined;
}

const SURFACE_KINDS: ReadonlySet<string> = new Set([
  INTERACTIVE_SURFACE_EVENT_KINDS.created,
  INTERACTIVE_SURFACE_EVENT_KINDS.updated,
  INTERACTIVE_SURFACE_EVENT_KINDS.closed,
  INTERACTIVE_SURFACE_EVENT_KINDS.frozen,
]);

type HistorySubscription = ReturnType<Bureau['subscribeEventHistory']>;
type HistoryEnvelope = Parameters<Parameters<Bureau['subscribeEventHistory']>[1]>[0];

/** What a stream gives the source. */
export type SurfaceSourceOptions = {
  readonly surfaces: InteractiveSurfaces;
  readonly subscribe: (
    listener: (event: HistoryEnvelope) => void,
    since: string | undefined,
  ) => HistorySubscription;
  readonly taskId: string;
  /** The owner the route authorized; the surfaces are read as this principal. */
  readonly owner: string;
  readonly declaration: AgUiA2uiDeclaration;
  readonly stampContext: EventStamp;
  /** Called when a surface record is appended, so the stream can reconcile in its serial queue. */
  readonly onChange: () => void;
};

/** The second source: surface snapshots, one per revision. */
export type SurfaceSource = {
  /** Subscribes to the task's history strictly after `fence`. */
  readonly start: (fence: string | undefined) => void;
  /**
   * Reads the surfaces and returns a snapshot for each one that changed since the last call: new,
   * at a higher revision, or gone. Calls are serialized, so no revision is sent twice.
   */
  readonly reconcile: () => Promise<Event[]>;
  readonly stop: () => void;
};

function snapshotEvent(
  surface: InteractiveSurface,
  messages: unknown[],
  context: EventStamp,
): Event {
  return stamp(
    {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: surface.surfaceId,
      activityType: AG_UI_A2UI_ACTIVITY_TYPE,
      replace: true,
      content: {
        surfaceId: surface.surfaceId,
        surfaceRevision: surface.revision,
        liveness: surface.liveness,
        messages,
      },
    },
    context,
    // A snapshot is not a record of the history: it carries the cursor of the surface record it
    // shows, which is where the durable tail continues from.
    {
      durable: false,
      ...(surface.eventCursor === null ? {} : { cursor: surface.eventCursor }),
    },
  );
}

/** Builds the source for one stream. */
export function createSurfaceSource(options: SurfaceSourceOptions): SurfaceSource {
  const { surfaces, taskId, owner, declaration, stampContext } = options;
  const offered = offeredCatalogIds(declaration.supportedCatalogIds);
  /** The last revision sent per surface; a surface sent and then torn down is removed. */
  const sent = new Map<string, InteractiveSurface>();
  let subscription: HistorySubscription | undefined;
  let stopped = false;
  let chain: Promise<unknown> = Promise.resolve();

  const read = async (): Promise<Event[]> => {
    const listed = await surfaces.list(taskId, { principal: owner });
    const events: Event[] = [];
    const present = new Set<string>();
    for (const surface of listed) {
      if (surface.kind !== 'a2ui') continue;
      present.add(surface.surfaceId);
      const before = sent.get(surface.surfaceId);
      if (before !== undefined && before.revision >= surface.revision) continue;
      if (surface.representation === null) {
        // Torn down: a client that holds the surface is told to drop it; one that never did learns
        // nothing.
        if (before === undefined) continue;
        events.push(
          snapshotEvent(
            surface,
            [
              {
                version: A2UI_SPECIFICATION_VERSION,
                deleteSurface: { surfaceId: surface.surfaceId },
              },
            ],
            stampContext,
          ),
        );
        sent.set(surface.surfaceId, surface);
        continue;
      }
      if (
        surface.representation.kind !== 'a2ui' ||
        !offered.includes(surface.representation.catalogId)
      ) {
        continue;
      }
      events.push(snapshotEvent(surface, a2uiMessagesOf(surface), stampContext));
      sent.set(surface.surfaceId, surface);
    }
    // A surface that was sent and is no longer listed (its task was removed) is dropped.
    for (const [surfaceId, before] of sent) {
      if (present.has(surfaceId) || before.representation === null) continue;
      events.push(
        snapshotEvent(
          before,
          [{ version: A2UI_SPECIFICATION_VERSION, deleteSurface: { surfaceId } }],
          stampContext,
        ),
      );
      sent.set(surfaceId, { ...before, representation: null });
    }
    return events;
  };

  return {
    start: (fence) => {
      if (stopped || subscription !== undefined) return;
      subscription = options.subscribe((event) => {
        if (!stopped && SURFACE_KINDS.has(event.kind)) options.onChange();
      }, fence);
    },
    reconcile: () => {
      const next = chain.then(() => (stopped ? [] : read()));
      chain = next.catch(() => undefined);
      return next;
    },
    stop: () => {
      stopped = true;
      subscription?.unsubscribe();
      subscription = undefined;
    },
  };
}
