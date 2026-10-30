/**
 * The unified typed agent catalog (AB-15, AB-22).
 *
 * `AgentDefinitions` replaces the synchronous builder's registry: a plain
 * literal object passed to `createBureau({ agents })`, fixed for the
 * bureau's lifetime. `BureauAgentCatalog` is the read-only, immutable view
 * `bureau.agents` exposes over it — `get`/`find`/`has`/`names`/`entries`/
 * `query`, and nothing that mutates.
 *
 * With `BureauOptions.agentSource` (COR-1524) the catalog also holds agents loaded from
 * Markdown files, which change at run time. Those are reached by runtime string: `find`, `list`,
 * `revisions`, and the file write API. The `D`-typed accessors stay the code-defined map's.
 */

import type {
  AgentGenerationProfile,
  AgentRun,
  BackendDescriptor,
  RunnableAgent,
} from '@lostgradient/operative';
import { projectDescriptor, readGenerationProfile } from '@lostgradient/operative';

import { AgentFileError } from './agent-file';
import { agentSkillNames } from './agent-skills';
import { type AgentModels, describeAgentModels } from './agent-models';
import type {
  AgentCatalogChange,
  AgentCodeDefinition,
  AgentFileCatalog,
  AgentFileDetail,
  AgentFileVersions,
  AgentListing,
  AgentToolDescription,
} from './agent-file-catalog';
import type { AgentFileWriter } from './agent-file-writer';
import type { AgentVersionRecord } from './agent-version-store';
import type { AgentRevision, AgentSnapshotStore } from './agent-snapshot-store';
import { ownerOrLocal } from './owner-of-record';

/**
 * A plain literal map of agent name to `RunnableAgent`. There is no
 * constructor, no `.register()`/`.unregister()` lifecycle, and no event
 * stream for registration changes — the map is fixed at `createBureau(...)`
 * call time. The value bound is a two-member union —
 * `RunnableAgent<never, false> | RunnableAgent<any, true>` — covering the
 * "no output schema" shape and the "has some output schema" shape
 * separately, rather than one instantiation of `RunnableAgent<O, H>`. No
 * single concrete `(O, H)` pair works: `AgentRun<O, H>.unwrap()`'s return
 * type is `[H] extends [true] ? O : string`, and a real `StandaloneAgent`
 * (createAgent's return type, structurally similar to but nominally
 * distinct from `RunnableAgent`) forces that conditional to fully expand
 * during the structural check — `<never, boolean>` fits every no-schema
 * agent but rejects every schema'd one (schema'd `unwrap()` returns the
 * schema type, not `string`); `<any, boolean>`/`<any, any>` do the reverse
 * or fail outright, because a concrete (non-generic-parameter) `H`
 * deterministically picks ONE conditional branch — `boolean` picks false,
 * and `any` picks true (`[any] extends [true]` resolves the true branch
 * here, not a union of both, unlike a bare `Cond<any>` reference checked in
 * isolation). Two exact-shape union members sidestep the conditional
 * entirely: each member matches one shape outright, and `any` in the second
 * member's `O` slot only needs to absorb the OUTPUT type (which `unwrap()`
 * returns) once `H` is already the concrete literal `true` picking that
 * branch. `AgentOutput`/`AgentHasOutput` below infer from each entry's OWN
 * concrete type (`D[TName]`), not from this bound, so lookups through the
 * catalog stay precisely typed regardless of this union's own imprecision.
 */
export type AnyRunnableAgent =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- required for the has-output union member; see comment above.
  RunnableAgent | RunnableAgent<any, true>;

export type AgentDefinitions = Record<string, AnyRunnableAgent>;

/** The literal agent names of `D`, widened to `string` for runtime use. */
export type AgentNames<D extends AgentDefinitions> = keyof D & string;

