/**
 * `classifyFleetEvent` unit tests (plan §13 T1.6, design `Weft New Surfaces.dc.html` §C). Covers
 * the full 31-kind `EVENTS_READ_EVENT_TYPES` to tier mapping (verified against
 * `weft/src/server/runtime/client-visible-events.ts`, v0.11.0).
 */
import { describe, expect, test } from 'bun:test';

import type { FleetEventFrame } from '../lib/live-source/fleet-event-source.svelte.ts';
import { classifyFleetEvent, type FleetEventTier } from './fleet-event-classification.ts';

function frame(kind: string, overrides: Partial<FleetEventFrame> = {}): FleetEventFrame {
  return {
    kind,
    sequence: 1,
    cursor: 'cursor-1',
    emittedAtMs: 1_000,
    payload: {},
    ...overrides,
  };
}

/** Every client-visible fleet event kind (`EVENTS_READ_EVENT_TYPES`, weft v0.11.0) mapped to its expected tier per this module's documented severity principle. */
const EXPECTED_TIERS: Readonly<Record<string, FleetEventTier>> = {
  'alert:fired': 'critical',
  'task:dead-lettered': 'critical',
  'schedule:missed-fire': 'warning',
  'constraint:violated': 'warning',
  'checkpoint:size-warning': 'warning',
  'human-review:requested': 'info',
  'alert:resolved': 'info',
  'worker:connected': 'info',
  'worker:disconnected': 'warning',
  'workflow:started': 'info',
  'workflow:completed': 'info',
  'workflow:failed': 'warning',
  'workflow:cancelled': 'warning',
  'workflow:timed-out': 'warning',
  'workflow:resumed': 'info',
  'workflow:suspended': 'info',
  'workflow:teardown': 'info',
  'activity:started': 'info',
  'activity:completed': 'info',
  'activity:failed': 'warning',
  'activity:async-pending': 'info',
  'signal:received': 'info',
  'signal:waiting': 'info',
  'signal:delivered': 'info',
  'attributes:changed': 'info',
  'update:received': 'info',
  'update:completed': 'info',
  'schedule:fired': 'info',
  'development:warning': 'warning',
  'cleanup:warning': 'warning',
  'storage:size-reported': 'warning',
  'human-review:completed': 'info',
};

describe('classifyFleetEvent', () => {
  test('maps every client-visible fleet event kind to a tier — no gaps', () => {
    for (const [kind, tier] of Object.entries(EXPECTED_TIERS)) {
      const classified = classifyFleetEvent(frame(kind));
      expect(classified).not.toBeNull();
      expect(classified?.tier).toBe(tier);
    }
  });

  test('returns null for an unrecognized kind', () => {
    expect(classifyFleetEvent(frame('not-a-real-kind'))).toBeNull();
  });

  test('embeds a truncated workflow id in the body when workflowId is present', () => {
    const classified = classifyFleetEvent(
      frame('workflow:started', { workflowId: 'wf_1234567890abcdef1234' }),
    );
    expect(classified?.body).toBe('Workflow wf_12345…1234');
    expect(classified?.href).toBe('/runs/wf_1234567890abcdef1234');
  });

  test('encodes URL delimiters in workflow notification links', () => {
    const classified = classifyFleetEvent(
      frame('workflow:started', { workflowId: 'wf/orders?region=west#retry' }),
    );

    expect(classified?.href).toBe('/runs/wf%2Forders%3Fregion%3Dwest%23retry');
  });

  test('falls back to a generic body/href when workflowId is absent', () => {
    const classified = classifyFleetEvent(frame('worker:connected', { payload: {} }));
    expect(classified?.body).toBe('A worker joined the fleet');
    expect(classified?.href).toBe('/workers');
  });

  test('reads a string payload field into the title/body when present', () => {
    const classified = classifyFleetEvent(
      frame('alert:fired', { payload: { name: 'dead-letter-threshold' } }),
    );
    expect(classified?.body).toBe('dead-letter-threshold');
  });

  test('non-workflow kinds route to their owning domain list', () => {
    expect(classifyFleetEvent(frame('schedule:missed-fire'))?.href).toBe('/schedules');
    expect(classifyFleetEvent(frame('human-review:requested'))?.href).toBe('/reviews');
    expect(classifyFleetEvent(frame('storage:size-reported'))?.href).toBe('/storage');
    expect(classifyFleetEvent(frame('development:warning'))?.href).toBe('/system');
  });
});
