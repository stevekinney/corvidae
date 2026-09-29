/**
 * The deterministic environment a scenario's final action lands in (COR-755,
 * "action success is checked against deterministic environment state"). It
 * accepts exactly one terminal call: `environment_action` with the task's
 * action and a value, or `environment_unknown` for the task's action. Any
 * other call is refused and leaves the state unchanged, so the final state
 * is a pure function of the calls made, and a scorer recomputes it from a
 * run's recorded tool calls without trusting anything the run reported.
 */
import { z } from 'zod';

import type { ExpectedOutcome } from './scenarios';

export const ENVIRONMENT_REVISION = 'memory-lifecycle-environment-1';

/** What the environment holds once a run ends. */
export type EnvironmentState =
  | { readonly kind: 'untouched' }
  | { readonly kind: 'acted'; readonly action: string; readonly value: string }
  | { readonly kind: 'unknown'; readonly action: string };

export const environmentActionInput = z.object({
  action: z.string().describe('The action that completes the task'),
  value: z.string().describe('The value the action needs, exactly as memory states it'),
});

export const environmentUnknownInput = z.object({
  action: z.string().describe('The action that cannot be completed'),
});

/** One call the environment received, by tool name and arguments. */
export interface EnvironmentCall {
  readonly name: string;
  readonly arguments: unknown;
}

/** Why the environment refused a call. */
export type EnvironmentRefusal =
  'unknown-tool' | 'malformed' | 'wrong-action' | 'already-completed';

export type EnvironmentStep =
  | { readonly accepted: true; readonly state: EnvironmentState }
  | {
      readonly accepted: false;
      readonly refusal: EnvironmentRefusal;
      readonly state: EnvironmentState;
    };

/** Applies one call to `state` for a task whose action is `action`. */
export function applyEnvironmentCall(
  state: EnvironmentState,
  action: string,
  call: EnvironmentCall,
): EnvironmentStep {
  const refuse = (refusal: EnvironmentRefusal): EnvironmentStep => ({
    accepted: false,
    refusal,
    state,
  });
  let next: EnvironmentState;
  if (call.name === 'environment_action') {
    const parsed = environmentActionInput.safeParse(call.arguments);
    if (!parsed.success) return refuse('malformed');
    next = { kind: 'acted', action: parsed.data.action, value: parsed.data.value };
  } else if (call.name === 'environment_unknown') {
    const parsed = environmentUnknownInput.safeParse(call.arguments);
    if (!parsed.success) return refuse('malformed');
    next = { kind: 'unknown', action: parsed.data.action };
  } else {
    return refuse('unknown-tool');
  }
  if (next.action !== action) return refuse('wrong-action');
  if (state.kind !== 'untouched') return refuse('already-completed');
  return { accepted: true, state: next };
}

/** The final state and every refusal after `calls`, applied in order to an untouched environment. */
export function replayEnvironment(
  action: string,
  calls: readonly EnvironmentCall[],
): { readonly state: EnvironmentState; readonly refusals: readonly EnvironmentRefusal[] } {
  let state: EnvironmentState = { kind: 'untouched' };
  const refusals: EnvironmentRefusal[] = [];
  for (const call of calls) {
    const step = applyEnvironmentCall(state, action, call);
    if (step.accepted) state = step.state;
    else refusals.push(step.refusal);
  }
  return { state, refusals };
}

/** Whether `state` is the state a correct run leaves. Values compare exactly, after trimming. */
export function meetsExpectation(state: EnvironmentState, expected: ExpectedOutcome): boolean {
  if (expected.kind === 'unknown') return state.kind === 'unknown';
  return state.kind === 'acted' && state.value.trim() === expected.value;
}
