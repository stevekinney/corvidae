/**
 * How the explorer words what it shows about a key. A group is the first segment of a key
 * (`agent-session:`), which a person who does not know the storage layout has to guess at, so the
 * groups this application writes are named in plain words ("Chat sessions", "Audit log"). A group
 * the table has no word for is shown as its prefix, which is exact and searchable. Two groups never
 * share a word, so the Group select reads without a duplicate.
 *
 * A key's name is shown in full in its pane and shortened in the table, where a UUID (the id of a
 * chat, a run, a hook) is cut to its first eight characters and an ellipsis, as a person says it
 * ("415b1fd8…"). The row's title holds the whole key.
 */
import { formatDateTime } from '@lostgradient/cinder';

import { keyGroup } from './prefix-discovery.ts';

/** The plain words for the groups this application writes, by the group's prefix. */
export const GROUP_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'agent-session:': 'Chat sessions',
  'agent-session-v2:': 'Chat session bodies',
  'agent-session-outbox:': 'Chat outbox',
  'app:': 'App data and memory',
  'attr:': 'Run attributes',
  'audit:': 'Audit log',
  'audit-dedupe:': 'Audit de-duplication',
  'audit-sequence:': 'Audit order',
  'bureau-agent-override-version:': 'Agent overrides',
  'bureau-catalog-run:': 'Runs',
  'bureau-goal:': 'Goals',
  'bureau-hook:': 'Hooks',
  'bureau-hook-delivery:': 'Hook deliveries',
  'bureau-hook-secret:': 'Hook secrets',
  'bureau-notification:': 'Notifications',
  'bureau-process:': 'Host processes',
  'bureau-resolved-review:': 'Resolved reviews',
  'bureau-task:': 'Tasks',
  'bureau-task-context:': 'Task contexts',
  'bureau-workflow-revision:': 'Workflow revisions',
  'bureau-workflow-schedule-hold:': 'Schedule holds',
  'bureau-workflow-snapshot:': 'Workflow snapshots',
  'catalog-active:': 'Active workflow versions',
  'catalog-entry:': 'Workflow versions',
  'command-ledger:': 'Command receipts',
  'durable-run:': 'Run progress',
  'review-decision:': 'Review decisions',
  'schedule:': 'Schedules',
  'schedule-due:': 'Schedules due',
  'schedule-missed:': 'Missed schedule runs',
  'schedule-run-by-schedule:': 'Schedule runs',
  'schedule-run-link:': 'Schedule run links',
  'steering-log:': 'Chat steering',
  'outbox-dedupe:': 'Outbox receipts',
});

/** The word for a group: its plain name when this application names it, else its prefix. */
export function groupName(group: string): string {
  return Object.hasOwn(GROUP_NAMES, group) ? (GROUP_NAMES[group] ?? group) : group;
}

/** The word for the group `key` belongs to, or `none` for a key that is in no group. */
export function keyGroupName(key: string, none: string): string {
  const group = keyGroup(key);
  return group === undefined ? none : groupName(group);
}

/**
 * The prefix the lock line names for a managed key. A family's own prefix can end short of the
 * group's separator (`agent-session` for `agent-session:summary-index`), and the group is what the
 * table and the Group select show, so the lock line names the group when the family's prefix is the
 * start of it, and the family's own prefix otherwise (`settings`, which is no group).
 */
export function lockedPrefix(key: string, managedPrefix: string): string {
  const group = keyGroup(key);
  return group !== undefined && group.startsWith(managedPrefix) ? group : managedPrefix;
}

const UUID = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** `key` with each UUID in it cut to its first eight characters and an ellipsis. */
export function abbreviateKey(key: string): string {
  return key.replace(UUID, '$1…');
}

/** The longest key the pane shows without saying how long it is. */
export const LONG_KEY_CHARACTERS = 100;

/**
 * When a key was last written, as the pane's header says it: "today, 10:44 AM", "yesterday", or the
 * day and time ("Sun Nov 1, 4:12 PM"). `null` (a backend that records no write time) has none.
 */
export function updatedPhrase(
  updatedAt: number | null,
  options: { readonly now?: number; readonly timeZone?: string } = {},
): string | null {
  if (updatedAt === null) return null;
  const absolute = formatDateTime(updatedAt, options);
  if (absolute.startsWith('Today')) return `today${absolute.slice('Today'.length)}`;
  if (absolute.startsWith('Yesterday')) return 'yesterday';
  return absolute;
}
