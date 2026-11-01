/**
 * What the agent editor's model field offers, and why it does not offer the rest.
 *
 * The Bureau's catalog (`bureau.agents.catalog`) lists every row of the deployment's model catalog,
 * unfiltered, each with the abilities it declares. Three things narrow it for a person choosing a
 * model for an agent file:
 *
 * - The model policy (Settings › Model policy). Its `deployment` and `bureau` layers are the
 *   operator's rules, so a provider or model they deny is not offered. The Bureau also refuses a
 *   save that names such a model (`model-policy-denied`) and fails a run step on it, so the field
 *   marks in advance what a save would be refused for. Operative's selector matches a denied
 *   provider by its name and a denied model by the catalog row's own model name (`policy.ts`,
 *   `narrowedByList`), and so does this module. The `users` layer holds one caller's preferences,
 *   not a rule about an agent, and is not read.
 * - The row itself: one turned off in Settings › Models (`availability: 'unavailable'`) or retired
 *   (`lifecycle: 'retired'`, which the Bureau refuses in an agent file) is not offered.
 * - The provider. A provider with no API key has no row in the catalog, so it has no model to
 *   offer; the host knows its name, and the editor lists it, disabled, with where to connect it.
 *
 * A model that is not offered is still listed, disabled, with its reason, so the person sees why
 * it is missing. The model an agent file already names is kept as the selection even when it is
 * not offered, so the person sees what the file holds. A save that keeps a model the policy forbids
 * is refused by the Bureau, and the page shows its reason.
 */
import type { AgentCatalog, CatalogModel } from '../../lib/agent-definitions.ts';
import { policyOf } from '../settings/model-policy-edit.ts';
import { formatContext } from '../settings/models/format-model.ts';

/** Why a model cannot be chosen. */
export type ModelUnavailableReason =
  'provider-denied' | 'model-denied' | 'turned-off' | 'retired' | 'not-in-catalog';

/** One model of the field, written `<provider>/<model>`. */
export type ModelChoice = {
  readonly value: string;
  readonly provider: string;
  readonly model: string;
  /** The catalog row, or `undefined` for a model the file names and the catalog lacks. */
  readonly row: CatalogModel | undefined;
  /** Why the model cannot be chosen, or `undefined` when it can. */
  readonly unavailable: ModelUnavailableReason | undefined;
};

/** The models of one provider, or the provider alone when it is not connected. */
export type ModelGroup = {
  readonly provider: string;
  /** Whether the catalog holds a row of the provider, which it does once the provider has a key. */
  readonly connected: boolean;
  readonly choices: readonly ModelChoice[];
};

/** What the model policy forbids every run: the providers and the models it denies. */
export type ModelRestrictions = {
  readonly deniedProviders: readonly string[];
  readonly deniedModels: readonly string[];
};

/** Nothing forbidden, for a policy the editor could not read. */
export const NO_RESTRICTIONS: ModelRestrictions = { deniedProviders: [], deniedModels: [] };

