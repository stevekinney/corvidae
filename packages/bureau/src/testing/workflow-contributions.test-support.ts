/**
 * Contributions for the workflow tests (COR-1874): a versioned catalog holding the activity
 * `x:y`, which answers `y@<version>:<input>`, and optionally the trigger kind `x:ticker`, which a
 * test fires by hand. Nothing here loads a plugin.
 */
import type { PluginActivity, PluginTriggerContext } from '@lostgradient/interborough-plugin';
import { z } from 'zod';

import { createVersionedCatalog, type VersionedCatalog } from '../versioned-catalog.ts';

/** What the `x:ticker` trigger kind recorded, and how a test fires it. */
export interface TickerController {
  /**
   * The context of every `start`, in order. Its `fire` is tracked, so the trigger's stop function
   * waits for the fires still in flight, as a webhook server's does for its requests.
   */
  readonly contexts: PluginTriggerContext[];
  /** How many times the kind's stop function finished; each waits for its trigger's fires in flight. */
  stopped: number;
  /** When set, `start` fires this payload before it resolves, as a source that has news at once does. */
  fireOnStart?: unknown;
  /** Fire the most recently started trigger with `payload`. */
  fire(payload: unknown): Promise<void>;
  /**
   * Hold the `start` of every trigger whose `channel` is `channel` until the returned function is
   * called. The apply that is starting it cannot finish meanwhile, so the work queued behind that
   * apply waits.
   */
  hold(channel: string): () => void;
  /** What a trigger on `channel` waits for before its `start` resolves, if it is held. */
  heldUntil(channel: string): Promise<void> | undefined;
  /** Whether a trigger on `channel` has begun to start, held or not. */
  hasStarted(channel: string): boolean;
}

export function createTickerController(): TickerController {
  const holds = new Map<string, Promise<void>>();
  const controller: TickerController = {
    contexts: [],
    stopped: 0,
    fire: (payload) => controller.contexts.at(-1)!.fire(payload),
    hold: (channel) => {
      let release: () => void = () => undefined;
      holds.set(
        channel,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return release;
    },
    heldUntil: (channel) => holds.get(channel),
    hasStarted: (channel) =>
      controller.contexts.some(
        (context) => (context.configuration as { channel?: string }).channel === channel,
      ),
  };
  return controller;
}

export interface ContributionOptions {
  /** The version of the `x:y` activity; none registers no activity. */
  readonly activityVersion?: string | undefined;
  /** Registers the `x:ticker` trigger kind, driven by this controller. */
  readonly ticker?: TickerController | undefined;
  /**
   * The whole `x:y` activity, in place of the one that answers `y@<version>:<input>`. It is still
   * registered at `activityVersion`, which must be given.
   */
  readonly activity?: PluginActivity | undefined;
}

/** The text `x:y` at `version` answers for `input`. */
export function activityAnswer(version: string, input: unknown): string {
  return `y@${version}:${JSON.stringify(input)}`;
}

export function contributionCatalog(options: ContributionOptions): VersionedCatalog {
  const catalog = createVersionedCatalog();
  const { activityVersion, ticker, activity } = options;
  if (activityVersion !== undefined) {
    catalog.register({
      kind: 'activity',
      name: 'x:y',
      version: activityVersion,
      value: activity ?? {
        name: 'y',
        execute: (argument: { input: unknown }) => activityAnswer(activityVersion, argument.input),
      },
      source: { name: 'x', version: activityVersion },
    });
  }
  if (ticker !== undefined) {
    catalog.register({
      kind: 'trigger-kind',
      name: 'x:ticker',
      version: '1',
      value: {
        name: 'ticker',
        description: 'Fires when a test says so.',
        configuration: z.object({ channel: z.string() }).strict(),
        start: async (context: PluginTriggerContext) => {
          const inFlight = new Set<Promise<void>>();
          const tracked: PluginTriggerContext = {
            ...context,
            fire: (payload) => {
              const fired = context.fire(payload);
              inFlight.add(fired);
              const forget = () => inFlight.delete(fired);
              fired.then(forget, forget);
              return fired;
            },
          };
          ticker.contexts.push(tracked);
          await ticker.heldUntil((context.configuration as { channel: string }).channel);
          if (Object.hasOwn(ticker, 'fireOnStart')) await tracked.fire(ticker.fireOnStart);
          // As `Bun.serve`'s `server.stop()` does, stopping waits for the fires still in flight.
          return async () => {
            await Promise.allSettled(inFlight);
            ticker.stopped += 1;
          };
        },
      },
      source: { name: 'x', version: '1' },
    });
  }
  return catalog;
}
