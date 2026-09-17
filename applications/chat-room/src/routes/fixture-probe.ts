/**
 * Read-only (and one write-only) probes against the streaming fixture's own
 * bookkeeping, shared by every spec that needs to reason about what reached
 * the upstream stand-in rather than what reached the browser.
 *
 * These live outside the spec files because two suites now ask the same
 * questions of the same server, and a second private copy of
 * `fetch('/__fixture/requests')` is a place for the two to drift apart while
 * both stay green.
 *
 * @module
 */

import { FIXTURE_ORIGIN } from './streaming-fixture';

/**
 * Fetch a probe endpoint and fail with the status rather than with whatever
 * `json()` makes of an error page. A 404 from a renamed route used to surface
 * as a JSON parse error, which sends the reader looking at the wrong thing.
 */
function probeRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected fixture probe to return a JSON object.');
  }
  return Object.fromEntries(Object.entries(value));
}

async function probe(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const url = `${FIXTURE_ORIGIN}${path}`;
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Fixture probe ${url} responded ${response.status} ${response.statusText}`);
  }
  return probeRecord(await response.json());
}

/**
 * How many times the fixture has been asked to generate for `marker`.
 *
 * This is the provider-call counter. One turn that ends in a tool call is one
 * request; a run that takes an extra generate step after that tool call is
 * two, which is the difference between parking and looping.
 */
export async function fixtureRequestCount(marker: string): Promise<number> {
  const { count } = await probe(`/__fixture/requests?marker=${encodeURIComponent(marker)}`);
  if (typeof count !== 'number') throw new Error('Fixture request count was not a number.');
  return count;
}

/** Whether the fixture still holds an open response parked on `marker`'s gate. */
export async function fixtureGateHeld(marker: string): Promise<boolean> {
  const { held } = await probe(`/__fixture/held?marker=${encodeURIComponent(marker)}`);
  if (typeof held !== 'boolean') throw new Error('Fixture held state was not a boolean.');
  return held;
}

/**
 * Release a parked response.
 *
 * Resolves `true` only when a response was actually parked at the moment of
 * the call, which is what lets a spec assert ordering rather than sleep.
 */
export async function releaseFixtureGate(marker: string): Promise<boolean> {
  const { released } = await probe(`/__fixture/release?marker=${encodeURIComponent(marker)}`, {
    method: 'POST',
  });
  if (typeof released !== 'boolean') throw new Error('Fixture release state was not a boolean.');
  return released;
}

/** A fresh marker, so concurrent specs never share the fixture's counters. */
export function newFixtureMarker(): string {
  return crypto.randomUUID();
}
