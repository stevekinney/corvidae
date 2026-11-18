/**
 * What running plugins add to workflows and hooks (COR-1893): `bureau.plugins.contributions` (the trigger
 * kinds a workflow file's trigger can name, and the hook action kinds a hook can run, each with its
 * configuration as JSON Schema), through the generated client.
 */
import { bureauClient, type BureauOutput } from './bureau-api.ts';
import type { Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

type Contributions = BureauOutput<'bureau.plugins.contributions'>;

/**
 * A trigger kind a running plugin contributes. `id` is `plugin:name`, the `kind` of a workflow
 * file's trigger. `receives` says whether the kind receives requests (COR-2168): a file whose
 * trigger is one is sent its deliveries at `/triggers/<workflow-id>`, which the workflow page shows
 * with a copy control (COR-2171).
 */
export type ContributedTriggerKind = Contributions['triggers'][number];

/**
 * A hook action kind a running plugin contributes: the `plugin` and `kind` of a `{ type: 'plugin' }`
 * action. `dryRun` says whether `hooks.test` can call the kind's `dryRun`: a hook of a kind without
 * one cannot be tested. `availability` is `needs-setup` while a secret its plugin declared is
 * missing (COR-2181).
 */
export type ContributedHookActionKind = Contributions['reactions'][number];

/**
 * A hook action kind as a Bureau that predates `availability` has it: available. The server's
 * schema always sends the field, so this default belongs to the browser, applied to the typed result.
 */
export function hookActionKindOf(
  kind: Omit<ContributedHookActionKind, 'availability'> & {
    readonly availability?: ContributedHookActionKind['availability'] | undefined;
  },
): ContributedHookActionKind {
  return { ...kind, availability: kind.availability ?? 'available' };
}

/** Everything the running plugins contribute that a file or a hook can name. */
export type ContributedKinds = {
  readonly triggers: readonly ContributedTriggerKind[];
  readonly reactions: readonly ContributedHookActionKind[];
};

/** The trigger and hook action kinds of the running plugins, each with its configuration schema. */
export async function listContributedKinds(options?: Options): Promise<ContributedKinds> {
  const contributions = await bureauClient['bureau.plugins.contributions']({}, options);
  return {
    triggers: contributions.triggers,
    reactions: contributions.reactions.map(hookActionKindOf),
  };
}

/**
 * A model provider a running plugin contributes: its `name` (what the host's providers list calls
 * it), the `plugin` that holds its configuration, and that configuration as JSON Schema (`null`
 * when it could not be written as one).
 */
export type ContributedProvider = Contributions['providers'][number];

/**
 * The model providers of the running plugins, each with its plugin's configuration schema
 * (`bureau.plugins.contributions`), read apart from the trigger and hook kinds so a page that wants
 * only providers does not depend on the rest of the listing.
 */
export async function listContributedProviders(
  options?: Options,
): Promise<readonly ContributedProvider[]> {
  const answer = await bureauClient['bureau.plugins.contributions']({}, options);
  return answer.providers;
}

/** The id a hook action kind is chosen by: `plugin:kind`. A plugin and a kind name hold no `:`. */
export function hookActionKindId(kind: Pick<ContributedHookActionKind, 'plugin' | 'kind'>): string {
  return `${kind.plugin}:${kind.kind}`;
}
