/**
 * The notification record and the in-process surface over it (COR-1941): what Bureau tells its
 * owner needs their attention, kept until the owner reads or dismisses it or retention removes it.
 *
 * A notification is built in, never sent anywhere: v1 has no email. It belongs to one owner
 * (`owner` is stored on every record, and every read and write names the owner it acts for), so a
 * principal reaches its own and nothing else's. Three kinds are written by Bureau itself from its
 * published events ({@link BUILT_IN_NOTIFICATION_KINDS}); any other kind is a caller's, written
 * through {@link BureauNotifications.create}.
 *
 * @module notification-types
 */

/**
 * The kinds Bureau writes on its own, each from a published event kind
 * (`PUBLISHED_BUREAU_EVENT_KINDS`):
 *
 * - `run.failed`: a top-level run ended `failed` (from `run.settled`). A run that a parent run, a
 *   goal or an agent tool call started is not top level and notifies nothing; its parent's
 *   outcome does.
 * - `run.budget-exceeded`: a top-level run ended because it exceeded a budget (from `run.settled`;
 *   its finish reason is `budget-exceeded`). It replaces `run.failed` for that run: one
 *   notification per run.
 * - `review.waiting`: a tool approval or a human wait is waiting for the owner (from
 *   `review.requested`). It is dismissed when the review closes (`review.approved`, `denied`,
 *   `rejected`, `expired`, `revoked` or `canceled`), because nothing waits any more.
 */
export const BUILT_IN_NOTIFICATION_KINDS = [
  'run.failed',
  'run.budget-exceeded',
  'review.waiting',
] as const;

/** One of the kinds in {@link BUILT_IN_NOTIFICATION_KINDS}. */
export type BuiltInNotificationKind = (typeof BUILT_IN_NOTIFICATION_KINDS)[number];

/** A kind is lowercase words joined by `.` or `-`, so it is safe to filter by and to match on. */
export const NOTIFICATION_KIND_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/** The most notifications one owner keeps; creating one past it removes the oldest. */
export const NOTIFICATION_LIMIT_PER_OWNER = 1_000;

/** The longest each field of a notification may be, in UTF-16 code units. */
export const NOTIFICATION_FIELD_LIMITS = {
  kind: 64,
  title: 200,
  body: 2_000,
  link: 2_048,
  dedupeKey: 512,
  subject: 512,
} as const;

/** What a notification is about, by identifier. A notification names these; it never holds their content. */
export interface NotificationSubject {
  /** The run (task) the notification is about. */
  readonly runId?: string | undefined;
  /** The chat (context) of that run. */
  readonly contextId?: string | undefined;
  /** The review that is waiting. */
  readonly reviewId?: string | undefined;
  /** What the waiting review asks of the owner. */
  readonly reviewKind?: 'tool-approval' | 'human-wait' | undefined;
  /** The agent the run belongs to. */
  readonly agentName?: string | undefined;
  /** The schedule whose fire the run is. */
  readonly scheduleId?: string | undefined;
}

/** The keys of {@link NotificationSubject}, for the checks that read it field by field. */
export const NOTIFICATION_SUBJECT_KEYS = [
  'runId',
  'contextId',
  'reviewId',
  'reviewKind',
  'agentName',
  'scheduleId',
] as const;

/** What {@link BureauNotifications.create} is given. */
export interface NotificationInput {
  /** The owner the notification is for; it is shown to that owner alone. */
  readonly owner: string;
  /** What sort of notification it is: lowercase words joined by `.` or `-`. */
  readonly kind: string;
  /** The line the owner reads. */
  readonly title: string;
  /** More detail, such as the first line of an error. */
  readonly body?: string | undefined;
  /** Where acting on it leads: an application path starting with a single `/`, or an `http(s)` URL. */
  readonly link?: string | undefined;
  /**
   * Makes the call idempotent per owner: a second `create` with the same key returns the first
   * notification and writes nothing, however long ago the first was written and whether or not it
   * was read or dismissed, until retention removes it.
   */
  readonly dedupeKey?: string | undefined;
  /** What the notification is about. */
  readonly subject?: NotificationSubject | undefined;
}

