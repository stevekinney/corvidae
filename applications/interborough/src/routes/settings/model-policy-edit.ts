/**
 * Edits to the `modelPolicy` setting, a field of one layer at a time. The setting is
 * `{ deployment?, bureau?, users?, policyRevision }`. Settings › Model policy edits two of the
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