/**
 * `D[TName]`'s validated output type — `never` when that agent has none.
 *
 * Matches `RunnableAgent<never, false>` and `RunnableAgent<infer O, true>`
 * as two SEPARATE branches, deliberately not one `RunnableAgent<infer O,
 * boolean>` check — the same conditional-expansion problem `AgentDefinitions`'
 * own doc comment describes for the value bound above recurs here for a
 * different reason. `RunnableAgent.run()` returns `AgentRun<O, H>`, and
 * `AgentRun`'s `unwrap()`/`result()` members embed `H`-conditional types
 * (`UnwrappedValue<O, H>`, `RunResult<O, H>`). Checking a real schema'd
 * `StandaloneAgent<O, true>` against a target with `H` fixed to the
 * non-literal `boolean` collapses those conditionals structurally (`[boolean]
 * extends [true]` is false, since `boolean` is not assignable to the literal
 * `true`) before `O` is ever inferred from them — so `infer O` silently binds
 * to whatever unrelated type is left in that collapsed position (observed:
 * `string`, `unwrap()`'s false-branch type) instead of the real output type.
 * Matching `true` and `false` as separate literal branches keeps `H` fixed to
 * a literal on each side, so the `H`-conditional members never collapse and
 * `O` infers correctly.
 */
export type AgentOutput<
  D extends AgentDefinitions,
  TName extends keyof D,
> = D[TName] extends RunnableAgent
  ? never
  : D[TName] extends RunnableAgent<infer O, true>
    ? O
    : never;

/** Whether `D[TName]` was built with an `output` schema. */
export type AgentHasOutput<D extends AgentDefinitions, TName extends keyof D> =
  D[TName] extends RunnableAgent<unknown, infer H> ? H : false;

/**
 * `bureau.tasks.start`'s handle type, name-keyed and DISTRIBUTIVE over `TName`
 * (review round 2, Codex) — required whenever a caller's static `name` type
 * is a union spanning both a schema-backed and a schema-less agent (e.g. a
 * name read from a variable typed `'schema' | 'plain'`, or a generic helper
 * forwarding a caller-supplied literal union). `AgentOutput`/`AgentHasOutput`
 * key off `D[TName]` — an indexed access, not a naked type-parameter
 * reference — so neither one distributes over a union `TName` on its own;
 * wrapping them in `AgentRun<AgentOutput<D, TName>, AgentHasOutput<D,
 * TName>>` directly (as `BureauTasks.start`'s signature could) computes `O`/`H`
 * against the COLLAPSED union `D[TName1] | D[TName2]` once, which can
 * resolve `AgentHasOutput` to the non-literal `boolean` and make `AgentRun`
 * select its `H = false` conditional branch regardless of which name was
 * actually passed — `unwrap()` then types as `Promise<string>` even for a
 * call that resolves to the schema'd agent at runtime, an unsound
 * `Promise<string>` promise where a real caller gets back a parsed object.
 * The `TName extends TName ? ... : never` idiom is TypeScript's standard way
 * to force distribution over an otherwise inert type-parameter position:
 * inside that true branch, `TName` is narrowed to ONE union member at a
 * time as the conditional expands, so `AgentOutput`/`AgentHasOutput`
 * evaluate correctly per member and the results union together as
 * `AgentRun<O1, H1> | AgentRun<O2, H2> | ...` — never collapsed.
 */
export type AgentRunForName<
  D extends AgentDefinitions,
  TName extends keyof D & string,
> = TName extends TName ? AgentRun<AgentOutput<D, TName>, AgentHasOutput<D, TName>> : never;

export interface AgentCatalogEntry<
  D extends AgentDefinitions,
  TName extends keyof D & string = keyof D & string,
> {
  readonly name: TName;
  readonly agent: D[TName];
}

/**
 * Read-only, immutable inspection surface over a fixed `AgentDefinitions`
 * map — `bureau.agents`. Nothing here mutates the catalog; the map itself is
 * fixed for the bureau's lifetime (AB-15).
 */
