/**
 * The audit log as a download: JSON Lines, one record per line, newest first. The export reads the
 * whole trail the period and the action match, a page at a time by the cursor the Bureau hands back,
 * not only the pages the table has loaded, so the file is what a search finds and not what happens
 * to be on screen.
 */
import { queryAudit, type AuditFilter, type AuditRecord } from '../../lib/bureau-audit.ts';

/** The most records one request asks for: the Bureau's own ceiling, to read the trail in few requests. */
export const EXPORT_PAGE_SIZE = 100;

/** Every record the filter matches, newest first. */
export async function readAuditExport(
  filter: AuditFilter,
  signal?: AbortSignal,
): Promise<readonly AuditRecord[]> {
  const records: AuditRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await queryAudit(filter, cursor, {
      limit: EXPORT_PAGE_SIZE,
      order: 'newest',
      ...(signal === undefined ? {} : { signal }),
    });
    records.push(...page.records);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return records;
}

/** The records as JSON Lines: each record on its own line, and a final newline when there are any. */
export function toJsonLines(records: readonly AuditRecord[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

/** The file's name: the day it was exported, with no character a file system refuses. */
export function auditExportFilename(now: Date = new Date()): string {
  return `audit-log-${now.toISOString().slice(0, 10)}.jsonl`;
}

/** The media type of a JSON Lines file. */
export const JSON_LINES_TYPE = 'application/x-ndjson';

/** Saves `text` as a file named `filename`: a DOM side effect, kept apart from what the file holds. */
export function downloadText(text: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
