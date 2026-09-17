import { gotoHydrated } from '../exercises/hydration';
import {
  fixtureGateHeld,
  fixtureRequestCount,
  newFixtureMarker,
  releaseFixtureGate,
} from '../fixture-probe';
import { STEPPED_CHUNKS, fixtureMarker } from '../streaming-fixture';
import { readCreatedConversation } from './server-owned-test-helpers';

export {
  STEPPED_CHUNKS,
  fixtureGateHeld,
  fixtureMarker,
  fixtureRequestCount,
  gotoHydrated,
  newFixtureMarker,
  readCreatedConversation,
  releaseFixtureGate,
};

export function defined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} was not produced.`);
  return value;
}

/** A title no other test will collide with, in this run or a previous one. */
export const uniqueTitle = (label: string): string =>
  `${label} ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
