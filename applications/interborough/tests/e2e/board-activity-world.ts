/**
 * The audit trail the Health design draws (`Health`, `PageAuditLog`; rows 76m, 82h and 82i), read
 * in place of the sample world's own for the frames that show it. The sample world's trail is what
 * the host really wrote: every run of every chat, the hook edits, the workflow edits, a server
 * start for each day of the story (79 events, the deleted chat's among them). The boards list a
 * chosen few of them, so a frame that reads the board's rows takes the trail the host answers and
 * keeps only those events. The page that words them, groups them by day and lists them is the
 * real one, and so is every other read.
 *
 * The deleted chat is a real deletion: the seed saves "Scratch test" with its twelve messages and
 * deletes it as the local caller, and the Bureau writes the record, with the title and the message
 * count the chat had, which the log's row shows.
 */
import type { Page } from '@playwright/test';

import { SAMPLE_WORLD_THREADS } from '../../fixtures/sample-world-records.ts';

/** One record of the audit trail, as `bureau.audit.query` answers it. */
export interface AuditAnswerRecord {
  sequence: number;
  timestamp: string;
  type: string;
  resource: string;
  principal: string | null;
  detail: Record<string, unknown> | null;
}

/** How many events the board's link and count name. */
export const BOARD_AUDIT_TOTAL = 1240;

/** An event of the trail by its type and the minute it was written, in UTC. */
const eventOf = (record: Pick<AuditAnswerRecord, 'type' | 'timestamp'>): string =>
  `${record.type}@${record.timestamp.slice(0, 16)}`;

/**
 * The events the Audit log's design lists (row 82h and 82i): today's nine, the corrected memory
 * among them at 10:31 AM as the sample world wrote it (decisions.md), and the one edit to Tool
 * runner on Thu Oct 29 at 11:38 AM.
 */
const AUDIT_EVENTS: ReadonlySet<string> = new Set([
  'provider.disconnected@2026-11-02T16:45',
  'tool.settled@2026-11-02T16:42',
  'run.started@2026-11-02T16:42',
  'tool.settled@2026-11-02T16:33',
  'review.tool-approval.approved@2026-11-02T16:33',
  'memory.corrected@2026-11-02T16:31',
  'tool.settled@2026-11-02T16:30',
  'schedule.missed@2026-11-02T15:00',
  'host.started@2026-11-02T15:00',
  'agent.updated@2026-10-29T16:38',
  'session.deleted@2026-11-01T22:12',
]);

/** The events Recent activity's design draws besides the runs of the three chats it names. */
const ACTIVITY_EVENTS: ReadonlySet<string> = new Set([
  'provider.disconnected@2026-11-02T16:45',
  'schedule.missed@2026-11-02T15:00',
  'host.started@2026-11-02T15:00',
  'schedule.fired@2026-10-29T09:00',
  'session.deleted@2026-11-01T22:12',
]);

/** Answers every read of the audit trail with `choose` applied to the records the host answers. */
async function answerAuditRecords(
  page: Page,
  choose: (records: readonly AuditAnswerRecord[]) => readonly AuditAnswerRecord[],
): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route) => {
    if (!(route.request().postData() ?? '').includes('"bureau.audit.query"')) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as {
      result: { records: AuditAnswerRecord[]; total?: number };
    };
    body.result.records = [...choose(body.result.records)];
    if (body.result.total !== undefined) body.result.total = BOARD_AUDIT_TOTAL;
    await route.fulfill({ response, json: body });
  });
}

/** The records in the order the trail answers them: newest first, the later sequence first on a tie. */
function newestFirst(records: readonly AuditAnswerRecord[]): readonly AuditAnswerRecord[] {
  return records.toSorted(
    (left, right) =>
      right.timestamp.localeCompare(left.timestamp) || right.sequence - left.sequence,
  );
}

/** The Audit log as its design draws it: today's nine rows, yesterday's deleted chat, Tool runner's edit on Oct 29. */
export async function answerAuditAsDesigned(page: Page): Promise<void> {
  await answerAuditRecords(page, (records) =>
    newestFirst(records.filter((record) => AUDIT_EVENTS.has(eventOf(record)))),
  );
}

/**
 * Recent activity as its design draws it: the refund chat's two runs, Say hello, the notice of the
 * missed runs, the server's start, the Anthropic key, Daily summary's run on Oct 29, and the chat
 * deleted yesterday. The sample world's other chats (Look up order 4468, Rename the billing tables,
 * the release notes question) are the sample world's, not this frame's.
 */
export async function answerRecentActivityAsDesigned(page: Page): Promise<void> {
  const chats = new Set<string>([SAMPLE_WORLD_THREADS.refund, SAMPLE_WORLD_THREADS.sayHello]);
  await answerAuditRecords(page, (records) => {
    const runs = new Set(
      records
        .filter(
          (record) =>
            record.type === 'run.started' &&
            typeof record.detail?.['sessionId'] === 'string' &&
            chats.has(record.detail['sessionId']),
        )
        .map((record) => record.resource),
    );
    return newestFirst(
      records.filter((record) => runs.has(record.resource) || ACTIVITY_EVENTS.has(eventOf(record))),
    );
  });
}
