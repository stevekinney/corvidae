/**
 * The remote calls an A2A caller made, read from the audit trail (COR-2009): each call that started
 * a task is kept as an `a2a.call` record with when it came, who made it (the principal, and the name
 * the caller gave itself) and which agent answered. The trail answers oldest first and takes no
 * order, so the newest are the end of the last page.
 */
import { queryAudit, type AuditRecord } from './bureau-audit.ts';

/** The audit type the Bureau records an A2A call under. */
export const A2A_CALL_TYPE = 'a2a.call';

/** How many calls the page shows. */
export const RECENT_CALL_COUNT = 10;

/** How far back the page looks: calls older than this are not recent. */
export const RECENT_CALL_WINDOW_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

/** The most pages the read walks before it settles for the newest it has seen. */
const MAXIMUM_PAGES = 40;

/** One remote call, as the page shows it. */
export type A2aCall = {
  /** The task the call started, which the record is about. */
  readonly taskId: string;
  /** When the call came, in epoch milliseconds. */
  readonly at: number;
  /** The name the caller gave itself, when it gave one. */
  readonly callerName: string | undefined;
  /** Who made the call: the principal, such as `api-key:planner`. */
  readonly principal: string | undefined;
  /** The catalog name of the agent that answered. */
  readonly agent: string;
};

/** The call an `a2a.call` record describes, or `undefined` for a record that names no agent. */
export function callOf(record: AuditRecord): A2aCall | undefined {
  const agent = record.detail?.['agentName'];
  if (typeof agent !== 'string' || agent === '') return undefined;
  const callerName = record.detail?.['callerName'];
  const at = Date.parse(record.timestamp);
  if (Number.isNaN(at)) return undefined;
  return {
    taskId: record.resource,
    at,
    callerName: typeof callerName === 'string' && callerName !== '' ? callerName : undefined,
    principal: record.principal ?? undefined,
    agent,
  };
}

/** The newest calls inside the window, newest first. */
export async function getRecentCalls(options?: {
  readonly signal?: AbortSignal;
  readonly now?: number;
}): Promise<readonly A2aCall[]> {
  const since = (options?.now ?? Date.now()) - RECENT_CALL_WINDOW_MILLISECONDS;
  let newest: A2aCall[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAXIMUM_PAGES; page += 1) {
    const answer = await queryAudit(
      { type: A2A_CALL_TYPE, since },
      cursor,
      options?.signal === undefined ? {} : { signal: options.signal },
    );
    const calls = answer.records.flatMap((record) => callOf(record) ?? []);
    newest = [...newest, ...calls].slice(-RECENT_CALL_COUNT);
    if (answer.nextCursor === null) break;
    cursor = answer.nextCursor;
  }
  return newest.toReversed();
}
