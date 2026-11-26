/**
 * What the goal form makes of the answer a real Bureau gives a refused configuration: the whole
 * recorded answer (`recorded-goal-refusal.test-support.ts`) goes through the client that reads it
 * (the Bureau client, HTTP 400 as the server sends it), and the fault that comes out names the field.
 */
import { HttpClientError } from '@lostgradient/weft/testing';
import { describe, expect, test } from 'bun:test';

import { bureauClient } from '../../lib/bureau-api.ts';
import {
  RECORDED_GOAL_REFUSAL,
  RECORDED_GOAL_REFUSAL_FIELD_MESSAGE,
} from '../../lib/recorded-goal-refusal.test-support.ts';
import { configurationIssuesOf, createFailure } from './goal-form-failure.ts';

/** The fault `bureau.goals.create` throws when the Bureau answers as recorded. */
async function recordedFault(): Promise<unknown> {
  const answered = (): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(RECORDED_GOAL_REFUSAL), {
        status: RECORDED_GOAL_REFUSAL.error.data.httpStatus,
        headers: { 'content-type': 'application/json' },
      }),
    );
  return bureauClient['bureau.goals.create'](
    {} as Parameters<(typeof bureauClient)['bureau.goals.create']>[0],
    { fetch: answered },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('the refusal a real Bureau gives a configuration its schema refuses', () => {
  test('is a fault whose issues name the field inside the configuration, by its path', async () => {
    const fault = await recordedFault();

    expect(fault).toBeInstanceOf(HttpClientError);
    expect(configurationIssuesOf(fault)).toEqual([
      { path: ['phrase'], message: RECORDED_GOAL_REFUSAL_FIELD_MESSAGE },
    ]);
  });

  test('is also said above the buttons, in the Bureau’s words, with what is kept', async () => {
    const failure = createFailure(await recordedFault());

    expect(failure.code).toBe('InvalidParams');
    expect(failure.message).toContain(
      'The configuration for the validator "contains-phrase@1" is refused',
    );
  });
});
