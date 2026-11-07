/**
 * Edits to the `modelPolicy` setting, a field of one layer at a time. The setting is
 * `{ deployment?, bureau?, users?, policyRevision }`. Settings › Allowed models edits two of the
 * layers: Allowed models is the first, `deployment`, which binds every run; Your preferences is the
 * entry for the one local caller under `users`. The third, `bureau`, is not shown in a
 * single-user installation, and an edit leaves it as it was. `policyRevision` is never typed: a
 * policy that differs from the stored one carries the stored revision plus one, and the stored
 * policy carries its own, so putting every field back is no change.
 */
import { sameValue } from './settings-form.svelte.ts';

/** The `users` entry of the one caller an Interborough host has: its local, uncredentialed principal. */
export const LOCAL_PROFILE = 'anonymous:local';

type Layer = Readonly<Record<string, unknown>>;

/** The model policy as the Bureau stores it. */
export type ModelPolicy = {
  readonly deployment?: Layer;
  readonly bureau?: Layer;
  readonly users?: Readonly<Record<string, Layer>>;
  readonly policyRevision: number;
};

/** The layer an edit changes. */
export type PolicyTarget = 'allowed-models' | 'your-preferences';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The policy a stored value is, or an empty one for a key with no value. */
export function policyOf(value: unknown): ModelPolicy {
  if (!isRecord(value)) return { policyRevision: 0 };
  const revision = value['policyRevision'];
  return { ...value, policyRevision: typeof revision === 'number' ? revision : 0 };
}

function layerOf(policy: ModelPolicy, target: PolicyTarget): Layer {
  if (target === 'allowed-models') return policy.deployment ?? {};
  const entry = policy.users !== undefined && Object.hasOwn(policy.users, LOCAL_PROFILE);
  return entry ? (policy.users?.[LOCAL_PROFILE] ?? {}) : {};
}

/** What a layer holds for a field, or `undefined`. */
export function fieldOf(policy: ModelPolicy, target: PolicyTarget, field: string): unknown {
  return layerOf(policy, target)[field];
}

function isEmpty(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

/**
 * The policy with `field` of the layer set to `value`. An empty list or no value removes the field,
 * and a layer left with no field is removed with it, so an untouched policy stays as small as it was.
 */
export function withField(
  policy: ModelPolicy,
  target: PolicyTarget,
  field: string,
  value: unknown,
): ModelPolicy {
  const { [field]: _previous, ...others } = layerOf(policy, target);
  const layer: Layer = isEmpty(value) ? others : { ...others, [field]: value };
  const empty = Object.keys(layer).length === 0;
  if (target === 'allowed-models') {
    const { deployment: _deployment, ...rest } = policy;
    return empty ? rest : { ...rest, deployment: layer };
  }
  const { [LOCAL_PROFILE]: _entry, ...otherUsers } = policy.users ?? {};
  const users = empty ? otherUsers : { ...otherUsers, [LOCAL_PROFILE]: layer };
  const { users: _users, ...rest } = policy;
  return Object.keys(users).length === 0 ? rest : { ...rest, users };
}

function withoutRevision(policy: ModelPolicy): Omit<ModelPolicy, 'policyRevision'> {
  const { policyRevision: _revision, ...rest } = policy;
  return rest;
}

/** `edited` as it is saved: the stored policy itself when nothing differs, and otherwise one revision on. */
export function committedPolicy(stored: ModelPolicy, edited: ModelPolicy): ModelPolicy {
  return sameValue(withoutRevision(stored), withoutRevision(edited))
    ? stored
    : { ...edited, policyRevision: stored.policyRevision + 1 };
}

/** The models the deployment layer keeps agents from using, by the model name the catalog lists. */
export function deniedModelsOf(policy: ModelPolicy): readonly string[] {
  const denied = fieldOf(policy, 'allowed-models', 'deniedModels');
  return Array.isArray(denied) ? denied.filter((model) => typeof model === 'string') : [];
}

/** The providers the deployment layer keeps agents from using, which this page shows but does not change. */
export function deniedProvidersOf(policy: ModelPolicy): readonly string[] {
  const denied = fieldOf(policy, 'allowed-models', 'deniedProviders');
  return Array.isArray(denied) ? denied.filter((provider) => typeof provider === 'string') : [];
}

/** Whether the policy lets runs use the model: every model is allowed until the policy denies it. */
export function isModelAllowed(policy: ModelPolicy, model: string): boolean {
  return !deniedModelsOf(policy).includes(model);
}

/** The policy with the model allowed, or denied; the other fields of the policy stay as they were. */
export function withModelAllowed(
  policy: ModelPolicy,
  model: string,
  allowed: boolean,
): ModelPolicy {
  const others = deniedModelsOf(policy).filter((denied) => denied !== model);
  return withField(policy, 'allowed-models', 'deniedModels', allowed ? others : [...others, model]);
}

/**
 * What the caller prefers when more than one allowed model fits: the cheapest, the fastest, both,
 * or neither. The policy keeps cost and speed as two preferences; the page offers them as one
 * choice, so a policy that holds both is a choice of its own.
 */
export type PreferChoice = 'neither' | 'cost' | 'speed' | 'both';

/** The caller's choice among the models allowed, read from the cost and speed preferences. */
export function preferenceOf(policy: ModelPolicy): PreferChoice {
  const cost = fieldOf(policy, 'your-preferences', 'costPreference') === 'lowest-cost';
  const speed = fieldOf(policy, 'your-preferences', 'latencyPreference') === 'lowest-latency';
  if (cost && speed) return 'both';
  return cost ? 'cost' : speed ? 'speed' : 'neither';
}

/** The policy with the caller's choice written as the cost and speed preferences it stands for. */
export function withPreference(policy: ModelPolicy, choice: PreferChoice): ModelPolicy {
  const cost = choice === 'cost' || choice === 'both' ? 'lowest-cost' : undefined;
  const speed = choice === 'speed' || choice === 'both' ? 'lowest-latency' : undefined;
  return withField(
    withField(policy, 'your-preferences', 'costPreference', cost),
    'your-preferences',
    'latencyPreference',
    speed,
  );
}

/** The effort a model thinks at when an agent does not say, or `undefined` when none is chosen. */
export function defaultEffortOf(policy: ModelPolicy): string | undefined {
  const effort = fieldOf(policy, 'your-preferences', 'defaultEffort');
  return typeof effort === 'string' ? effort : undefined;
}

/**
 * How many choices differ between the stored policy and the edited one: each model allowed or not
 * allowed now, plus the preference and the default effort. This is the "N unsaved changes" the
 * actions bar counts, which is what the person did rather than how many fields the policy holds.
 */
export function changedChoices(stored: ModelPolicy, edited: ModelPolicy): number {
  const before = new Set(deniedModelsOf(stored));
  const after = new Set(deniedModelsOf(edited));
  let changes = 0;
  for (const model of before) if (!after.has(model)) changes += 1;
  for (const model of after) if (!before.has(model)) changes += 1;
  if (preferenceOf(stored) !== preferenceOf(edited)) changes += 1;
  if (defaultEffortOf(stored) !== defaultEffortOf(edited)) changes += 1;
  return changes;
}
