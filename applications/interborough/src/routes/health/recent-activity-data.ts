/**
 * Reads what Recent activity needs: the newest pages of the audit trail (and how long the whole
 * trail is), the chats and schedules those records name, and which runs wait on a person, then
 * words them (`recent-activity.ts`). The trail is mostly engine step noise, so it reads up to
 * {@link MAXIMUM_PAGES} pages, newest first, until the lines it can make from them fill the
 * section; it never reads the whole trail for lines. The total is asked for once, on the first page.
 */
import type { AttentionItem } from '../../lib/bureau-attention.ts';
import type { AuditRecord } from '../../lib/bureau-audit.ts';
import { queryAudit } from '../../lib/bureau-audit.ts';
import { getContext } from '../../lib/bureau-client.ts';
import { listBureauSchedules } from '../../lib/bureau-schedules.ts';
import type { WaitKind } from './health-overview-data.ts';
import {
  ACTIVITY_LINE_LIMIT,
  activityLines,
  lookupsFor,
  type ActivityLine,
} from './recent-activity.ts';

/** The most pages of the trail one read looks through for lines. */
export const MAXIMUM_PAGES = 3;

/** How many records one page holds. */
const PAGE_SIZE = 100;

/** What the section shows. */
export interface RecentActivity {
  readonly lines: readonly ActivityLine[];
  /** How many events the trail holds, for the link to it. */
  readonly total: number | undefined;
}

/** What {@link loadRecentActivity} reads and who it asks. */
export interface ActivityRead {
  readonly attention: readonly AttentionItem[];
  readonly waitingRuns: ReadonlyMap<string, WaitKind>;
  readonly now: number;
  readonly signal?: AbortSignal;
  /** The trail's pages; a test hands its own. */
  readonly queryAudit?: typeof queryAudit;
  readonly getContext?: typeof getContext;
  readonly listSchedules?: typeof listBureauSchedules;
}

/** Reads and words Recent activity. */
export async function loadRecentActivity(read: ActivityRead): Promise<RecentActivity> {
  const query = read.queryAudit ?? queryAudit;
  const records: AuditRecord[] = [];
  let total: number | undefined;
  let cursor: string | undefined;
  const empty = { chatTitles: new Map(), scheduleNames: new Map() };
  for (let page = 0; page < MAXIMUM_PAGES; page += 1) {
    const answer = await query({}, cursor, {
      limit: PAGE_SIZE,
      order: 'newest',
      ...(page === 0 ? { includeTotal: true } : {}),
      ...(read.signal === undefined ? {} : { signal: read.signal }),
    });
    records.push(...answer.records);
    if (page === 0) total = answer.total;
    cursor = answer.nextCursor ?? undefined;
    if (cursor === undefined) break;
    const made = activityLines({
      records,
      attention: read.attention,
      waitingRuns: read.waitingRuns,
      now: read.now,
      ...empty,
    });
    if (made.length >= ACTIVITY_LINE_LIMIT) break;
  }

  const { sessionIds, scheduleIds } = lookupsFor(records);
  const chat = read.getContext ?? getContext;
  const chatTitles = new Map<string, string | null>();
  await Promise.all(
    sessionIds.map(async (sessionId) => {
      try {
        const context = await chat(
          sessionId,
          read.signal === undefined ? {} : { signal: read.signal },
        );
        chatTitles.set(sessionId, context.title);
      } catch {
        // A chat that was deleted since has no title; its lines name the run by its agent.
        chatTitles.set(sessionId, null);
      }
    }),
  );
  const scheduleNames = new Map<string, string>();
  if (scheduleIds.length > 0) {
    try {
      const schedules = await (read.listSchedules ?? listBureauSchedules)(
        read.signal === undefined ? {} : { signal: read.signal },
      );
      for (const schedule of schedules) {
        if (schedule.description !== null) scheduleNames.set(schedule.id, schedule.description);
      }
    } catch {
      // Without names, a line says "a schedule".
    }
  }
  return {
    lines: activityLines({
      records,
      attention: read.attention,
      waitingRuns: read.waitingRuns,
      now: read.now,
      chatTitles,
      scheduleNames,
    }),
    total,
  };
}
