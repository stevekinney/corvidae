/**
 * The retention windows Settings › Data and retention draws (board PageSettingsSections, "Data and
 * retention"): a choice between keeping a record for ever and deleting it after some days, with the
 * days in a field. The Bureau holds a window as `'forever'` or `{ olderThan }` in milliseconds (a key
 * with no `'forever'`, such as `retention.memory`, holds nothing instead), and a person reads it in
 * days, so this is the one place that converts between the two and says which days a window may be.
 */
import { DATA_RETENTION_COPY } from '../../../app/copy.ts';

/** The four windows the page draws as rows, in the order it draws them. */
export const RETENTION_ROW_KEYS = [
  'retention.audit',
  'retention.runs',
  'retention.chats',
  'retention.memory',
] as const;

/** One of the four keys {@link RETENTION_ROW_KEYS} names. */
export type RetentionRowKey = (typeof RETENTION_ROW_KEYS)[number];

/** Whether `key` is one of the rows the page draws with the Keep forever and Delete after choice. */
export function isRetentionRowKey(key: string): key is RetentionRowKey {
  return (RETENTION_ROW_KEYS as readonly string[]).includes(key);
}

/** Milliseconds in a day, the unit a person reads a window in. */
export const RETENTION_DAY_MILLISECONDS = 86_400_000;

/** The fewest days a window may name. */
export const RETENTION_DAYS_MINIMUM = 1;

/** The most days a window may name: ten years. */
export const RETENTION_DAYS_MAXIMUM = 3650;

/** What a retention row's choice is: keep the records, or delete them after the days in the field. */
export type RetentionChoice = 'forever' | 'after';

function olderThanOf(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { olderThan } = value as { olderThan?: unknown };
  return typeof olderThan === 'number' ? olderThan : undefined;
}

/** The choice a stored window stands for: a window with a length is Delete after, anything else Keep forever. */
export function retentionChoiceOf(value: unknown): RetentionChoice {
  return olderThanOf(value) === undefined ? 'forever' : 'after';
}

/** The days a window holds, or `undefined` for one that keeps for ever. */
export function retentionDaysOf(value: unknown): number | undefined {
  const milliseconds = olderThanOf(value);
  return milliseconds === undefined ? undefined : milliseconds / RETENTION_DAY_MILLISECONDS;
}

/** The window that deletes after `days` days. */
export function retentionWindowOfDays(days: number): { readonly olderThan: number } {
  return { olderThan: Math.round(days * RETENTION_DAY_MILLISECONDS) };
}

/**
 * What is wrong with a window a person is about to save, or `undefined` when it can be saved. Keeping
 * for ever always can; a window must be a whole number of days from {@link RETENTION_DAYS_MINIMUM} to
 * {@link RETENTION_DAYS_MAXIMUM}.
 */
export function retentionProblemWith(value: unknown): string | undefined {
  const days = retentionDaysOf(value);
  if (days === undefined) return undefined;
  const valid =
    Number.isInteger(days) && days >= RETENTION_DAYS_MINIMUM && days <= RETENTION_DAYS_MAXIMUM;
  return valid ? undefined : DATA_RETENTION_COPY.retention.daysProblem;
}