export interface BureauAgentCatalog<D extends AgentDefinitions> {
  /** Compile-time-safe lookup — only a literal key of `D` type-checks. */
  get<TName extends keyof D & string>(name: TName): D[TName];
  /**
   * Runtime lookup for a name that arrived as a plain `string` (an HTTP path
   * parameter, a webhook payload). TypeScript cannot narrow a runtime string
   * back to a literal key, so the return type widens to `AnyRunnableAgent` —
   * `AgentDefinitions`' own two-member union value bound, not the collapsed
   * `RunnableAgent<unknown, boolean>` (review finding, PRRT_kwDORvupsc6elgnG):
   * that single-instantiation shape forces `AgentRun<O, H>.unwrap()`'s
   * `H`-conditional to pick its `false` branch regardless of which agent
   * actually matched, so `find(name)!.run(...).unwrap()` was unsoundly typed
   * `Promise<string>` even when the runtime match is schema-backed and
   * returns the parsed object. The two-member union sidesteps the
   * conditional the same way `AgentDefinitions` itself does — see its doc
   * comment.
   */
  find(name: string): AnyRunnableAgent | undefined;
  /**
   * Narrows a runtime `string` to a known literal key of `D` where
   * TypeScript permits it (a type predicate) — `if (catalog.has(name))`
   * lets `catalog.get(name)` (literal-key-only) compile on the narrowed
   * `name` inside that branch, without a cast.
   */
  has(name: string): name is keyof D & string;
  /** Definition order — the order `Object.keys(agents)` produced. */
  names(): Array<keyof D & string>;
  entries(): Array<AgentCatalogEntry<D>>;
  query(predicate: (entry: AgentCatalogEntry<D>) => boolean): Array<AgentCatalogEntry<D>>;
  /**
   * The `'general'`-projection form of the named agent's `AgentGenerationProfile`
   * (AB-64 AC8, AB-247/mod-02e) — every descriptor redacted through
   * `projectDescriptor(descriptor, 'general')`, and `projection: 'general'`
   * stamped on the returned profile itself, per AB-34's "a caller reads
   * which projection it received" contract. `undefined` for a name this
   * catalog does not hold — never a fabricated default profile for an
   * unknown name; that's a distinct case from a known agent with no
   * `generationProfile` of its own, which `readGenerationProfile`'s
   * `mode: 'opaque'` fallback already covers.
   *
   * Computed once per agent at `createAgentCatalog` call time and cached, so
   * repeated reads for the same name return the identical object by
   * reference. Synchronous, side-effect-free: no network input or output,
   * no clock read, no background work — never a channel for request-time
   * provider configuration (AB-64's AB-15/AB-22 boundaries, AC9).
   */
  generationProfile(name: string): AgentGenerationProfile | undefined;
  /**
   * Every agent the deployment has, code-defined and file-based together (COR-1524): code agents
   * first in definition order, then file agents by identifier. A file that cannot be used is
   * listed with `state: 'invalid'` and a typed `problem`. Unlike {@link names} and
   * {@link entries}, which describe the code-defined map the type parameter `D` types, this view
   * is by runtime string.
   */
  list(): readonly AgentListing[];
  /**
   * One agent as an editor needs it, or `undefined` when no agent has that identifier. For a file
   * agent it reads the file now: the listing fields, the file's exact `text`, and the
   * `definition` it parses to, all describing the same bytes as `definitionHash`. A code-defined
   * agent has neither a file nor a definition Bureau can show, so both are `null`.
   */
  detail(id: string): Promise<AgentFileDetail | undefined>;
  /**
   * The models the named agent allows a session to be switched to, and the one its next step would
   * use with no override, against the deployment's model catalog as it is now (COR-1708), or
   * `undefined` when no agent has that name. A file agent is selectable within its `models` list;
   * a code-defined agent reports what its generation profile says.
   */
  models(name: string): AgentModels | undefined;
  /** The tools an agent file may name: the deployment's tool catalog, by name. */
  tools(): readonly AgentToolDescription[];
  /**
   * The snapshots that have run for `id`, most recently run first. A snapshot is kept while any
   * run that references it is retained (`BureauRetentionOptions.tasks`) and pruned after the last.
   */
  revisions(id: string): Promise<readonly AgentRevision[]>;
  /**
   * The saved versions of file agents (COR-1815), which are kept apart from the runs that used
   * them: every save, and every edit the directory watcher finds, is one version, whether or not
   * the agent ever ran. {@link revisions} lists what has run; this lists what was saved.
   */
  readonly versions: {
    /**
     * The versions of `id`, newest revision first, at most 50 plus any a retained run references.
     * Empty for a code-defined agent, an unknown identifier, or a Bureau with no agent source.
     */
    list(id: string): Promise<readonly AgentVersionRecord[]>;
    /**
     * Write the definition of version `revision` back as a new revision, if the file still hashes
     * to `expectedHash`. See `AgentFileVersions.restore` for the failures.
     */
    restore: AgentFileVersions['restore'];
  };
  /**
   * Rescan the agent directory now, and when the model catalog has changed since the last scan,
   * revalidate against it. Resolves once the catalog reflects the directory. A no-op without
   * `BureauOptions.agentSource`.
   */
  refresh(): Promise<void>;
  /** Called after every rescan that added, changed, or removed a file agent. Returns its unsubscribe. */
  onChange(listener: (change: AgentCatalogChange) => void): () => void;
  /** The text and SHA-256 of an agent's file, the `expectedHash` of a later write. */
  read: AgentFileWriter['read'];
  /** Write a new agent file. Fails with `AgentFileConflictError` when the file exists. */
  create: AgentFileWriter['create'];
  /** Rewrite an agent file, keeping frontmatter keys Bureau does not know and the body. */
  update: AgentFileWriter['update'];
  /** Delete an agent file. */
  delete: AgentFileWriter['delete'];
  /**
   * COR-1873 — copy a plugin's read-only agent (`plugin:name`) into the owner's source as
   * `name.md`, with its tools unversioned. Fails with `AgentFileConflictError` when that file exists.
   */
  duplicate: AgentFileWriter['duplicate'];
}

