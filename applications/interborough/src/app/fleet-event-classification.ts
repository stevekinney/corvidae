/**
 * How the Engine view's activity feed shows one fleet event: a severity tier, an icon, human copy,
 * and a deep link, for each of the 31 client-visible fleet event kinds
 * (`EVENTS_READ_EVENT_TYPES`, `weft/src/server/runtime/client-visible-events.ts`, v0.11.0). The
 * notification bell does not read these: an engine event is not about the person, so it lives on
 * the activity feed only (`../routes/dashboard/activity-feed-band.svelte`).
 *
 * ## Severity mapping, a documented design decision and not a wire contract
 *
 * The design reference shows example items for exactly 8 of the 31 kinds
 * (`design/Weft New Surfaces.dc.html` §C's `notifCritical`/`notifWarning`/`notifInfo` arrays), not
 * an exhaustive kind to tier table. Those 8 are matched here verbatim; the remaining 23 follow one
 * explicit principle so the mapping isn't arbitrary:
 *
 *   - `critical`: an engine-wide incident with no natural owning surface: a firing alert, a
 *     dead-lettered task.
 *   - `warning`: a notable but scoped bad outcome: a workflow/activity failure, a missed schedule
 *     fire, a constraint violation, a size/health warning, a worker dropping off the fleet.
 *   - `info`: routine lifecycle: started/completed/resumed, signals, updates, attribute changes, a
 *     schedule firing normally, a review completing, a worker reconnecting.
 *
 * `design/Weft Patterns.dc.html`'s alerts-view mock separately colors `constraint:violated` as
 * `danger`, which would make it `critical` here. That mock is a different screen (the
 * session-scoped Alerts view, §9.7) using `Firing`/`Resolved` semantics, not this 3-tier severity;
 * the two are not required to agree, and this module follows the notification-center mock
 * (`notifWarning`) since that is the vocabulary the activity feed borrows.
 */
import type { FleetEventFrame } from '../lib/live-source/fleet-event-source.svelte.ts';
import { FLEET_EVENT_RULES } from './fleet-event-rules.ts';

export type FleetEventTier = 'critical' | 'warning' | 'info';

export interface ClassifiedFleetEvent {
  readonly tier: FleetEventTier;
  readonly icon: string;
  readonly title: string;
  readonly body: string;
  /** Deep link path (router-relative). */
  readonly href: string;
  readonly emittedAtMs: number;
}

/** Classifies one fleet frame, or `null` for a kind this module doesn't track (none today: every `EVENTS_READ_EVENT_TYPES` kind has a rule). */
export function classifyFleetEvent(frame: FleetEventFrame): ClassifiedFleetEvent | null {
  const rule = FLEET_EVENT_RULES[frame.kind];
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
