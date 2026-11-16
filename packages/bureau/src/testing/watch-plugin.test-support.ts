/**
 * A plugin `x` that contributes the trigger kind `x:watch`, for the tests that read what a
 * contributed trigger's listener is doing through a Bureau (COR-2165, COR-2166). Its configuration
 * names an `account`; a start for an account in {@link WatchPlugin.failing} throws, with the
 * plugin's token in the message when the plugin declares one, so a test can check the redaction of
 * the problem that reports it. Nothing here loads a real source.
 */
import {
  defineTrigger,
  definePlugin,
  type PluginTriggerContext,
} from '@lostgradient/interborough-plugin';
import { z } from 'zod';

import type { BureauPluginEntry } from '../plugins/plugin-types.ts';

/** The secret the plugin declares when asked to. */
export const WATCH_TOKEN_KEY = 'x-token';

/** The value a test saves for {@link WATCH_TOKEN_KEY}. */
export const WATCH_TOKEN = 'sk-live-listener-0123456789';

export interface WatchPlugin {
  /** The entry to give a Bureau's `plugins`. */
  readonly entry: BureauPluginEntry;
  /** The context of every start of `x:watch`, in order. */
  readonly contexts: PluginTriggerContext[];
  /** The accounts whose start throws. A test adds one and removes it again. */
  readonly failing: Set<string>;
  /** How many starts each account has begun. */
  readonly startCounts: Map<string, number>;
  /**
   * Hold every start of `account` until the returned function is called: the apply that is
   * starting it cannot finish meanwhile, so the files queued behind it wait.
   */
  hold(account: string): () => void;
}

/**
 * The plugin `x`; with `secret`, it declares {@link WATCH_TOKEN_KEY} and quotes it when it fails;
 * with `receive`, it also contributes `x:hook`, a kind with a `receive` and no `start` (COR-2168).
 */
export function watchPlugin(
  options: { readonly secret?: boolean; readonly receive?: boolean } = {},
): WatchPlugin {
  const contexts: PluginTriggerContext[] = [];
  const failing = new Set<string>();
  const startCounts = new Map<string, number>();
  const holds = new Map<string, Promise<void>>();
  const descriptor = definePlugin({
    name: 'x',
    version: '1.0.0',
    description: 'Watches a source.',
    ...(options.secret === true ? { secrets: [WATCH_TOKEN_KEY] } : {}),
    setup: async ({ secrets }) => {
      const token = options.secret === true ? await secrets.get(WATCH_TOKEN_KEY) : undefined;
      return {
        triggers: [
          defineTrigger({
            name: 'watch',
            description: 'Watches a source.',
            configuration: z.object({ account: z.string().optional() }),
            start: async (context) => {
              contexts.push(context);
              const account = context.configuration.account ?? '';
              startCounts.set(account, (startCounts.get(account) ?? 0) + 1);
              await holds.get(account);
              if (failing.has(account)) {
                throw new Error(`the source refused ${token ?? 'the token'} for "${account}"`);
              }
              return () => undefined;
            },
          }),
          ...(options.receive === true
            ? [
                defineTrigger({
                  name: 'hook',
                  description: 'Receives a delivery.',
                  configuration: z.object({ account: z.string().optional() }),
                  receive: async () => new Response(null, { status: 202 }),
                }),
              ]
            : []),
        ],
      };
    },
  });
  return {
    entry: { descriptor, source: 'package', location: '@example/x' },
    contexts,
    failing,
    startCounts,
    hold: (account) => {
      const held = Promise.withResolvers<void>();
      holds.set(account, held.promise);
      return held.resolve;
    },
  };
}