function namesIn(layer: unknown, field: string): string[] {
  if (typeof layer !== 'object' || layer === null || !Object.hasOwn(layer, field)) return [];
  const value: unknown = Reflect.get(layer, field);
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

/**
 * The denials of a `modelPolicy` setting's `deployment` and `bureau` layers, which bind every file
 * agent: the Bureau refuses a save that names a denied model and fails a run step on one.
 * A value that is not a policy denies nothing.
 */
export function restrictionsOf(policyValue: unknown): ModelRestrictions {
  const policy = policyOf(policyValue);
  const layers = [policy.deployment, policy.bureau];
  return {
    deniedProviders: layers.flatMap((layer) => namesIn(layer, 'deniedProviders')),
    deniedModels: layers.flatMap((layer) => namesIn(layer, 'deniedModels')),
  };
}

/** The option a written model names, written `<provider>/<model>`, or `''` when the catalog lacks it. */
export function canonicalModel(written: string, catalog: AgentCatalog): string {
  const separator = written.indexOf('/');
  if (separator === -1) return '';
  const provider = written.slice(0, separator);
  const name = written.slice(separator + 1);
  const row = catalog.models.find(
    (candidate) =>
      candidate.provider === provider &&
      (candidate.model === name || candidate.aliases.some((entry) => entry.alias === name)),
  );
  return row === undefined ? '' : `${row.provider}/${row.model}`;
}

/** Why `row` cannot be chosen, or `undefined` when it can. The policy is checked first, as the selector does. */
export function unavailableReason(
  row: CatalogModel,
  restrictions: ModelRestrictions,
): ModelUnavailableReason | undefined {
  if (restrictions.deniedProviders.includes(row.provider)) return 'provider-denied';
  if (restrictions.deniedModels.includes(row.model)) return 'model-denied';
  if (row.availability === 'unavailable') return 'turned-off';
  if (row.lifecycle === 'retired') return 'retired';
  return undefined;
}

/**
 * The field's models grouped by provider: the providers the catalog has rows for, in the catalog's
 * order, then the providers the host reports without a key. A model the agent's file names and the
 * catalog lacks (`kept`) joins its provider's group, so it can stay selected.
 *
 * @param catalog What `bureau.agents.catalog` returned.
 * @param hostProviders The providers the host can call, each with whether it has a key, or
 *   `undefined` when the host did not say.
 * @param restrictions What the model policy forbids.
 * @param kept The model an agent file names that the catalog lacks, written `<provider>/<model>`.
 */
export function modelGroups(
  catalog: AgentCatalog,
  hostProviders: readonly { readonly name: string; readonly hasKey: boolean }[] | undefined,
  restrictions: ModelRestrictions,
  kept: string | undefined,
): readonly ModelGroup[] {
  const byProvider = new Map<string, ModelChoice[]>();
  const seen = new Set<string>();
  for (const row of catalog.models) {
    const value = `${row.provider}/${row.model}`;
    if (seen.has(value)) continue;
    seen.add(value);
    const choices = byProvider.get(row.provider) ?? [];
    choices.push({
      value,
      provider: row.provider,
      model: row.model,
      row,
      unavailable: unavailableReason(row, restrictions),
    });
    byProvider.set(row.provider, choices);
  }
  const groups: ModelGroup[] = [...byProvider].map(([provider, choices]) => ({
    provider,
    connected: true,
    choices,
  }));
  const separator = kept === undefined ? -1 : kept.indexOf('/');
  const unconnected = new Map<string, ModelChoice[]>();
  for (const provider of hostProviders ?? []) {
    if (!provider.hasKey && !byProvider.has(provider.name)) unconnected.set(provider.name, []);
  }
  if (kept !== undefined && separator > 0) {
    const provider = kept.slice(0, separator);
    const choice: ModelChoice = {
      value: kept,
      provider,
      model: kept.slice(separator + 1),
      row: undefined,
      unavailable: 'not-in-catalog',
    };
    // The model is gone from the catalog, which says nothing about its provider: a provider with
    // rows, or one the host does not report as keyless, is connected, and the model joins it.
    const group = groups.find((entry) => entry.provider === provider);
    const listed = unconnected.get(provider);
    if (group !== undefined) {
      groups[groups.indexOf(group)] = { ...group, choices: [...group.choices, choice] };
    } else if (listed !== undefined) {
      unconnected.set(provider, [...listed, choice]);
    } else {
      groups.push({ provider, connected: true, choices: [choice] });
    }
  }
  for (const [provider, choices] of unconnected) {
    groups.push({ provider, connected: false, choices });
  }
  return groups;
}

/** The first model of `groups` that can be chosen, or `''`. */
export function firstAvailableModel(groups: readonly ModelGroup[]): string {
  for (const group of groups) {
    const choice = group.choices.find((entry) => entry.unavailable === undefined);
    if (choice !== undefined) return choice.value;
  }
  return '';
}

/** The choice with `value`, or `undefined`. */
export function choiceOf(groups: readonly ModelGroup[], value: string): ModelChoice | undefined {
  for (const group of groups) {
    const choice = group.choices.find((entry) => entry.value === value);
    if (choice !== undefined) return choice;
  }
  return undefined;
}

/** What a model can do, as the field words it. */
export type ModelAbilities = {
  /** The context window in short form: `200K`. */
  readonly context: string;
  /** The largest answer in short form: `64K`. */
  readonly maxOutput: string;
  /** The abilities the model has, as the keys of `AGENT_EDITOR_COPY.model.abilities`. */
  readonly has: readonly ('tools' | 'images' | 'structuredOutput' | 'streaming')[];
};

/** The abilities the catalog declares for `row`. */
export function abilitiesOf(row: CatalogModel): ModelAbilities {
  return {
    context: formatContext(row.contextWindowTokens),
    maxOutput: formatContext(row.maxOutputTokens),
    has: [
      ...(row.tools ? (['tools'] as const) : []),
      ...(row.modalities['image']?.input === true ? (['images'] as const) : []),
      ...(row.structuredOutput ? (['structuredOutput'] as const) : []),
      ...(row.streaming ? (['streaming'] as const) : []),
    ],
  };
}
