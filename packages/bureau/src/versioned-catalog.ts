/**
 * COR-1872 — one catalog for every versioned contribution Bureau resolves by identity: goal
 * validators, online eval judges, decision routers, hook action kinds, workflow trigger kinds and
 * workflow activities.
 *
 * It generalizes the rule `goal-validator-catalog.ts` set for validators (COR-851). A durable
 * record pins `name@version`, and resolution answers that exact version or says why it cannot:
 * `missing` when no version of the name is registered, `version-mismatch` when others are. It
 * never falls back to a different version.
 *
 * A contribution that declares no version is registered at its source's version, the version of
 * the plugin that contributed it. Registering an identity that is already registered for the same
 * kind is not an error the caller has to catch: it returns a `clash` naming both sources and
 * leaves the first registration in place, so a loader can skip the later contribution and report
 * why.
 */

/** The kinds of contribution the catalog holds. Each kind is its own namespace of identities. */
export const VERSIONED_CATALOG_KINDS = [
  'validator',
  'eval-judge',
  'decision-router',
  'hook-action',
  'trigger-kind',
  'activity',
] as const;

/** A kind of contribution the catalog holds. */
export type VersionedCatalogKind = (typeof VERSIONED_CATALOG_KINDS)[number];

/** Who contributed an entry: a plugin's name and version, or Bureau's own code. */
export interface VersionedCatalogSource {
  /** The contributing plugin's name, or a label for code that is not a plugin. */
  readonly name: string;
  /** The contributing plugin's version; a contribution with no version of its own takes it. */
  readonly version?: string | undefined;
}

/** One contribution offered to {@link VersionedCatalog.register}. */
export interface VersionedCatalogRegistration<TValue> {
  /** The kind it is registered under. */
  readonly kind: VersionedCatalogKind;
  /** The contribution's name, usually `plugin:name`. Any non-empty string. */
  readonly name: string;
  /** The contribution's own version. Absent means its source's version. */
  readonly version?: string | undefined;
  /** The contributed implementation. */
  readonly value: TValue;
  /** Who contributed it. */
  readonly source: VersionedCatalogSource;
}

/** A registered contribution. */
export interface VersionedCatalogEntry<TValue> {
  /** The kind it is registered under. */
  readonly kind: VersionedCatalogKind;
  /** The contribution's name. */
  readonly name: string;
  /** The version it is registered at: its own, or its source's. */
  readonly version: string;
  /** `name@version`, the form a durable record stores. */
  readonly id: string;
  /** The contributed implementation. */
  readonly value: TValue;
  /** Who contributed it. */
  readonly source: VersionedCatalogSource;
}

/** The outcome of {@link VersionedCatalog.register}. */
export type VersionedCatalogRegistrationResult<TValue> =
  | { readonly ok: true; readonly entry: VersionedCatalogEntry<TValue> }
  | {
      readonly ok: false;
      readonly reason: 'clash';
      readonly kind: VersionedCatalogKind;
      /** The `name@version` both registrations claim. */
      readonly id: string;
      /** The source of the registration that stays. */
      readonly existing: VersionedCatalogSource;
      /** The source of the registration that was refused. */
      readonly rejected: VersionedCatalogSource;
    };

/** The identity a resolution was asked for, after coercing runtime values. */
export interface VersionedCatalogRequest {
  /** The requested name; empty when the reference carried none. */
  readonly name: string;
  /** The requested version; empty when the reference carried none. */
  readonly version: string;
}

/** The outcome of {@link VersionedCatalog.resolve}. */
export type VersionedCatalogResolution<TValue> =
  | { readonly ok: true; readonly entry: VersionedCatalogEntry<TValue> }
  | {
      readonly ok: false;
      readonly reason: 'missing';
      readonly kind: VersionedCatalogKind;
      readonly requested: VersionedCatalogRequest;
      /** Always empty: no version of this name is registered. */
      readonly availableVersions: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: 'version-mismatch';
      readonly kind: VersionedCatalogKind;
      readonly requested: VersionedCatalogRequest;
      /** Every registered version of the requested name, in registration order. */
      readonly availableVersions: readonly string[];
    };

/** What {@link VersionedCatalog.resolve} accepts: a `name@version` string or the two parts. */
export type VersionedCatalogReference =
  string | { readonly name: unknown; readonly version: unknown };

