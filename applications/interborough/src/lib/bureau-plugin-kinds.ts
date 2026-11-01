/**
 * What running plugins add to workflows and hooks, and events in words (COR-1893):
 * `bureau.plugins.kinds` (the trigger kinds a workflow file's trigger can name, and the hook action
 * kinds a hook can run, each with its configuration as JSON Schema) and `bureau.events.format` (an
 * event as a person reads it: a plugin's sentence for its kind, or the raw kind), parsed at the
 * boundary.
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

const formattedSchema = z.object({
  events: z.array(
    z.object({
      kind: z.string(),
      title: z.string(),
      body: z.string().optional(),
      runId: z.string().optional(),
      source: z.string().optional(),
      formattedBy: z.string().optional(),
    }),
  ),
});

/** An event as a person reads it. */
export type FormattedEvent = z.infer<typeof formattedSchema>['events'][number];

/** The part of an event the Bureau formats: what `bureau.events` delivered. */
export type EventToFormat = {
  /** The event's kind, such as `review.requested`. */
  readonly kind: string;
  /** The event's payload, when the caller holds it; a formatter reads it. */
  readonly payload?: unknown;
  /** The plugin that caused the event, from the envelope's `source`. */
  readonly source?: string;
};

/**
 * Formats events, in order: a plugin's sentence for a kind it claims (`formattedBy` names the
 * formatter), or the raw kind as the `title` for any other.
 */
export async function formatEvents(
  events: readonly EventToFormat[],
  options?: Options,
): Promise<FormattedEvent[]> {
  const answer = formattedSchema.parse(
    await callBureau('bureau.events.format', { events }, options),
  );
  return answer.events;
}
