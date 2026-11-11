import type { Subscription } from '@lostgradient/lifecycle';
import type {
  DurableEventEnvelope,
  DurableEventGap,
  DurableEventOwner,
  DurableEventPage,
} from '@lostgradient/operative';
import type {
  DurableEventHistoryPageOptions,
  DurableEventHistorySubscribeOptions,
} from '../durable-event-history';

/**
 * Reads one page of an owner's durable event history. {@link BureauTasks.events},
 * {@link BureauContexts.events}, and {@link BureauSchedules.events} are this read narrowed to their
 * owner kind.
 */
export type DurableEventHistoryRead = (
  owner: DurableEventOwner,
  options?: DurableEventHistoryPageOptions,
) => Promise<
  | DurableEventPage
  | DurableEventGap
  | EventHistoryUnsupportedOutcome
  | EventHistoryNotFoundOutcome
  | EventHistoryDeletedAggregateOutcome
>;
/**
 * Subscribes to an owner's durable event history: a replay from the cursor, then the live tail.
 * Each namespace's `subscribeEvents` is this subscription narrowed to its owner kind.
 */
export type DurableEventHistorySubscribe = (
  owner: DurableEventOwner,
  listener: (event: DurableEventEnvelope) => void,
  options?: DurableEventHistorySubscribeOptions,
) => Subscription;
/**
 * Returned by an event history read ({@link BureauTasks.events} and its siblings) when the bureau has no
 * persistent storage backend configured.
 */
export interface EventHistoryUnsupportedOutcome {
  readonly outcome: 'unsupported-capability';
  readonly reason: 'no-persistent-storage';
}
/**
 * Returned by an event history read ({@link BureauTasks.events} and its siblings) (AB-313) when `options.principal`
 * is provided and does not match `owner`'s recorded principal — the same
 * not-found-shaped denial `submitSessionInput` (AB-42/AB-194) returns, so an
 * unauthorized caller cannot distinguish "no such run/session" from "exists,
 * not yours."
 */
export interface EventHistoryNotFoundOutcome {
  readonly outcome: 'not-found';
}
/**
 * Returned by an event history read ({@link BureauTasks.events} and its siblings) (AB-313) when `owner`'s live
 * Bureau record is gone (its task expired under `retention.tasks`, or a deleted session) but this store
 * still holds committed durable events for it — distinguishable from both
 * an ordinary empty {@link DurableEventPage} (an id nothing was ever
 * recorded under) and {@link EventHistoryNotFoundOutcome} (no committed
 * events at all). Carries the same page fields as `DurableEventPage` so the
 * already-committed events remain queryable through this one call — AB-87's
 * retention/deletion posture is that deleting the owner record never
 * deletes its history.
 */
export interface EventHistoryDeletedAggregateOutcome extends DurableEventPage {
  readonly outcome: 'deleted-aggregate';
  readonly owner: DurableEventOwner;
}