/**
 * Options for {@link createAgentCatalog}. `selectorAvailable` defaults to
 * `false`: `createBureau` passes `false` today (no selector wired yet); a
 * future selector integration (AB-66) flips it to `true` so a `selectable`
 * agent's catalog-read profile reports `selector: 'available'` — the
 * transition has this one named mechanism in this one file, rather than an
 * implicit reflection over whether a selector happens to be configured
 * elsewhere.
 */
export interface CreateAgentCatalogOptions {
  readonly selectorAvailable?: boolean;
  /** The agents loaded from `BureauOptions.agentSource` (COR-1524). */
  readonly files?: AgentFileCatalog | undefined;
  /** Where file agents' run snapshots live. */
  readonly snapshots?: AgentSnapshotStore | undefined;
  /**
   * The deployment's model catalog as it is now, read on every {@link BureauAgentCatalog.models}
   * call because the catalog can be replaced. Defaults to an empty catalog.
   */
  readonly descriptors?: (() => readonly BackendDescriptor[]) | undefined;
}

/**
 * Builds the immutable `BureauAgentCatalog` view over a fixed
 * `AgentDefinitions` map. `Object.entries` preserves string-key insertion
 * order, so `names()`/`entries()`/`query()` iterate in the exact order
 * `agents` was written in — the "preserve definition order" contract.
 *
 * `find`/`has` are exact-key lookups. The predecessor `AgentRegistry.query()`
 * matched `text` against agent name/description case-insensitively; that
 * shape doesn't survive here, because `find`/`get`/`has` narrow (or must
 * narrow) on an exact name so `has` narrowing a literal string to `keyof D`
 * isn't undermined by a lookup that silently accepts a differently-cased name
 * it wouldn't `.get()`. An agent's optional `description` and
 * `skillDescriptors` (COR-1301) ride on the returned `RunnableAgent` object
 * itself, so `get`/`entries` surface them with the object's identity
 * unchanged. A case-insensitive *search* is still available through `query(predicate)`,
 * where the predicate can lower-case both sides itself.
 */
