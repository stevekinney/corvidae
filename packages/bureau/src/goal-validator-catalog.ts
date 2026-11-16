/**
 * COR-851 — the Bureau validator catalog for durable goals.
 *
 * Mirrors `createAgentCatalog` (`agent-catalog.ts`): a fixed, frozen set built
 * once at construction, looked up by name. A goal persists only a validator's
 * serializable IDENTITY (name and version). The executable stays in-process
 * code registered here by name and version, never serialized, so recovery
 * resolves the pinned identity again on every use.
 *
 * Resolution never throws and never falls back to a different version: a
 * redeploy that dropped or bumped a validator is reported explicitly as
 * `missing` or `version-mismatch`, and the caller turns that into the
 * `unavailable` outcome COR-638 already defines.
 */

import { sha256HexSync } from '@lostgradient/cryptography';
import type { Validator, ValidatorIdentity } from '@lostgradient/operative';

import { BUREAU_VERSION } from './bureau-version';
import { BUREAU_PLUGIN_NAME } from './plugins/bureau-plugin';
import { createVersionedCatalog, type VersionedCatalogSource } from './versioned-catalog';

/**
 * Who a validator comes from (COR-2111): a validator passed to Bureau's options is `bureau`,
 * named `bureau` at Bureau's own version; one a plugin contributes is `plugin`, named for the
 * plugin at the plugin's version.
 */
export interface GoalValidatorSource {
  /** `bureau` for a validator the host passed to Bureau, `plugin` for a contributed one. */
  readonly kind: 'bureau' | 'plugin';
  /** `bureau`, or the contributing plugin's name. */
  readonly name: string;
  /** Bureau's own version, or the plugin's. */
  readonly version: string;
}

/** The source of a validator passed to Bureau's options rather than contributed by a plugin. */
const GOAL_VALIDATOR_SOURCE: GoalValidatorSource = Object.freeze({
  kind: 'bureau',
  name: BUREAU_PLUGIN_NAME,
  version: BUREAU_VERSION,
});

/** Where a validator was contributed from, when it was not passed to Bureau's options. */
export type GoalValidatorSourceOf = (
  identity: ValidatorIdentity,
) => VersionedCatalogSource | undefined;

/** The serializable description of a registered validator. */
export interface GoalValidatorDescriptor {
  readonly identity: ValidatorIdentity;
  /** Absent when the validator did not declare it; only `'deterministic'` satisfies a goal that requires it. */
  readonly determinism?: 'deterministic' | 'stochastic' | undefined;
  /** Lowercase hex sha-256 over the canonical descriptor without the digest. */
  readonly descriptorDigest: string;
}

export interface GoalValidatorCatalogEntry {
  readonly identity: ValidatorIdentity;
  readonly validator: Validator;
  readonly descriptor: GoalValidatorDescriptor;
  /** Who the validator comes from (COR-2111). Not part of the descriptor, so its digest is unchanged. */
  readonly source: GoalValidatorSource;
}

export type GoalValidatorResolution =
  | { readonly ok: true; readonly entry: GoalValidatorCatalogEntry }
  | {
      readonly ok: false;
      readonly reason: 'missing';
      readonly requested: ValidatorIdentity;
      /** Always empty: no version of this name is registered. */
      readonly availableVersions: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: 'version-mismatch';
      readonly requested: ValidatorIdentity;
      /** Every registered version of the requested name, in registration order. */
      readonly availableVersions: readonly string[];
    };

export interface GoalValidatorCatalog {
  /** Exact `(name, version)` lookup. Accepts runtime values: anything that is not a registered identity is `missing`. */
  resolve(identity: { readonly name: unknown; readonly version: unknown }): GoalValidatorResolution;
  has(identity: { readonly name: unknown; readonly version: unknown }): boolean;
  /** The serializable descriptors, in registration order. */
  descriptors(): GoalValidatorDescriptor[];
  entries(): GoalValidatorCatalogEntry[];
}

