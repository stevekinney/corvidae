import type { HookRegistry } from '@corvidae/lifecycle';

import {
  HookPlanFailedEvent,
  HookPlanInvokedEvent,
  HookPlanRegisteredEvent,
  HookPlanRemovedEvent,
} from './events';
import type { OperativeHookMap } from './hooks';
import type { EventDispatcher } from './run-step';

/**
 * Dispatches this run's hook-plan events for as long as the returned
 * unsubscribe has not been called (COR-766).
 *
 * The plan present when the run starts is censused immediately, one
 * `hook-plan.registered` per entry, before anything is invoked. The census is
 * necessary rather than redundant: a registry is populated by whoever composed
 * it, which for a bureau run is complete before the run ever sees it, so an
 * observer attached at dispatch would otherwise report invocations of entries
 * it never announced. `HookRegistry.observe` deliberately does not replay past
 * registrations for exactly this reason — replaying inside the registry would
 * make "attached late" indistinguishable from "registered late" for every
 * subscriber, so the one subscriber that wants a census asks for one here.
 *
 * Everything after that is forwarded live, so a registration or unregistration
 * made while the run is in flight is reported in the order it happened
 * relative to the invocations around it.
 */
export function observeHookPlan(
  hooks: HookRegistry<OperativeHookMap> | undefined,
  emitter: EventDispatcher | undefined,
  runId: string | undefined,
): () => void {
  if (!hooks || !emitter) return () => {};

  for (const hookName of hooks.getHookNames()) {
    for (const entry of hooks.getHandlers(hookName)) {
      emitter.dispatch(
        new HookPlanRegisteredEvent(
          hookName,
          entry.id,
          entry.priority,
          // Unset means the conservative `effectful` — the classification in
          // force, not the absence of a declaration. Matches what the registry
          // reports for a live registration.
          entry.options.replay ?? 'effectful',
          runId,
        ),
      );
    }
  }

  return hooks.observe((observation) => {
    switch (observation.kind) {
      case 'registered':
        emitter.dispatch(
          new HookPlanRegisteredEvent(
            observation.hookName,
            observation.id,
            observation.priority,
            observation.replay,
            runId,
          ),
        );
        return;
      case 'removed':
        emitter.dispatch(new HookPlanRemovedEvent(observation.hookName, observation.id, runId));
        return;
      case 'invoked':
        emitter.dispatch(
          new HookPlanInvokedEvent(
            observation.hookName,
            observation.id,
            observation.durationMilliseconds,
            runId,
          ),
        );
        return;
      case 'failed':
        emitter.dispatch(
          new HookPlanFailedEvent(
            observation.hookName,
            observation.id,
            observation.durationMilliseconds,
            observation.error,
            runId,
          ),
        );
        return;
    }
  });
}
