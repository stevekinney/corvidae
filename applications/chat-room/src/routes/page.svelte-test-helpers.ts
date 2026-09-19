import { appendUserMessage, createConversationHistory } from '@corvidae/conversationalist';
import type { Page } from '@playwright/test';
import {
  fixtureGateHeld,
  fixtureRequestCount,
  newFixtureMarker,
  releaseFixtureGate,
} from './fixture-probe';
import {
  APPROVAL_FOLLOW_UP_TEXT,
  APPROVAL_NOTE_TEXT,
  FIXTURE_ORIGIN,
  GATED_FIRST_CHUNK,
  GATED_SECOND_CHUNK,
  HOLD_PARTIAL_TEXT,
  STEPPED_CHUNKS,
  TOOL_ARGUMENTS_FIRST_HALF,
  TOOL_CALL_NAME,
  TOOL_FOLLOW_UP_TEXT,
  fixtureMarker,
} from './streaming-fixture';

export {
  APPROVAL_FOLLOW_UP_TEXT,
  APPROVAL_NOTE_TEXT,
  FIXTURE_ORIGIN,
  GATED_FIRST_CHUNK,
  GATED_SECOND_CHUNK,
  HOLD_PARTIAL_TEXT,
  STEPPED_CHUNKS,
  TOOL_ARGUMENTS_FIRST_HALF,
  TOOL_CALL_NAME,
  TOOL_FOLLOW_UP_TEXT,
  appendUserMessage,
  createConversationHistory,
  fixtureGateHeld,
  fixtureMarker,
  fixtureRequestCount,
  newFixtureMarker,
  releaseFixtureGate,
};

/** Navigate and wait until the root layout has finished hydrating. */
export async function gotoHydrated(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.locator('body[data-hydrated="true"]').waitFor();
}

/**
 * How long the in-page reader waits for the first `stream:tool-call-delta`
 * before failing with what it did see. Diagnostic only: the frame arrives in
 * milliseconds when the route works, and the fixture holds the response open
 * until the test releases it, so this deadline is never the thing under test.
 */
export const WIRE_SNAPSHOT_DEADLINE_MS = 15_000;
