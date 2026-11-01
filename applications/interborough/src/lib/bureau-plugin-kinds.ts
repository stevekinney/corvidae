/**
 * What running plugins add to workflows and hooks (COR-1893): `bureau.plugins.kinds` (the trigger
 * kinds a workflow file's trigger can name, and the hook action kinds a hook can run, each with its
 * configuration as JSON Schema), parsed at the boundary.
 */
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

const configurationSchema = z.record(z.string(), z.unknown()).nullable();

const triggerKindSchema = z.object({
  plugin: z.string(),
  id: z.string(),
  description: z.string(),
  version: z.string(),
  configuration: configurationSchema,
});

const hookActionKindSchema = z.object({
  plugin: z.string(),
  kind: z.string(),
  description: z.string(),
  version: z.string(),
  configuration: configurationSchema,
});

/** A trigger kind a running plugin contributes. `id` is `plugin:name`, the `kind` of a workflow file's trigger. */
export type ContributedTriggerKind = z.infer<typeof triggerKindSchema>;

/** A hook action kind a running plugin contributes: the `plugin` and `kind` of a `{ type: 'plugin' }` action. */
export type ContributedHookActionKind = z.infer<typeof hookActionKindSchema>;

const kindsSchema = z.object({
  triggerKinds: z.array(triggerKindSchema),
  hookActionKinds: z.array(hookActionKindSchema),
});

/** Everything the running plugins contribute that a file or a hook can name. */
export type ContributedKinds = z.infer<typeof kindsSchema>;

/** The trigger and hook action kinds of the running plugins, each with its configuration schema. */
export async function listContributedKinds(options?: Options): Promise<ContributedKinds> {
  return kindsSchema.parse(await callBureau('bureau.plugins.kinds', {}, options));
}

/** The id a hook action kind is chosen by: `plugin:kind`. A plugin and a kind name hold no `:`. */
export function hookActionKindId(kind: Pick<ContributedHookActionKind, 'plugin' | 'kind'>): string {
  return `${kind.plugin}:${kind.kind}`;
}
