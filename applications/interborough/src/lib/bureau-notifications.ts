/**
 * The browser's view of the caller's own notifications: `bureau.notifications.list`, `.markread`
 * and `.dismiss` (COR-1941), parsed at the boundary. The Bureau writes a notification for a failed
 * run, a run over its budget, and a review waiting; the app reads them here and never writes one.
 */
import { z } from 'zod';

import { callBureau } from './bureau-client.ts';

const subjectSchema = z.object({
  runId: z.string().optional(),
  contextId: z.string().optional(),
  reviewId: z.string().optional(),
  reviewKind: z.enum(['tool-approval', 'human-wait']).optional(),
  agentName: z.string().optional(),
  scheduleId: z.string().optional(),
});

/** One notification, as `bureau.notifications.list` shows it. */
export const bureauNotificationSchema = z.object({
  id: z.string(),
  /** `run.failed`, `run.budget-exceeded` or `review.waiting` when the Bureau wrote it. */
  kind: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  link: z.string().nullable(),
  subject: subjectSchema.nullable(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
  dismissedAt: z.string().nullable(),
});

/** One notification of the caller's. */
export type BureauNotification = z.infer<typeof bureauNotificationSchema>;

const pageSchema = z.object({
  notifications: z.array(bureauNotificationSchema),
  nextPageToken: z.string().nullable(),
});

const changeSchema = z.object({ updated: z.number().int().nonnegative() });

type Options = { readonly signal?: AbortSignal };

/** How many notifications the bell asks for: the Bureau's page size cap. */
export const NOTIFICATION_PAGE_LIMIT = 100;

/** The caller's newest notifications, not dismissed, newest first. */
export async function listBureauNotifications(options?: Options): Promise<BureauNotification[]> {
  const page = pageSchema.parse(
    await callBureau('bureau.notifications.list', { limit: NOTIFICATION_PAGE_LIMIT }, options),
  );
  return page.notifications;
}

/** Marks the given notifications read. Resolves how many it changed. */
export async function markBureauNotificationsRead(
  ids: readonly string[],
  options?: Options,
): Promise<number> {
  if (ids.length === 0) return 0;
  const sent = [...ids].slice(0, 100);
  return changeSchema.parse(
    await callBureau('bureau.notifications.markread', { ids: sent }, options),
  ).updated;
}