function describeValidator(validator: Validator): GoalValidatorDescriptor {
  const { name, version } = validator.identity;
  const determinism = validator.determinism;
  const body = { identity: { name, version }, determinism: determinism ?? null };
  const descriptorDigest = sha256HexSync(JSON.stringify(body));
  return Object.freeze({
    identity: Object.freeze({ name, version }),
    ...(determinism === undefined ? {} : { determinism }),
    descriptorDigest,
  });
}

/**
 * Decodes a descriptor read back from storage or a wire. Fail-closed: `undefined`
 * unless the value is exactly a descriptor whose digest matches its own contents.
 */
export function decodeGoalValidatorDescriptor(value: unknown): GoalValidatorDescriptor | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !Object.keys(record).every((key) =>
      ['identity', 'determinism', 'descriptorDigest'].includes(key),
    )
  ) {
    return undefined;
  }
  const identity = record['identity'] as Record<string, unknown> | null;
  const determinism = record['determinism'];
  if (
    typeof identity !== 'object' ||
    identity === null ||
    typeof identity['name'] !== 'string' ||
    typeof identity['version'] !== 'string' ||
    (determinism !== undefined && determinism !== 'deterministic' && determinism !== 'stochastic')
  ) {
    return undefined;
  }
  const expected = describeValidator({
    identity: { name: identity['name'], version: identity['version'] },
    determinism,
    validate: () => ({ kind: 'canceled' }),
  });
  return record['descriptorDigest'] === expected.descriptorDigest ? expected : undefined;
}

/**
 * Builds the immutable catalog over a fixed list of validators, on the shared versioned catalog
 * (COR-1872) under the `validator` kind. Throws at construction for a validator with no usable
 * identity and for two validators registered under the same `(name, version)`: in a list passed
 * to Bureau both are programming errors a bureau should refuse to start with, so the catalog's
 * `clash` result becomes an error here.
 */
export function createGoalValidatorCatalog(
  validators: readonly Validator[] = [],
  sourceOf?: GoalValidatorSourceOf,
): GoalValidatorCatalog {
  const catalog = createVersionedCatalog<GoalValidatorCatalogEntry>();
  const entries: GoalValidatorCatalogEntry[] = [];
  for (const validator of validators) {
    const { name, version } =
      (validator as { identity?: Partial<ValidatorIdentity> }).identity ?? {};
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      typeof version !== 'string' ||
      version.length === 0 ||
      version.includes('@') ||
      typeof validator.validate !== 'function'
    ) {
      throw new TypeError(
        'Bureau goal validators require a non-empty identity name, a non-empty version without "@", and a validate() function.',
      );
    }
    const descriptor = describeValidator(validator);
    const contributed = sourceOf?.({ name, version });
    const source: GoalValidatorSource =
      contributed?.version === undefined
        ? GOAL_VALIDATOR_SOURCE
        : Object.freeze({ kind: 'plugin', name: contributed.name, version: contributed.version });
    const entry = Object.freeze({ identity: descriptor.identity, validator, descriptor, source });
    const registered = catalog.register({
      kind: 'validator',
      name,
      version,
      value: entry,
      source,
    });
    if (!registered.ok) {
      throw new Error(`Bureau goal validator "${name}@${version}" is registered more than once.`);
    }
    entries.push(entry);
  }

  const resolve: GoalValidatorCatalog['resolve'] = (identity) => {
    const resolution = catalog.resolve('validator', identity);
    if (resolution.ok) return { ok: true, entry: resolution.entry.value };
    const { reason, requested, availableVersions } = resolution;
    return { ok: false, reason, requested, availableVersions };
  };

  return Object.freeze({
    resolve,
    has: (identity: Parameters<typeof resolve>[0]) => resolve(identity).ok,
    descriptors: () => entries.map((entry) => entry.descriptor),
    entries: () => [...entries],
  });
}