/** A versioned catalog; see the module comment for its rules. */
export interface VersionedCatalog<TValue = unknown> {
  /**
   * Registers a contribution. Throws `TypeError` for an unusable identity (an empty name, no
   * version and no source version, or a version containing `@`); returns a `clash` when the kind
   * already holds the same `name@version`.
   */
  register(
    registration: VersionedCatalogRegistration<TValue>,
  ): VersionedCatalogRegistrationResult<TValue>;
  /**
   * Exact lookup of `kind` at `reference`. Accepts runtime values: anything that is not a
   * registered identity is `missing` or `version-mismatch`, never another version.
   */
  resolve(
    kind: VersionedCatalogKind,
    reference: VersionedCatalogReference,
  ): VersionedCatalogResolution<TValue>;
  /** The entries of `kind`, in registration order. */
  entries(kind: VersionedCatalogKind): VersionedCatalogEntry<TValue>[];
}

/** The `name@version` id of an identity. */
export function formatVersionedId(name: string, version: string): string {
  return `${name}@${version}`;
}

/**
 * Splits a `name@version` id at its last `@`, so a name may itself contain `@`. `undefined` when
 * there is no `@`, or either side is empty.
 */
export function parseVersionedId(id: string): VersionedCatalogRequest | undefined {
  const index = id.lastIndexOf('@');
  if (index <= 0 || index === id.length - 1) return undefined;
  return { name: id.slice(0, index), version: id.slice(index + 1) };
}

function requestOf(reference: VersionedCatalogReference): VersionedCatalogRequest {
  if (typeof reference === 'string') {
    return parseVersionedId(reference) ?? { name: reference, version: '' };
  }
  return {
    name: typeof reference.name === 'string' ? reference.name : '',
    version: typeof reference.version === 'string' ? reference.version : '',
  };
}

function registeredVersion(registration: VersionedCatalogRegistration<unknown>): string {
  const { name, version, source } = registration;
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('A versioned catalog contribution needs a non-empty name.');
  }
  const resolved = version ?? source.version;
  if (typeof resolved !== 'string' || resolved.length === 0) {
    throw new TypeError(
      `Contribution "${name}" declares no version, and its source "${source.name}" has none to give it.`,
    );
  }
  if (resolved.includes('@')) {
    throw new TypeError(`Contribution "${name}" has version "${resolved}", which contains "@".`);
  }
  return resolved;
}

/** Builds an empty catalog. */
export function createVersionedCatalog<TValue = unknown>(): VersionedCatalog<TValue> {
  const byKind = new Map<
    VersionedCatalogKind,
    Map<string, Map<string, VersionedCatalogEntry<TValue>>>
  >();
  const ordered = new Map<VersionedCatalogKind, VersionedCatalogEntry<TValue>[]>();

  const register: VersionedCatalog<TValue>['register'] = (registration) => {
    const { kind, name, value } = registration;
    if (!(VERSIONED_CATALOG_KINDS as readonly string[]).includes(kind)) {
      throw new TypeError(`"${kind}" is not a versioned catalog kind.`);
    }
    const version = registeredVersion(registration);
    const source = Object.freeze({ ...registration.source });
    const names = byKind.get(kind) ?? new Map<string, Map<string, VersionedCatalogEntry<TValue>>>();
    const versions = names.get(name) ?? new Map<string, VersionedCatalogEntry<TValue>>();
    const id = formatVersionedId(name, version);
    const existing = versions.get(version);
    if (existing !== undefined) {
      return { ok: false, reason: 'clash', kind, id, existing: existing.source, rejected: source };
    }
    const entry: VersionedCatalogEntry<TValue> = Object.freeze({
      kind,
      name,
      version,
      id,
      value,
      source,
    });
    versions.set(version, entry);
    names.set(name, versions);
    byKind.set(kind, names);
    const list = ordered.get(kind) ?? [];
    list.push(entry);
    ordered.set(kind, list);
    return { ok: true, entry };
  };

  const resolve: VersionedCatalog<TValue>['resolve'] = (kind, reference) => {
    const requested = Object.freeze(requestOf(reference));
    const versions = byKind.get(kind)?.get(requested.name);
    if (versions === undefined) {
      return { ok: false, reason: 'missing', kind, requested, availableVersions: [] };
    }
    const entry = versions.get(requested.version);
    if (entry === undefined) {
      return {
        ok: false,
        reason: 'version-mismatch',
        kind,
        requested,
        availableVersions: [...versions.keys()],
      };
    }
    return { ok: true, entry };
  };

  return Object.freeze({
    register,
    resolve,
    entries: (kind: VersionedCatalogKind) => [...(ordered.get(kind) ?? [])],
  });
}
