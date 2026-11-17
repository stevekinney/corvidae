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
import { z, type ZodType } from 'zod';

import { BUREAU_VERSION } from './bureau-version';
import { BUREAU_PLUGIN_NAME } from './plugins/bureau-plugin';
import {
  createFileValidator,
  type FileValidatorRuntime,
  type ValidatorFileDefinition,
  validatorFileVersion,
} from './validator-file';
import type { ValidatorFileLookup } from './validator-file-catalog';
import { createVersionedCatalog, type VersionedCatalogSource } from './versioned-catalog';

/**
 * Who a validator comes from (COR-2111): a validator passed to Bureau's options is `bureau`,
 * named `bureau` at Bureau's own version; one a plugin contributes is `plugin`, named for the
 * plugin at the plugin's version.
 */
export interface GoalValidatorSource {
  /**
   * `bureau` for a validator the host passed to Bureau, `plugin` for a contributed one, and
   * `bungalow` for one the owner wrote as a file (COR-2119).
   */
  readonly kind: 'bureau' | 'plugin' | 'bungalow';
  /** `bureau`, the contributing plugin's name, or `bungalow`. */
  readonly name: string;
  /** Bureau's own version, the plugin's, or the file's version (the digest of its definition). */
  readonly version: string;
}

/** The name an owner-defined validator's source carries. */
export const BUNGALOW_VALIDATOR_SOURCE_NAME = 'bungalow';

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
  /**
   * COR-2117 — the JSON Schema of the configuration a goal may give the validator, present only
   * when the validator declares one. The digest covers it only then, so a validator without one
   * keeps the digest it had.
   */
  readonly configuration?: Readonly<Record<string, unknown>> | undefined;
  /** Lowercase hex sha-256 over the canonical descriptor without the digest. */
  readonly descriptorDigest: string;
}

export interface GoalValidatorCatalogEntry {
  readonly identity: ValidatorIdentity;
  readonly validator: Validator;
  readonly descriptor: GoalValidatorDescriptor;
  /** Who the validator comes from (COR-2111). Not part of the descriptor, so its digest is unchanged. */
  readonly source: GoalValidatorSource;
  /**
   * COR-2119 — for an owner-defined validator, the definition it runs from, which a goal that names
   * it copies into its record. Absent for a validator the host or a plugin gave the Bureau.
   */
  readonly definition?: ValidatorFileDefinition | undefined;
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
  /**
   * Exact `(name, version)` lookup. Accepts runtime values: anything that is not a registered identity is `missing`.
   *
   * The frozen catalog is asked first, then the owner's validator files (COR-2119). `stored` is the
   * definition a goal's record copied when it named an owner-defined validator: when it is the
   * definition `identity` is the version of, the validator is built from it and the files are never
   * read, so a goal runs the check it was created with whatever its file says now.
   */
  resolve(
    identity: { readonly name: unknown; readonly version: unknown },
    stored?: ValidatorFileDefinition,
  ): GoalValidatorResolution;
  has(identity: { readonly name: unknown; readonly version: unknown }): boolean;
  /** The serializable descriptors of the frozen catalog, in registration order. */
  descriptors(): GoalValidatorDescriptor[];
  /** Every validator a goal may name: the frozen catalog's in registration order, then the ready validator files'. */
  entries(): GoalValidatorCatalogEntry[];
}

/**
 * A configuration schema as the JSON Schema a client draws its form from, on its input side, which
 * is what a person types. A schema Zod cannot write as one is `{}`: it still marks the validator as
 * taking a configuration, and the schema itself still parses it.
 */
function configurationSchemaOf(schema: ZodType): Readonly<Record<string, unknown>> {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    return {};
  }
}

