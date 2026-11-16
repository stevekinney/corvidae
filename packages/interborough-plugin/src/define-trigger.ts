import type { z } from 'zod';

import type { PluginTrigger } from './contributions.ts';

/**
 * Declares a trigger kind. It returns the entry unchanged, typed so `start` sees the configuration
 * the entry's `configuration` schema parses to: `context.configuration.seconds` is a `number` for
 * `z.object({ seconds: z.number() })`, with no second parse inside `start`. Each entry keeps its
 * own schema, as each `definePlugin` call keeps its own, so a plugin's kinds need not share one.
 */
export function defineTrigger<TSchema extends z.ZodType>(
  trigger: PluginTrigger<TSchema>,
): PluginTrigger<TSchema> {
  return trigger;
}
