import type { WeftEventMap } from '../../core/events/event-map.ts';

export const TOKEN_EVENT_TYPE = 'stream:token';

/**
 * Classifies every engine event for the fleet feed. Existing published kinds
 * retain their console payloads; only newly published kinds are subject to the
 * identifier/status/count/timestamp wire-safety rule.
 */
export const EVENT_CLASSIFICATIONS = {
  'workflow:definition-registered': 'published',
  'workflow:started': 'published',
  'workflow:completed': 'published',
  'workflow:failed': 'published',
  'workflow:cancelled': 'published',
  'workflow:timed-out': 'published',
  'workflow:resumed': 'published',
  'workflow:suspended': 'published',
  'workflow:recovery-skipped': 'published',
  'workflow:teardown': 'published',
  'activity:started': 'published',
  'activity:completed': 'published',
  'activity:failed': 'published',
  'activity:async-pending': 'published',
  'activity:remote-queued': 'published',
  'activity:remote-cancellation-requested': 'published',
  'task:dead-lettered': 'published',
  'task:result-delivery': 'published',
  'task:attempt-transition': {
    denied:
      'own properties include execution identity and execution requirements metadata, which are not safe fleet-feed fields',
  },
  'signal:received': 'published',
  'signal:waiting': 'published',
  'signal:delivered': 'published',
  'schedule:fired': 'published',
  'human-review:requested': 'published',
  'human-review:completed': 'published',
  'attributes:changed': 'published',
  'schedule:missed-fire': 'published',
  'schedule:attempted': 'published',
  'schedule:skipped': 'published',
  'update:received': 'published',
  'update:completed': 'published',
  'checkpoint:size-warning': 'published',
  'development:warning': 'published',
  'cleanup:warning': 'published',
  'storage:size-reported': 'published',
  'worker:connected': 'published',
  'worker:disconnected': 'published',
  'alert:fired': 'published',
  'alert:resolved': 'published',
  'constraint:violated': 'published',
  'catalog:revision-installed': 'published',
  'catalog:revision-activated': 'published',
  'catalog:activation-rejected': 'published',
  'catalog:revision-draining': 'published',
  'catalog:revision-removed': 'published',
  'workflow-source:load-started': 'published',
  'workflow-source:load-ready': 'published',
  'workflow-source:load-failed': 'published',
  'workflow-source:load-cancelled': 'published',
} as const satisfies Record<keyof WeftEventMap, 'published' | { denied: string }>;

type PublishedEventType = {
  [K in keyof WeftEventMap]: (typeof EVENT_CLASSIFICATIONS)[K] extends 'published' ? K : never;
}[keyof WeftEventMap];

/** The event kinds accepted by fleet feed filters and replay operations. */
export const EVENTS_READ_EVENT_TYPES = Object.entries(EVENT_CLASSIFICATIONS)
  .filter(([, classification]) => classification === 'published')
  .map(([eventType]) => eventType) as unknown as readonly [
  PublishedEventType,
  ...PublishedEventType[],
];

export const CLIENT_VISIBLE_EVENT_TYPES = [...EVENTS_READ_EVENT_TYPES, TOKEN_EVENT_TYPE] as const;