function describeConfigured(
  identity: ValidatorIdentity,
  determinism: Validator['determinism'],
  configuration: Readonly<Record<string, unknown>> | undefined,
): GoalValidatorDescriptor {
  const { name, version } = identity;
  const body = {
    identity: { name, version },
    determinism: determinism ?? null,
    ...(configuration === undefined ? {} : { configuration }),
  };
  const descriptorDigest = sha256HexSync(JSON.stringify(body));
  return Object.freeze({
    identity: Object.freeze({ name, version }),
    ...(determinism === undefined ? {} : { determinism }),
    ...(configuration === undefined ? {} : { configuration }),
    descriptorDigest,
  });
}

function describeValidator(validator: Validator): GoalValidatorDescriptor {
  return describeConfigured(
    validator.identity,
    validator.determinism,
    validator.configuration === undefined
      ? undefined
      : configurationSchemaOf(validator.configuration),
  );
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
      ['identity', 'determinism', 'configuration', 'descriptorDigest'].includes(key),
    )
  ) {
    return undefined;
  }
  const identity = record['identity'] as Record<string, unknown> | null;
  const determinism = record['determinism'];
  const configuration = record['configuration'];
  if (
    typeof identity !== 'object' ||
    identity === null ||
    typeof identity['name'] !== 'string' ||
    typeof identity['version'] !== 'string' ||
    (determinism !== undefined &&
      determinism !== 'deterministic' &&
      determinism !== 'stochastic') ||
    (configuration !== undefined &&
      (typeof configuration !== 'object' || configuration === null || Array.isArray(configuration)))
  ) {
    return undefined;
  }
  const expected = describeConfigured(
    { name: identity['name'], version: identity['version'] },
    determinism,
    configuration as Readonly<Record<string, unknown>> | undefined,
  );
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
  /** The owner's validator files, read when it is asked; the catalog of files is built after this one. */
  files?: () => ValidatorFileLookup | undefined,
  /** What an owner-defined validator needs of the Bureau, read when it runs: a judge asks a model through it. */
  fileRuntime?: FileValidatorRuntime,
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

  /** The entry of an owner-defined validator: its definition run as the file kind says. */
  const fileEntry = (
    name: string,
    definition: ValidatorFileDefinition,
    version: string,
  ): GoalValidatorCatalogEntry => {
    const validator = createFileValidator(name, definition, fileRuntime);
    const descriptor = describeValidator(validator);
    return Object.freeze({
      identity: descriptor.identity,
      validator,
      descriptor,
      source: Object.freeze({
        kind: 'bungalow',
        name: BUNGALOW_VALIDATOR_SOURCE_NAME,
        version,
      }) satisfies GoalValidatorSource,
      definition,
    });
  };

  const resolve: GoalValidatorCatalog['resolve'] = (identity, stored) => {
    // A goal that copied its definition runs from the copy, and asks nothing else.
    if (
      stored !== undefined &&
      typeof identity.name === 'string' &&
      identity.version === validatorFileVersion(stored)
    ) {
      return { ok: true, entry: fileEntry(identity.name, stored, identity.version) };
    }
    const resolution = catalog.resolve('validator', identity);
    if (resolution.ok) return { ok: true, entry: resolution.entry.value };
    // The owner's files, for what the frozen catalog cannot name: a file's version is its digest, so
    // a name the files hold at another version is a version mismatch, as a frozen name is.
    const file = typeof identity.name === 'string' ? files?.()?.find(identity.name) : undefined;
    if (file === undefined) {
      const { reason, requested, availableVersions } = resolution;
      return { ok: false, reason, requested, availableVersions };
    }
    if (identity.version === file.version) {
      return { ok: true, entry: fileEntry(file.name, file.definition, file.version) };
    }
    return {
      ok: false,
      reason: 'version-mismatch',
      requested: resolution.requested,
      availableVersions: [...resolution.availableVersions, file.version],
    };
  };

  return Object.freeze({
    resolve,
    has: (identity: Parameters<typeof resolve>[0]) => resolve(identity).ok,
    descriptors: () => entries.map((entry) => entry.descriptor),
    entries: () => [
      ...entries,
      ...(files?.()
        ?.ready()
        .map((file) => fileEntry(file.name, file.definition, file.version)) ?? []),
    ],
  });
}
