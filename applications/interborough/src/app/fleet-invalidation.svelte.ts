/**
 * Applies the engine's fleet feed to the cache for every page (COR-1722): the shell connects it
 * once, with its one shared source, so the review, worker, schedule, run-detail and update-history
 * queries follow the engine whichever page is open (`applyFleetEventFrame`,
 * `../lib/live-source/cache-integration.ts`).
 *
 * A connection replays the events after its cursor before it is caught up, up to a thousand. Those
 * are not applied one by one, which would ask the same queries again for each of them; they are
 * held back, and the connection catching up asks for everything the feed drives once
 * (`invalidateFleetDrivenQueries`). A frame after that is applied as it arrives.
 */
import type { QueryClient } from '@tanstack/svelte-query';

import {
  applyFleetEventFrame,
  invalidateFleetDrivenQueries,
} from '../lib/live-source/cache-integration.ts';
import type { FleetEventFrame } from '../lib/live-source/fleet-event-source.svelte.ts';

/** The part of `FleetEventSource` this reads: the frames, and whether the current connection's replay has ended. */
export interface FleetInvalidationSource {
  readonly caughtUp: boolean;
  subscribe(onFrame: (frame: FleetEventFrame) => void): () => void;
}

/** Call while a component initializes: the subscription and the catch-up effect belong to it. */
export function connectFleetInvalidation(
  source: FleetInvalidationSource,
  queryClient: QueryClient,
): void {
  let replayHeld = false;

  $effect(() =>
    source.subscribe((frame) => {
      if (!source.caughtUp) {
        replayHeld = true;
        return;
      }
      applyFleetEventFrame(queryClient, frame);
    }),
  );

  $effect(() => {
    if (!source.caughtUp || !replayHeld) return;
    replayHeld = false;
    invalidateFleetDrivenQueries(queryClient);
  });
}
