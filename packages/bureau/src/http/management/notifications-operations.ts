/**
 * `bureau.notifications.*`: the caller's own notifications (COR-1941), through `Bureau.notifications`.
 *
 * A notification belongs to one owner, and every operation acts for the caller's owner alone
 * (`ownerOfPrincipal`): there is no scope that reads or changes another owner's, and none is
 * needed because nothing here acts across owners. A principal that can own nothing (a credential
 * with no subject) has no notifications, so a list answers an empty page and a change changes
 * nothing. `bureau.notifications.create` has no operation: the host writes a notification in
 * process, so no client can address a notification to someone else.
 *
 * @module notifications-operations
 */

import { defineOperation, type OperationFault } from '@lostgradient/weft';
import { z } from 'zod';

import {
  MAXIMUM_NOTIFICATION_PAGE_LIMIT,
  DEFAULT_NOTIFICATION_PAGE_LIMIT,
} from '../../notifications/notification-store.ts';
import {
  type BureauNotifications,
  NOTIFICATION_FIELD_LIMITS,
  NOTIFICATION_KIND_PATTERN,
  NotificationPageTokenError,
} from '../../notifications/notification-types.ts';
import { ownerOfPrincipal } from '../owner-predicate.ts';
import { unaryTransports as transports, unknownKeyPolicy } from './management-schemas.ts';

/** What the notification operations read from the handler's `host`. */
export type BureauNotificationsOperationHost = {
  readonly notifications: Pick<BureauNotifications, 'list' | 'markRead' | 'dismiss'>;
};

const subjectSchema = z.object({
  runId: z.string().optional(),
  contextId: z.string().optional(),
  reviewId: z.string().optional(),
  reviewKind: z.enum(['tool-approval', 'human-wait']).optional(),
  agentName: z.string().optional(),
  scheduleId: z.string().optional(),
});

/** One notification, as its owner sees it. */
export const notificationSchema = z.object({
  id: z.string(),
  /** `run.failed`, `run.budget-exceeded` or `review.waiting` when Bureau wrote it; otherwise the writer's. */
  kind: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  /** An application path starting with one `/`, or an http(s) URL; `null` when it leads nowhere. */
  link: z.string().nullable(),
  /** What it is about, by identifier; `null` when it names nothing. */
  subject: subjectSchema.nullable(),
  createdAt: z.string(),
  /** When it was read, or `null` while it is unread. */
  readAt: z.string().nullable(),
  /** When it was dismissed, or `null`. A dismissed notification is read. */
  dismissedAt: z.string().nullable(),
});

