/**
 * Whether the shell's live sources are carrying a view, so the view stops polling it (COR-1722).
 *
 * A view that asks again on a timer does so only while its source is not `live`: when the push
 * channel is down, still connecting, or was never available (a principal without `events:read`),
 * the timer is what keeps the view current, and when it is live the source's events do. The getters
 * below are read inside a query's option getter, so the query re-evaluates its interval when the
 * source's status changes. Call them while a component initializes, because they read context.
 *
 * Without a source in context (a view rendered outside the shell, as the standalone views and most
 * tests are), the answer is "not live", so the view polls as it did before.
 */
import { getContext, hasContext, setContext } from 'svelte';

import type { BureauEventSource } from '../lib/live-source/bureau-event-source.svelte.ts';
import { getFleetEventSource, hasFleetEventSource } from './engine-status.svelte.ts';

const BUREAU_EVENT_SOURCE_CONTEXT_KEY = Symbol('interborough-bureau-event-source');

/** Provides the shell's one Bureau event source to descendant components. */
export function provideBureauEventSource(source: BureauEventSource): void {
  setContext(BUREAU_EVENT_SOURCE_CONTEXT_KEY, source);
}

/** A getter for whether the Bureau's event feed is live now. */
export function useBureauEventsLive(): () => boolean {
  const source = hasContext(BUREAU_EVENT_SOURCE_CONTEXT_KEY)
    ? getContext<BureauEventSource>(BUREAU_EVENT_SOURCE_CONTEXT_KEY)
    : undefined;
  return () => source?.status === 'live';
}

/** A getter for whether the engine's fleet feed is live now. */
export function useFleetEventsLive(): () => boolean {
  const source = hasFleetEventSource() ? getFleetEventSource() : undefined;
  return () => source?.status === 'live';
}