export function createAgentCatalog<D extends AgentDefinitions>(
  agents: D,
  options?: CreateAgentCatalogOptions,
): BureauAgentCatalog<D> {
  const selectorAvailable = options?.selectorAvailable ?? false;
  const files = options?.files;
  const snapshots = options?.snapshots;
  const descriptors = options?.descriptors ?? (() => []);
  // A file agent is rebuilt whenever its file changes, so its profile is cached by the object.
  const fileAgentProfiles = new WeakMap<object, AgentGenerationProfile>();
  const requireFiles = (): AgentFileCatalog => {
    if (files === undefined) {
      throw new AgentFileError(
        'agent-directory-not-configured',
        'This Bureau has no agent source. Pass BureauOptions.agentSource to use agent files.',
      );
    }
    return files;
  };
  // `Object.entries`/`Map` widen each value to the Record's own bound
  // (`RunnableAgent<never, false> | RunnableAgent<any, true>`), losing the
  // per-key precision `AgentCatalogEntry<D>` promises. The cast below
  // restores it: at runtime every entry genuinely IS `agents[name]`, so this
  // is a type-level-only correction, not a behavior change — TypeScript
  // cannot itself prove `Object.entries(agents)[i][1] extends D[TName]` for
  // a generic `D`, since `Object.entries`'s signature necessarily widens to
  // the Record's value bound.
  // Each entry is frozen individually, not just the outer `catalog` object
  // below — `entries()`/`query()` hand these exact objects out (not copies),
  // so a caller mutating a returned entry's `name`/`agent` would otherwise
  // desynchronize `names()`/`has()`/`get()`/`find()` from what `query()`
  // returns, despite the catalog's "fixed for the bureau's lifetime"
  // contract. This is real protection for a JavaScript caller or a
  // TypeScript caller reaching past the type system; freezing only the
  // catalog object would leave every entry it hands out just as mutable as
  // before.
  const entries = Object.entries(agents).map(
    ([name, agent]) => Object.freeze({ name, agent }) as AgentCatalogEntry<D>,
  );
  const byName = new Map<string, AgentCatalogEntry<D>>(entries.map((entry) => [entry.name, entry]));
  const codeListing = (entry: AgentCatalogEntry<D>): AgentListing => ({
    id: entry.name,
    source: 'code',
    state: 'ready',
    name: entry.agent.name,
    description: entry.agent.description ?? null,
    a2a: false,
    owner: ownerOrLocal(undefined),
    definitionRevision: readGenerationProfile(entry.agent).revision,
  });
  // Computed once, here, not lazily per call — "cached, side-effect-free
  // read" (AC9) means a `generationProfile(name)` call is a plain Map
  // lookup, never a recomputation, so repeated reads for the same name
  // return the identical object by reference.
  const generationProfiles = new Map<string, AgentGenerationProfile>(
    entries.map((entry) => [
      entry.name,
      buildCatalogGenerationProfile(entry.agent, selectorAvailable),
    ]),
  );

  const catalog: BureauAgentCatalog<D> = {
    // Same cast rationale as above: `byName.get(name)!.agent` is genuinely
    // `D[TName]` for a `TName` the caller supplied, but the `Map`'s own
    // value type is the widened `AgentCatalogEntry<D>['agent']`, which
    // TypeScript cannot narrow back to the caller's specific `TName`.
    get<TName extends keyof D & string>(name: TName): D[TName] {
      const entry = byName.get(name);
      if (!entry) {
        throw new Error(`Unknown agent "${name}"`);
      }
      return entry.agent as D[TName];
    },
    find(name) {
      return byName.get(name)?.agent ?? files?.find(name);
    },
    has(name): name is keyof D & string {
      return byName.has(name);
    },
    names() {
      return entries.map((entry) => entry.name);
    },
    entries() {
      return [...entries];
    },
    query(predicate) {
      return entries.filter(predicate);
    },
    generationProfile(name) {
      const cached = generationProfiles.get(name);
      if (cached !== undefined) return cached;
      const fileAgent = files?.find(name);
      if (fileAgent === undefined) return undefined;
      let profile = fileAgentProfiles.get(fileAgent);
      if (profile === undefined) {
        profile = buildCatalogGenerationProfile(fileAgent, selectorAvailable);
        fileAgentProfiles.set(fileAgent, profile);
      }
      return profile;
    },
    list() {
      return [...entries.map(codeListing), ...(files?.list() ?? [])];
    },
    async detail(id) {
      const code = byName.get(id);
      if (code !== undefined) {
        return {
          ...codeListing(code),
          text: null,
          definition: null,
          codeDefinition: describeCodeAgent(code.agent, descriptors()),
        };
      }
      return files?.detail(id);
    },
    models(name) {
      const agent = byName.get(name)?.agent ?? files?.find(name);
      return agent === undefined ? undefined : describeAgentModels(agent, descriptors());
    },
    tools() {
      // A code-defined agent that names a catalog tool uses it too. Its `toolNames` come from
      // `createAgent`; an agent that states none uses none that can be told.
      const codeUsers = new Map<string, string[]>();
      for (const entry of entries) {
        for (const name of codeToolNames(entry.agent)) {
          codeUsers.set(name, [...(codeUsers.get(name) ?? []), entry.name]);
        }
      }
      return (files?.tools() ?? []).map((tool) => ({
        ...tool,
        users: [...tool.users, ...(codeUsers.get(tool.name) ?? [])].toSorted(),
      }));
    },
    revisions(id) {
      return snapshots?.revisions(id) ?? Promise.resolve([]);
    },
    versions: {
      list: async (id) => files?.versions.list(id) ?? [],
      restore: async (id, revision, writeOptions) =>
        requireFiles().versions.restore(id, revision, writeOptions),
    },
    refresh() {
      return files?.refresh() ?? Promise.resolve();
    },
    onChange(listener) {
      return files?.onChange(listener) ?? (() => undefined);
    },
    read: async (id) => requireFiles().read(id),
    create: async (id, definition, writeOptions) =>
      requireFiles().create(id, definition, writeOptions),
    update: async (id, definition, writeOptions) =>
      requireFiles().update(id, definition, writeOptions),
    delete: async (id, writeOptions) => requireFiles().delete(id, writeOptions),
    duplicate: async (id, writeOptions) => requireFiles().duplicate(id, writeOptions),
  };

  return Object.freeze(catalog);
}