/** One notification, as its owner sees it. */
export interface BureauNotification {
  /** Its identifier, unique across owners. */
  readonly id: string;
  /** What sort of notification it is; see {@link BUILT_IN_NOTIFICATION_KINDS} for the ones Bureau writes. */
  readonly kind: string;
  /** The line the owner reads. */
  readonly title: string;
  /** More detail, or `null`. */
  readonly body: string | null;
  /** Where acting on it leads, or `null`. */
  readonly link: string | null;
  /** What it is about, or `null`. */
  readonly subject: NotificationSubject | null;
  /** When it was written, as an ISO timestamp. */
  readonly createdAt: string;
  /** When the owner read it, or `null` while it is unread. */
  readonly readAt: string | null;
  /** When it was dismissed, or `null`. A dismissed notification is read. */
  readonly dismissedAt: string | null;
}

/** What {@link BureauNotifications.list} narrows by. */
export interface NotificationListQuery {
  /** The owner whose notifications are listed. */
  readonly owner: string;
  /** Only unread notifications. */
  readonly unread?: boolean | undefined;
  /** Only notifications of this kind. */
  readonly kind?: string | undefined;
  /** Also list dismissed notifications. They are left out by default. */
  readonly includeDismissed?: boolean | undefined;
  /** The most notifications to return, from 1 to 100. Defaults to 50. */
  readonly limit?: number | undefined;
  /** The `nextPageToken` of the previous page. Valid only with the owner and filters it was issued for. */
  readonly pageToken?: string | undefined;
}

/** One page of {@link BureauNotifications.list}, newest first. */
export interface NotificationPage {
  /** The page's notifications, newest first. */
  readonly notifications: readonly BureauNotification[];
  /** Pass it as `pageToken` for the next page; `null` on the last. */
  readonly nextPageToken: string | null;
}

/** Which of an owner's notifications {@link BureauNotifications.markRead} or `dismiss` acts on. */
export interface NotificationSelection {
  /** The owner who acts. A notification of another owner is never touched. */
  readonly owner: string;
  /** These notifications, by id. An unknown id, or one of another owner, is skipped. */
  readonly ids?: readonly string[] | undefined;
  /** Every notification the owner has that the action still changes. Overrides `ids`. */
  readonly all?: boolean | undefined;
}

/** Why a page token was refused: it is not a token, or it was issued for another owner or filter. */
export type NotificationPageTokenFailure = 'malformed' | 'mismatch';

/** Thrown by {@link BureauNotifications.list} for a page token it cannot continue from. */
export class NotificationPageTokenError extends Error {
  /** Why the token was refused. */
  readonly reason: NotificationPageTokenFailure;

  constructor(reason: NotificationPageTokenFailure) {
    super(`The page token is not valid for this request (${reason}); list again without it.`);
    this.name = 'NotificationPageTokenError';
    this.reason = reason;
  }
}

/**
 * Bureau's notifications, in process (`bureau.notifications`). The wire operations
 * `bureau.notifications.list`, `markread` and `dismiss` delegate here with the caller's owner;
 * `create` has no wire operation, so only the host (or a hook action) writes a notification.
 */
export interface BureauNotifications {
  /**
   * Writes a notification for `input.owner`. With a `dedupeKey` it is idempotent: `created` is
   * `false` and `notification` is the existing one when the key was already used. Rejects with a
   * `BAD_REQUEST` error for a field that is empty, too long, or not of the documented shape.
   *
   * A hook that writes a notification must not do so in response to `notification.created`: that
   * event is dispatched for the notification it writes, so the hook would loop. A hook that has
   * to react to one filters on `kind` and carries a `dedupeKey`, so the second write is a no-op.
   */
  create(
    input: NotificationInput,
  ): Promise<{ readonly notification: BureauNotification; readonly created: boolean }>;
  /** Lists the owner's notifications, newest first. */
  list(query: NotificationListQuery): Promise<NotificationPage>;
  /** Marks the selected notifications read. Resolves how many it changed; reading a read one is a no-op. */
  markRead(selection: NotificationSelection): Promise<number>;
  /** Dismisses the selected notifications, which also reads them. Resolves how many it changed. */
  dismiss(selection: NotificationSelection): Promise<number>;
}
