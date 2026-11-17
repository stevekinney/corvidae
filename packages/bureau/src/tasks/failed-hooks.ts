/**
 * The hooks of a run's plan that threw, as the run inspector lists them (COR-2115): one entry for
 * each registration, with how many times it threw and when it last did, read from the audit trail's
 * `hook-plan.failed` records (COR-2097), which store and catalog runs both write.
 *
 * An entry names the registration, the hook point and who registered it, and nothing the record
 * holds beyond them: the error's message, cause and stack stay on the record, for an authorized
 * read of the trail.
 *
 * @module failed-hooks
 */

import type { AuditRecord, AuditTrail } from '../audit-trail.ts';
import type { TaskInspectionFailedHook } from '../bureau-types/tasks.ts';

/** How many records one read of the trail asks for. */
const PAGE = 500;

/** The most pages one run's failures are read from, so a hook that threw on every step of a very long run is counted, not endless. */
const MAXIMUM_PAGES = 20;

/** The most hooks one run reports, newest failure first. */
export const MAXIMUM_FAILED_HOOKS = 100;

/** The longest text a failed hook's identity may have on the wire. */
export const FAILED_HOOK_TEXT_LIMIT = 256;

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, FAILED_HOOK_TEXT_LIMIT)
    : undefined;
}

/**
 * The failed hooks of `runId`, most recent failure first, one entry for each registration. A record
 * that names no registration or no hook point is left out. Empty for a Bureau that keeps no trail.
 */
export async function readFailedHooks(
  trail: Pick<AuditTrail, 'query'> | undefined,
  runId: string,
): Promise<readonly TaskInspectionFailedHook[]> {
  if (trail === undefined) return [];
  const byHook = new Map<
    string,
    {
      hookId: string;
      hookPoint: string;
      source: string | null;
      count: number;
      lastFailedAtMs: number;
    }
  >();
  let after: { readonly timestampMs: number; readonly sequence: number } | undefined;
  for (let page = 0; page < MAXIMUM_PAGES; page += 1) {
    const records: AuditRecord[] = await trail.query({
      runId,
      type: 'hook-plan.failed',
      limit: PAGE,
      ...(after === undefined ? {} : { after }),
    });
    for (const record of records) {
      const detail =
        typeof record.detail === 'object' && record.detail !== null
          ? (record.detail as Readonly<Record<string, unknown>>)
          : {};
      const hookId = textOf(detail['hookId']);
      const hookPoint = textOf(detail['hookName']);
      if (hookId === undefined || hookPoint === undefined) continue;
      const known = byHook.get(hookId);
      const failedAt = record.timestampMs;
      if (known === undefined) {
        byHook.set(hookId, {
          hookId,
          hookPoint,
          source: textOf(detail['source']) ?? null,
          count: 1,
          lastFailedAtMs: failedAt,
        });
      } else {
        known.count += 1;
        if (failedAt >= known.lastFailedAtMs) {
          known.lastFailedAtMs = failedAt;
          known.hookPoint = hookPoint;
          known.source = textOf(detail['source']) ?? known.source;
        }
      }
    }
    const last = records.at(-1);
    if (records.length < PAGE || last === undefined) break;
    after = { timestampMs: last.timestampMs, sequence: last.sequence ?? -1 };
  }
  return [...byHook.values()]
    .toSorted((first, second) => second.lastFailedAtMs - first.lastFailedAtMs)
    .slice(0, MAXIMUM_FAILED_HOOKS)
    .map((entry) => ({
      hookId: entry.hookId,
      hookPoint: entry.hookPoint,
      source: entry.source,
      count: entry.count,
      lastFailedAt: new Date(entry.lastFailedAtMs).toISOString(),
    }));
}