/** What a code-defined agent states about itself, read from the agent object. See {@link AgentCodeDefinition}. */
function describeCodeAgent(
  agent: AnyRunnableAgent,
  descriptors: readonly BackendDescriptor[],
): AgentCodeDefinition {
  const models = describeAgentModels(agent, descriptors);
  const named = (choice: { readonly provider: string; readonly model: string }) =>
    `${choice.provider}/${choice.model}`;
  const stated = agent as {
    readonly instructions?: unknown;
    readonly skills?: object | undefined;
  };
  return {
    name: agent.name,
    description: agent.description ?? null,
    model: models.default === null ? null : named(models.default),
    models: models.models.map(named),
    tools: codeToolNames(agent),
    skills: agentSkillNames(stated.skills),
    skillDescriptors: (agent.skillDescriptors ?? []).map((descriptor) => ({ ...descriptor })),
    instructions:
      typeof stated.instructions === 'string' && stated.instructions !== ''
        ? stated.instructions
        : null,
  };
}

/**
 * The tool names a code-defined agent states (`StandaloneAgent.toolNames`), or none for an agent
 * that is not a `createAgent` result or states anything else. A runnable agent may be any object
 * with a `run`, so the property is checked rather than trusted.
 */
export function codeToolNames(agent: object): readonly string[] {
  const names = (agent as { readonly toolNames?: unknown }).toolNames;
  return Array.isArray(names) && names.every((name) => typeof name === 'string') ? names : [];
}

