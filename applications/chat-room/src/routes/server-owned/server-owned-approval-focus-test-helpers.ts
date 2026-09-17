import { expect, type Route } from '@playwright/test';
import { gotoHydrated } from '../exercises/hydration';
import { newFixtureMarker } from '../fixture-probe';
import { fixtureMarker } from '../streaming-fixture';

export { fixtureMarker, gotoHydrated, newFixtureMarker };
export type { Route };

/** A title no other test will collide with, in this run or a previous one. */
export const uniqueTitle = (label: string): string =>
  `${label} ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export type PostOutcome =
  'success' | 'conflict' | 'error' | 'network' | 'completed-success' | 'completed-error';

function postPayloadOf(route: Route): { approved?: unknown; callId?: unknown } {
  const payload = route.request().postDataJSON();
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Expected approval POST payload to be an object.');
  }
  return {
    approved: Reflect.get(payload, 'approved'),
    callId: Reflect.get(payload, 'callId'),
  };
}

export function assertApprovedPost(route: Route, expectedCallId?: string): void {
  const payload = postPayloadOf(route);
  expect(payload.approved).toBe(true);
  if (expectedCallId === undefined) {
    expect(payload.callId).toEqual(expect.any(String));
    expect(payload.callId).not.toBe('');
  } else {
    expect(payload.callId).toBe(expectedCallId);
  }
}