const listInput = z.object({
  unread: z.boolean().optional().describe('`true` lists only the notifications not yet read.'),
  kind: z
    .string()
    .max(NOTIFICATION_FIELD_LIMITS.kind)
    .regex(NOTIFICATION_KIND_PATTERN)
    .optional()
    .describe('Only notifications of this kind, such as `run.failed`.'),
  includeDismissed: z
    .boolean()
    .optional()
    .describe('`true` also lists dismissed notifications, which are left out by default.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAXIMUM_NOTIFICATION_PAGE_LIMIT)
    .optional()
    .describe(
      `The most notifications to return in one page, from 1 to ${MAXIMUM_NOTIFICATION_PAGE_LIMIT}. Defaults to ${DEFAULT_NOTIFICATION_PAGE_LIMIT}; free to change between pages.`,
    ),
  pageToken: z
    .string()
    .min(1)
    .max(1_024)
    .optional()
    .describe(
      'The `nextPageToken` of the previous page, to continue after it. An opaque token, valid only with the filters it was issued for.',
    ),
});

const listOutput = z.object({
  notifications: z.array(notificationSchema),
  /** Pass it as `pageToken` for the next page; `null` on the last. */
  nextPageToken: z.string().nullable(),
});

/** The notifications a change names: some by id, or every one the change still affects. */
const selectionInput = z
  .object({
    ids: z
      .array(z.string().min(1).max(512))
      .min(1)
      .max(100)
      .optional()
      .describe(
        'These notifications, from 1 to 100 identifiers. An unknown identifier is skipped.',
      ),
    all: z
      .literal(true)
      .optional()
      .describe('`true` changes every notification the caller has that is not already changed.'),
  })
  .refine((selection) => (selection.ids === undefined) !== (selection.all === undefined), {
    message: 'Name either `ids` or `all: true`, not both and not neither.',
  });

const changeOutput = z.object({
  /** How many notifications this call changed; one already read (or dismissed) is not counted. */
  updated: z.number().int().nonnegative(),
});

export const notificationsListOperation = defineOperation<
  typeof listInput,
  typeof listOutput,
  BureauNotificationsOperationHost
>({
  name: 'bureau.notifications.list',
  mcpExposable: false,
  summary: 'List the caller’s notifications',
  description:
    'Lists the caller’s own notifications, newest first (by `createdAt`, then identifier). No caller reads another owner’s. Dismissed notifications are left out unless `includeDismissed` is `true`; `unread` keeps only those not yet read and `kind` only one kind. Bureau writes `run.failed` and `run.budget-exceeded` when a top-level run ends, and `review.waiting` while a review waits on the caller (it is dismissed when the review closes); a host may write others. Pages with `limit` (1 to 100, default 50) and `pageToken`; `nextPageToken` is `null` on the last page. A token is opaque and valid only with the owner and filters (`unread`, `kind`, `includeDismissed`) it was issued for; any other token is `InvalidParams`. A notification is kept until retention, or the cap of 1000 per owner, removes it (dismissing hides it and keeps the record), so a page is read at a moment and a later page may omit one that retention removed since.',
  destructive: false,
  tags: ['Notifications'],
  inputSchema: listInput,
  outputSchema: listOutput,
  producibleFaults: ['InvalidParams'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const owner = ownerOfPrincipal(principal);
    // A principal that can own nothing has no notifications.
    if (owner === undefined) return { notifications: [], nextPageToken: null };
    try {
      const page = await host.notifications.list({
        owner,
        ...(input.unread === undefined ? {} : { unread: input.unread }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.includeDismissed === undefined
          ? {}
          : { includeDismissed: input.includeDismissed }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
      });
      return {
        notifications: page.notifications.map((notification) => ({
          ...notification,
          subject: notification.subject === null ? null : { ...notification.subject },
        })),
        nextPageToken: page.nextPageToken,
      };
    } catch (error) {
      if (!(error instanceof NotificationPageTokenError)) throw error;
      throw {
        code: 'InvalidParams',
        message: error.message,
        data: {
          issues: [
            { path: ['pageToken'], message: error.message, code: `page-token-${error.reason}` },
          ],
        },
      } satisfies OperationFault;
    }
  },
});

export const notificationsMarkReadOperation = defineOperation<
  typeof selectionInput,
  typeof changeOutput,
  BureauNotificationsOperationHost
>({
  name: 'bureau.notifications.markread',
  mcpExposable: false,
  summary: 'Mark notifications read',
  description:
    'Marks the caller’s own notifications read, by `ids` or all of them with `all: true`. A notification of another owner, an unknown identifier and one already read are skipped, so a retry is safe and the answer does not say which of the two a skipped identifier was. Answers how many it changed. Dismissed notifications are left as they are.',
  destructive: false,
  tags: ['Notifications'],
  inputSchema: selectionInput,
  outputSchema: changeOutput,
  producibleFaults: ['InvalidParams'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const owner = ownerOfPrincipal(principal);
    if (owner === undefined) return { updated: 0 };
    return {
      updated: await host.notifications.markRead({
        owner,
        ...(input.ids === undefined ? {} : { ids: input.ids }),
        ...(input.all === undefined ? {} : { all: input.all }),
      }),
    };
  },
});

export const notificationsDismissOperation = defineOperation<
  typeof selectionInput,
  typeof changeOutput,
  BureauNotificationsOperationHost
>({
  name: 'bureau.notifications.dismiss',
  mcpExposable: false,
  summary: 'Dismiss notifications',
  description:
    'Dismisses the caller’s own notifications, by `ids` or all of them with `all: true`. A dismissed notification is read, and `bureau.notifications.list` leaves it out unless asked. Dismissing keeps the record until retention removes it, so the event that wrote it cannot write it again. A notification of another owner, an unknown identifier and one already dismissed are skipped, so a retry is safe. Answers how many it changed.',
  destructive: false,
  tags: ['Notifications'],
  inputSchema: selectionInput,
  outputSchema: changeOutput,
  producibleFaults: ['InvalidParams'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const owner = ownerOfPrincipal(principal);
    if (owner === undefined) return { updated: 0 };
    return {
      updated: await host.notifications.dismiss({
        owner,
        ...(input.ids === undefined ? {} : { ids: input.ids }),
        ...(input.all === undefined ? {} : { all: input.all }),
      }),
    };
  },
});

/** Every `bureau.notifications.*` operation, in the order the handler lists them. */
export const bureauNotificationsOperations = [
  notificationsListOperation,
  notificationsMarkReadOperation,
  notificationsDismissOperation,
] as const;