/**
 * Builds the `'general'`-projection `AgentGenerationProfile` `createAgentCatalog`
 * caches for one agent: reads the agent's own profile (or the frozen
 * `mode: 'opaque'` default `readGenerationProfile` falls back to), projects
 * every descriptor to `'general'`, and — for a `'selectable'` agent only —
 * reports `selector: 'available'` when `selectorAvailable` is `true`.
 * `selectorAvailable` never affects a non-`'selectable'` agent's `selector`,
 * which stays whatever `readGenerationProfile` reported (`'unavailable'` for
 * every mode `createAgent`/`createLazyAgent` can produce today).
 */
function buildCatalogGenerationProfile(
  agent: AnyRunnableAgent,
  selectorAvailable: boolean,
): AgentGenerationProfile {
  const profile = readGenerationProfile(agent);
  const descriptors = Object.freeze(
    profile.descriptors.map((descriptor) => projectDescriptor(descriptor, 'general')),
  );
  const selector: AgentGenerationProfile['selector'] =
    profile.mode === 'selectable' && selectorAvailable ? 'available' : profile.selector;
  return Object.freeze({
    ...profile,
    projection: 'general',
    descriptors,
    selector,
  });
}

/**
 * What an agent's model takes in the way of media, as `bureau.agents.list` serves it (COR-1548).
 * A client reads it to decide which files to offer, before any file is uploaded.
 */
export type AgentMediaCapabilities = {
  /** For each modality, whether the model takes it as input and whether it puts it out. */
  readonly modalities: Record<string, { input: boolean; output: boolean }>;
  /** The MIME families the model takes (`image`, `audio`, `video`, `document`, `text`, ...). */
  readonly mimeFamilies: string[];
  /** The per-part byte limits the model states. A modality absent here states none. */
  readonly mediaLimits: { modality: string; maxBytes: number }[];
};

/**
 * The media capabilities the model descriptors behind an agent state, or `null` when there are
 * none (an opaque generate the catalog cannot look inside, so it claims nothing). Several
 * descriptors, as a routed agent has, collapse to what every one of them takes and the smallest
 * limit any of them states, because a client cannot know which route a run will take and must not
 * offer a file one of them would refuse. Only per-part byte limits are carried; an aggregate or
 * duration limit has no use before the file exists.
 */
export function mediaCapabilitiesOf(
  descriptors: readonly BackendDescriptor[],
): AgentMediaCapabilities | null {
  const [first, ...rest] = descriptors;
  if (first === undefined) return null;
  const modalities: Record<string, { input: boolean; output: boolean }> = {};
  for (const modality of Object.keys(first.modalities)) {
    const every = (pick: 'input' | 'output') =>
      descriptors.every(
        (descriptor) =>
          (descriptor.modalities as Record<string, { input: boolean; output: boolean }>)[
            modality
          ]?.[pick] === true,
      );
    modalities[modality] = { input: every('input'), output: every('output') };
  }
  const mimeFamilies = first.mimeFamilies.filter((family) =>
    rest.every((descriptor) => descriptor.mimeFamilies.includes(family)),
  );
  const smallest = new Map<string, number>();
  for (const descriptor of descriptors) {
    for (const limit of descriptor.mediaLimits) {
      if (limit.scope !== 'per-part' || typeof limit.maxBytes !== 'number') continue;
      const known = smallest.get(limit.modality);
      smallest.set(
        limit.modality,
        known === undefined ? limit.maxBytes : Math.min(known, limit.maxBytes),
      );
    }
  }
  return {
    modalities,
    mimeFamilies,
    mediaLimits: [...smallest].map(([modality, maxBytes]) => ({ modality, maxBytes })),
  };
}
