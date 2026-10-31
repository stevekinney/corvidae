/**
 * Contributions for the workflow tests (COR-1874): a versioned catalog holding the activity
 * `x:y`, which answers `y@<version>:<input>`, and optionally the trigger kind `x:ticker`, which a
 * test fires by hand. Nothing here loads a plugin.
 */
import type { PluginTriggerContext } from '@lostgradient/interborough-plugin';
import { z } from 'zod';

import { createVersionedCatalog, type VersionedCatalog } from '../versioned-catalog.ts';

/** What the `x:ticker` trigger kind recorded, and how a test fires it. */
export interface TickerController {
  /** The context of every `start`, in order. */
  readonly contexts: PluginTriggerContext[];
  /** How many times the kind's stop function ran. */
  stopped: number;
  /** When set, `start` fires this payload before it resolves, as a source that has news at once does. */
  fireOnStart?: unknown;
  /** Fire the most recently started trigger with `payload`. */
  fire(payload: unknown): Promise<void>;
}

export function createTickerController(): TickerController {
  const controller: TickerController = {
    contexts: [],
    stopped: 0,
    fire: (payload) => controller.contexts.at(-1)!.fire(payload),
  };
  return controller;
}

export interface ContributionOptions {
  /** The version of the `x:y` activity; none registers no activity. */
  readonly activityVersion?: string | undefined;
  /** Registers the `x:ticker` trigger kind, driven by this controller. */
  readonly ticker?: TickerController | undefined;
}

/** The text `x:y` at `version` answers for `input`. */
export function activityAnswer(version: string, input: unknown): string {
  return `y@${version}:${JSON.stringify(input)}`;
}

export function contributionCatalog(options: ContributionOptions): VersionedCatalog {
  const catalog = createVersionedCatalog();
  const { activityVersion, ticker } = options;
  if (activityVersion !== undefined) {
    catalog.register({
      kind: 'activity',
      name: 'x:y',
      version: activityVersion,
      value: {
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
          ticker.contexts.push(context);
          if (Object.hasOwn(ticker, 'fireOnStart')) await context.fire(ticker.fireOnStart);
          return () => {
            ticker.stopped += 1;
          };
        },
      },
      source: { name: 'x', version: '1' },
    });
  }
  return catalog;
}
