/**
 * Notification center store (plan `design/Weft New Surfaces.dc.html` §C,
 * `design/README.md` "Notification center", §13 T1.6). Fed by the shell's
 * shared `FleetEventSource` (`src/app/engine-status.svelte.ts` owns opening
 * that connection); this module owns turning each of the 31 client-visible
 * fleet event kinds (`EVENTS_READ_EVENT_TYPES`,
 * `weft/src/server/runtime/client-visible-events.ts`, v0.11.0) into a
 * severity tier, human copy, and a deep link.
 *
 * ## Severity mapping — a documented design decision, not a wire contract
 *
 * The design reference shows example items for exactly 8 of the 31 kinds
 * (`design/Weft New Surfaces.dc.html` §C's `notifCritical`/`notifWarning`/
 * `notifInfo` arrays) — not an exhaustive kind → tier table. Those 8 are
 * matched here verbatim; the remaining 23 follow one explicit principle so
 * the mapping isn't arbitrary:
 *
 *   - `critical` (strip + toast, persists, `role="alert"`) — an engine-wide
 *     incident with no natural owning surface: a firing alert, a
 *     dead-lettered task.
 *   - `warning` (toast, auto-dismiss 6s) — a notable but scoped bad outcome:
 *     a workflow/activity failure, a missed schedule fire, a constraint
 *     violation, a size/health warning, a worker dropping off the fleet.
 *   - `info` (bell only) — routine lifecycle: started/completed/resumed,
 *     signals, updates, attribute changes, a schedule firing normally, a
 *     review completing, a worker reconnecting.
 *
 * `design/Weft Patterns.dc.html`'s alerts-view mock separately colors
 * `constraint:violated` as `danger`, which would make it `critical` here —
 * that mock is a different screen (session-scoped Alerts view, §9.7) using
 * `Firing`/`Resolved` semantics, not the notification center's 3-tier
 * severity; the two are not required to agree, and this module follows the
 * notification-center mock (`notifWarning`) since that is the surface this
 * module feeds.
 */
import type { FleetEventFrame } from '../lib/live-source/fleet-event-source.svelte.ts';
import type { LiveSourceStatus } from '../lib/live-source/index.ts';
import { NAVIGATION_COPY } from './copy.ts';
import { NOTIFICATION_RULES } from './notification-rules.ts';

export type NotificationTier = 'critical' | 'warning' | 'info';

export interface NotificationItem {
  readonly id: string;
  readonly tier: NotificationTier;
  readonly icon: string;
  readonly title: string;
  readonly body: string;
  /** Deep link path (router-relative), per design README: "Every item deep-links." */
  readonly href: string;
  readonly emittedAtMs: number;
  read: boolean;
}

const NOTIFICATION_HISTORY_LIMIT = 50;

/** The one item the host's own problem lives in (`NotificationStore.reportEngineStatus`). */
export const ENGINE_STATUS_ITEM_ID = 'engine-status';

/** What the bell says for each state of the live feed that is a problem; a state with no entry is not one. */
const ENGINE_PROBLEMS: Readonly<
  Partial<Record<LiveSourceStatus, Pick<NotificationItem, 'tier' | 'icon' | 'title' | 'body'>>>
> = {
  closed: {
    tier: 'critical',
    icon: 'plug-zap',
    title: NAVIGATION_COPY.engineStatus.closed,
    body: 'The host did not answer. Check that it is running.',
  },
  stale: {
    tier: 'warning',
    icon: 'triangle-alert',
    title: NAVIGATION_COPY.engineStatus.stale,
    body: 'The engine has not reported in a while. What you see may be out of date.',
  },
};

/** Classifies one fleet frame into a `NotificationItem`, or `null` for a kind this module doesn't track (none today — every `EVENTS_READ_EVENT_TYPES` kind has a rule). */
export function classifyFleetEvent(
  frame: FleetEventFrame,
): Omit<NotificationItem, 'id' | 'read'> | null {
  const rule = NOTIFICATION_RULES[frame.kind];
  if (!rule) return null;
  return {
    tier: rule.tier,
    icon: rule.icon,
    title: rule.title(frame),
    body: rule.body(frame),
    href: rule.href(frame),
    emittedAtMs: frame.emittedAtMs,
  };
}

export class NotificationStore {
  items: NotificationItem[] = $state([]);

  get unreadCount(): number {
    return this.items.filter((item) => !item.read).length;
  }

  get critical(): NotificationItem[] {
    return this.items.filter((item) => item.tier === 'critical');
  }

  /** Unread critical items only — what the dismissible strip below the header shows. A dismissed (read) critical item leaves the strip but stays visible, dimmed, in the bell dropdown. */
  get criticalUnread(): NotificationItem[] {
    return this.items.filter((item) => item.tier === 'critical' && !item.read);
  }

  get warning(): NotificationItem[] {
    return this.items.filter((item) => item.tier === 'warning');
  }

  get info(): NotificationItem[] {
    return this.items.filter((item) => item.tier === 'info');
  }

  /** Appends a classified fleet frame to the top of the list, bounded to `NOTIFICATION_HISTORY_LIMIT`. Returns the new item, or `null` for an unmapped kind. */
  ingest(frame: FleetEventFrame): NotificationItem | null {
    const classified = classifyFleetEvent(frame);
    if (!classified) return null;
    const item: NotificationItem = { id: frame.cursor, read: false, ...classified };
    this.items = [item, ...this.items].slice(0, NOTIFICATION_HISTORY_LIMIT);
    return item;
  }

  /**
   * Keeps the host's own problem in the list: an unreachable or stale engine is one item under a
   * fixed id, so a connection that flaps between states replaces it rather than stacking a new
   * one for each drop, and a recovery removes it. The same state again leaves the item, and
   * whether it has been read, as it was.
   */
  reportEngineStatus(status: LiveSourceStatus, nowMs: number): void {
    const problem = ENGINE_PROBLEMS[status];
    const current = this.items.find((item) => item.id === ENGINE_STATUS_ITEM_ID);
    if (problem === undefined) {
      if (current !== undefined) this.items = this.items.filter((item) => item !== current);
      return;
    }
    if (current?.title === problem.title) return;
    const item: NotificationItem = {
      id: ENGINE_STATUS_ITEM_ID,
      read: false,
      href: '/engine',
      emittedAtMs: nowMs,
      ...problem,
    };
    this.items = [item, ...this.items.filter((existing) => existing.id !== item.id)].slice(
      0,
      NOTIFICATION_HISTORY_LIMIT,
    );
  }

  markAllRead(): void {
    this.items = this.items.map((item) => (item.read ? item : { ...item, read: true }));
  }

  markRead(id: string): void {
    this.items = this.items.map((item) => (item.id === id ? { ...item, read: true } : item));
  }

  /** Dismisses one item from the critical strip without marking it read elsewhere in the dropdown — matches the design's "dismissible" strip while the bell dropdown keeps its own history. */
  dismissCritical(id: string): void {
    this.items = this.items.map((item) =>
      item.id === id && item.tier === 'critical' ? { ...item, read: true } : item,
    );
  }
}
