/**
 * The file-based half of Bureau's agent catalog (COR-1524): the agents in a directory of
 * Markdown files, loaded, validated, kept current, and written back.
 *
 * ## Loading
 *
 * Every `*.md` file in the directory is an agent whose identifier is the filename without the
 * extension. Dotfiles, other extensions, and directories are ignored. A file that cannot be used
 * is still listed, with `state: 'invalid'` and a typed {@link AgentFileProblem}; it never runs and
 * it never affects another agent. A file's model must be in the deployment's model catalog and its
 * tools in the tool catalog it was given, and its identifier must not be a code-defined agent's.
 *
 * ## Watching
 *
 * The directory is watched, rescanned, and backed up by a poll by `watched-directory.ts`, which this
 * catalog shares with the workflow files (COR-1527).
 *
 * ## Revisions
 *
 * A ready file agent carries a `definitionRevision` that rises every time its file's content
 * changes (COR-1584), kept per identifier by `agent-revision-store.ts`. Each scan settles it after
 * the files are evaluated and before the scan's entries replace the previous ones, so by the time
 * `refresh()` resolves or `onChange` fires, the listing, the agent object's generation profile, and
 * the record all agree. Every scan reads the record of every ready file, so a catalog that missed
 * another process's edits agrees with the record on its next scan, and a revision that changed
 * with the content unchanged is a change `onChange` reports. A record that cannot be read or
 * written leaves the agent listed at its last known revision (1 if none is known) with a
 * diagnostic naming it, reported when the failure is new rather than on every scan, and the next
 * scan tries again.
 * The model catalog is not part of a file's content: a revalidation against a new model catalog
 * keeps the revision.
 *
 * @module agent-file-catalog
 */

import { randomUUID } from 'node:crypto';
import type { FSWatcher } from 'node:fs';

import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  type BackendDescriptor,
  createAgent,
  type GenerateFunction,
} from '@lostgradient/operative';
import { type ConditionalTextValueStore, MemoryStorage, textValueStore } from '@lostgradient/weft';
import type { Tool } from 'armorer';

import type { AnyRunnableAgent } from './agent-catalog';
import {
  AGENT_FILE_EXTENSION,
  AGENT_FILE_SIZE_LIMIT,
  type AgentFileDefinition,
  type AgentFileDefinitionInput,
  type AgentFileProblem,
  AgentSnapshotError,
  checkAgentIdentifier,
  decodeAgentFile,
  hashAgentFileBytes,
  parseAgentFile,
} from './agent-file';
import { type AgentFileOperations, nodeAgentFileOperations } from './agent-file-operations';
import { type AgentRevisionRecord, createAgentRevisionStore } from './agent-revision-store';
import {
  type AgentFileWriter,
  type AgentFileWriteResult,
  createAgentFileWriter,
} from './agent-file-writer';
import type { AgentSnapshot } from './agent-snapshot-store';
import type { ModelCatalogService } from './model-catalog-refresh';
import { ownerOrLocal } from './owner-of-record';
import { createWatchedDirectory } from './watched-directory';

/** One agent as an editor needs it: the listing, the file's exact text, and what it parses to. */
export interface AgentFileDetail extends AgentListing {
  /** The file's exact text, or `null` when its bytes could not be read as UTF-8. */
  readonly text: string | null;
  /** What the frontmatter and body parse to, or `null` when the file does not parse. */
  readonly definition: AgentFileDefinition | null;
}

/** One tool of the deployment's tool catalog, by the name an agent file uses. */
export interface AgentToolDescription {
  readonly name: string;
  readonly description: string;
}

/** The default agent every `createRun` without `agentName` runs. No file may take its name. */
export const RESERVED_DEFAULT_AGENT_IDENTIFIER = 'bureau';

/** One agent in {@link BureauAgentCatalog.list}, code-defined or from a file. */
export interface AgentListing {
  /** A code agent's map key, or a file agent's filename without `.md`. */
  readonly id: string;
  readonly source: 'code' | 'file';
  readonly state: 'ready' | 'invalid';
  /** The display label. For an invalid file, the identifier. */
  readonly name: string;
  readonly description: string | null;
  /** Whether the agent may be offered over the network. Always `false` for a code agent. */
  readonly published: boolean;
  /** The deployment's owner of record. A file has no owner field. */
  readonly owner: string;
  /** The SHA-256 of the file's bytes, for a file agent whose file could be read. */
  readonly definitionHash?: string;
  /**
   * The revision the agent's definition is at: the generation profile's revision for a
   * code-defined agent, and the persisted revision (`agent-revision-store.ts`) for a ready file
   * agent. Absent for an invalid file.
   */
  readonly definitionRevision?: number;
  /** Why an `invalid` file cannot run. */
  readonly problem?: AgentFileProblem;
}

/** What changed in one rescan, by identifier. */
export interface AgentCatalogChange {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
}

/** The tie between a file agent object and the definition it was built from. */
export interface FileAgentBinding {
  readonly id: string;
  readonly hash: string;
  readonly definition: AgentFileDefinition;
  /**
   * The definition revision the agent was built at, which a run keeps on its reference. Absent
   * for an agent rebuilt from a snapshot for a run that recorded none, so that rebuilding does not
   * record a revision 1 the run never had.
   */
  readonly definitionRevision?: number;
}

const fileAgentBindings = new WeakMap<object, FileAgentBinding>();

/** The definition `agent` was built from, when it is a file agent. */
export function readFileAgentBinding(agent: object): FileAgentBinding | undefined {
  return fileAgentBindings.get(agent);
}

export interface AgentFileCatalogOptions {
  readonly directory: string;
  /** Identifiers a file may not take: the code-defined agents and the default agent. */
  readonly reservedIdentifiers: ReadonlySet<string>;
  /** The deployment's tool catalog, by the name an agent file uses. */
  readonly tools: Readonly<Record<string, Tool>>;
  readonly modelCatalog: Pick<ModelCatalogService, 'catalog'>;
  /** Turns a catalog model into the function a run calls. The host holds the credentials. */
  readonly resolveGenerate: (descriptor: BackendDescriptor) => GenerateFunction;
  readonly runtime: RuntimeServices;
  /** Where watcher and scan failures are reported. */
  readonly diagnose: (message: string, cause: unknown) => void;
  readonly operations?: AgentFileOperations | undefined;
  /**
   * Where the revision record of each file agent lives (COR-1584). The Bureau's key-value store
   * when it has one, so the revision survives a restart and is shared by every process on the
   * store. Defaults to a store that lasts as long as the catalog.
   */
  readonly revisionStore?: ConditionalTextValueStore | undefined;
  /** Watch the directory. Defaults to `true`; `false` leaves reloading to {@link AgentFileCatalog.refresh}. */
  readonly watch?: boolean | undefined;
  /** How a directory is watched. Defaults to `fs.watch` without keeping the process alive; a test replaces it. */
  readonly openWatcher?:
    | ((path: string, listener: (event: string, filename: string | null) => void) => FSWatcher)
    | undefined;
}

export interface AgentFileCatalog extends AgentFileWriter {
  /** Every file in the directory that is an agent file, ready or invalid, by identifier. */
  list(): readonly AgentListing[];
  /**
   * One file agent as it is on disk now: its state and problem, its hash, its exact text, and
   * its parsed definition. `undefined` when the catalog lists no file with that identifier. The
   * hash, the text, the state, and the revision all describe the same bytes: a file changed since
   * the last scan is settled first.
   */
  detail(id: string): Promise<AgentFileDetail | undefined>;
  /** The deployment's tool catalog, by name, as an agent file may name its tools. */
  tools(): readonly AgentToolDescription[];
  /**
   * Set `published: true` in the file's frontmatter, if it still hashes to `expectedHash`, and
   * nothing else: every other key, the comments, and the body stay as they are. Writes nothing
   * for a file that is already published.
   */
  publish(id: string, options: { readonly expectedHash: string }): Promise<AgentFileWriteResult>;
  /** Set `published: false`, as {@link publish} sets `true`. */
  withdraw(id: string, options: { readonly expectedHash: string }): Promise<AgentFileWriteResult>;
  /** The agent for a file whose state is `ready`. */
  find(id: string): AnyRunnableAgent | undefined;
  /** Rescan the directory; resolves once the catalog reflects it. */
  refresh(): Promise<void>;
  /** Called after every rescan that added, changed, or removed an agent. Returns its unsubscribe. */
  onChange(listener: (change: AgentCatalogChange) => void): () => void;
  /**
   * Rebuild the agent a run recorded, from its snapshot, resolving the model and tools afresh. The
   * agent reports `revision`, the definition revision the run recorded (a snapshot is keyed by
   * content, so one snapshot can have been several revisions), or 1 when the caller has none, in
   * which case its binding records none either.
   */
  agentFromSnapshot(snapshot: AgentSnapshot, revision?: number): AnyRunnableAgent;
  /** Stop watching and wait for a scan in flight. */
  close(): Promise<void>;
}

interface FileEntry {
  readonly id: string;
  readonly hash: string | undefined;
  readonly revision: number;
  readonly definition?: AgentFileDefinition;
  /** The model the file named, resolved, kept so the agent can be rebuilt at another revision. */
  readonly descriptor?: BackendDescriptor;
  readonly agent?: AnyRunnableAgent;
  /** The revision `agent` was built at; this is not `revision`, which is the model catalog's. */
  readonly definitionRevision?: number;
  readonly problem?: AgentFileProblem;
}

/** The catalog row a file's `<provider>/<model-or-alias>` names, or why none does. */
export function resolveModelDescriptor(
  model: string,
  descriptors: readonly BackendDescriptor[],
): BackendDescriptor | AgentFileProblem {
  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) {
    return {
      code: 'unknown-model',
      message: `The model "${model}" must be written <provider>/<model>.`,
    };
  }
  const provider = model.slice(0, separator);
  const name = model.slice(separator + 1);
  const found = descriptors.find(
    (descriptor) =>
      descriptor.provider === provider &&
      descriptor.lifecycle !== 'retired' &&
      (descriptor.model === name || descriptor.aliases.some((alias) => alias.alias === name)),
  );
  return (
    found ?? {
      code: 'unknown-model',
      message: `The model "${model}" is not in the deployment's model catalog.`,
    }
  );
}

function isProblem(value: BackendDescriptor | AgentFileProblem): value is AgentFileProblem {
  return 'code' in value && 'message' in value && !('provider' in value);
}

function sameSignature(left: FileEntry, right: FileEntry): boolean {
  return (
    left.hash === right.hash &&
    left.problem?.code === right.problem?.code &&
    left.definitionRevision === right.definitionRevision
  );
}

/** How many times `detail` settles a file that changed under it before it serves the read as it is. */
const DETAIL_SETTLE_ATTEMPTS = 3;

export function createAgentFileCatalog(options: AgentFileCatalogOptions): AgentFileCatalog {
  const operations = options.operations ?? nodeAgentFileOperations;
  const { directory } = options;
  const owner = ownerOrLocal(undefined);
  const revisions = createAgentRevisionStore({
    store: options.revisionStore ?? textValueStore(new MemoryStorage()),
  });
  /**
   * The last record this catalog read or wrote for each identifier: what a file keeps while its
   * record cannot be read or written, and what an agent is first built at before a scan settles it.
   */
  const recorded = new Map<string, AgentRevisionRecord>();
  /** The files whose record could not be read or written, by the hash they last failed at. */
  const failedAt = new Map<string, string>();
  /**
   * The files whose write was deferred, by every record hash this catalog has deferred against
   * since it last adopted or wrote a record. A record that alternates between two hashes buys two
   * deferrals, not one per alternation.
   */
  const deferredAgainst = new Map<string, Set<string>>();

  function toListing(entry: FileEntry): AgentListing {
    const ready = entry.problem === undefined;
    return {
      id: entry.id,
      source: 'file',
      state: ready ? 'ready' : 'invalid',
      name: entry.definition?.name ?? entry.id,
      description: entry.definition?.description ?? null,
      published: ready && entry.definition?.published === true,
      owner,
      ...(entry.hash === undefined ? {} : { definitionHash: entry.hash }),
      ...(!ready || entry.definitionRevision === undefined
        ? {}
        : { definitionRevision: entry.definitionRevision }),
      ...(entry.problem === undefined ? {} : { problem: entry.problem }),
    };
  }

  function missingTools(names: readonly string[]): string[] {
    return names.filter((name) => !Object.hasOwn(options.tools, name));
  }

  /** The model and the tools, which a snapshot is rebuilt against as much as a file is. */
  function checkResources(
    definition: AgentFileDefinition,
  ): { readonly descriptor: BackendDescriptor } | { readonly problem: AgentFileProblem } {
    const resolved = resolveModelDescriptor(
      definition.model,
      options.modelCatalog.catalog().descriptors,
    );
    if (isProblem(resolved)) return { problem: resolved };
    const missing = missingTools(definition.tools);
    if (missing.length > 0) {
      return {
        problem: {
          code: 'unknown-tool',
          message: `The tools ${missing.map((name) => `"${name}"`).join(', ')} are not in the deployment's tool catalog.`,
          issues: missing.map((name) => ({
            path: 'tools',
            message: `"${name}" is not a registered tool`,
          })),
        },
      };
    }
    return { descriptor: resolved };
  }

  /** The checks that need the deployment, shared by a scan and a write. */
  function checkDeployment(
    id: string,
    definition: AgentFileDefinition,
  ): { readonly descriptor: BackendDescriptor } | { readonly problem: AgentFileProblem } {
    if (options.reservedIdentifiers.has(id) || id === RESERVED_DEFAULT_AGENT_IDENTIFIER) {
      return {
        problem: {
          code: 'shadows-code-agent',
          message: `"${id}" is the name of a code-defined agent, so a file cannot be that agent.`,
        },
      };
    }
    return checkResources(definition);
  }

  function buildAgent(
    id: string,
    hash: string,
    definition: AgentFileDefinition,
    descriptor: BackendDescriptor,
    revision: number | undefined,
  ): AnyRunnableAgent {
    const tools: Record<string, Tool> = {};
    for (const name of definition.tools) tools[name] = options.tools[name] as Tool;
    const instructions = definition.instructions.trim();
    const agent = createAgent({
      // The Bureau's own services: an agent rebuilt on every rescan must share its clock, not
      // mint a default instance and stamp its profile from the wall clock.
      runtime: options.runtime,
      name: id,
      ...(revision === undefined ? {} : { revision }),
      generate: options.resolveGenerate(descriptor),
      ...(definition.description === null ? {} : { description: definition.description }),
      ...(definition.skills.length === 0 ? {} : { skillDescriptors: definition.skills }),
      ...(instructions === '' ? {} : { instructions }),
      ...(Object.keys(tools).length === 0 ? {} : { tools }),
    }) as AnyRunnableAgent;
    fileAgentBindings.set(agent, {
      id,
      hash,
      definition,
      ...(revision === undefined ? {} : { definitionRevision: revision }),
    });
    return agent;
  }

  /** The problem a model that is in the catalog but cannot be set up leaves a file with. */
  function modelSetupProblem(definition: AgentFileDefinition, error: unknown): AgentFileProblem {
    const message = error instanceof Error ? error.message : String(error);
    return {
      code: 'unknown-model',
      message: `The model "${definition.model}" could not be set up: ${message}`,
    };
  }

  function evaluate(id: string, bytes: Uint8Array, hash: string, revision: number): FileEntry {
    const invalid = (problem: AgentFileProblem): FileEntry => ({
      id,
      hash,
      revision,
      problem,
    });
    const identifierProblem = checkAgentIdentifier(id);
    if (identifierProblem !== undefined) return invalid(identifierProblem);
    const text = decodeAgentFile(bytes);
    if (text === undefined) {
      return invalid({ code: 'not-utf8', message: 'The file is not valid UTF-8.' });
    }
    const parsed = parseAgentFile(id, text);
    if (!parsed.ok) return invalid(parsed.problem);
    const { definition } = parsed.file;
    const checked = checkDeployment(id, definition);
    if ('problem' in checked) return { id, hash, revision, definition, problem: checked.problem };
    try {
      // Built at the last revision this catalog knows; a changed file is rebuilt at its new one
      // when the scan settles (`settle`), before anything reads it.
      const definitionRevision = recorded.get(id)?.revision ?? 1;
      const agent = buildAgent(id, hash, definition, checked.descriptor, definitionRevision);
      return {
        id,
        hash,
        revision,
        definition,
        descriptor: checked.descriptor,
        agent,
        definitionRevision,
      };
    } catch (error) {
      return { id, hash, revision, definition, problem: modelSetupProblem(definition, error) };
    }
  }

  const tooLarge = (id: string, size: number, revision: number): FileEntry => ({
    id,
    hash: undefined,
    revision,
    problem: {
      code: 'file-too-large',
      message: `The file is ${size} bytes; an agent file may be at most ${AGENT_FILE_SIZE_LIMIT}.`,
    },
  });
  const unreadable = (id: string, error: unknown, revision: number): FileEntry => ({
    id,
    hash: undefined,
    revision,
    problem: {
      code: 'unreadable',
      message: `The file could not be read: ${error instanceof Error ? error.message : String(error)}`,
    },
  });

  /**
   * The revision of the file `id` at `hash`, read from the record on every scan: the record is the
   * authority, and another process on the same store may have raised it while this catalog was not
   * looking (a peer's edit and revert between two scans leaves this catalog's last-seen hash equal
   * to the file's while the record is two revisions on). Reading writes nothing when the record
   * already describes `hash`.
   *
   * A catalog adopts the record freely but writes a new revision only from a reading it can trust
   * is current. A scan reads the file, and settles it against the store later; a peer may edit and
   * record the new content in between. If the record describes other content while `hash` is what
   * this catalog itself last recorded, the scan may be that stale reading, and writing would record
   * a revert that never happened. The write is deferred once for each record hash: the revision is
   * kept for this scan, and the next scan decides (a stale reading does not repeat, and a genuine
   * revert is written then). A catalog that has recorded nothing yet (its first scan after a start)
   * has no last-recorded hash and never defers: it writes, so the revision it lists always names
   * the content it lists it with, as after a restart that follows an offline edit. The price is a
   * narrow race on that first scan, where a stale first read can over-count a peer's edit, and
   * never lowers a revision. A record that cannot be read or written leaves the last known
   * revision, or 1, and the next scan tries again; the failure is reported when it is new (the
   * first after a success, or at a different hash), not on every scan that finds the store still
   * down.
   */
  async function revisionOf(id: string, hash: string): Promise<number> {
    const known = recorded.get(id);
    try {
      const record = await revisions.advance(id, hash, {
        // Only a catalog whose own last-recorded hash is the file's can tell a stale reading from
        // a change: a reading that matches what it last recorded is the one a peer may have
        // overtaken. Once per record hash.
        defer: (current) =>
          known?.hash === hash && deferredAgainst.get(id)?.has(current.hash) !== true,
      });
      failedAt.delete(id);
      if (record.hash !== hash) {
        const against = deferredAgainst.get(id) ?? new Set<string>();
        against.add(record.hash);
        deferredAgainst.set(id, against);
        return known?.revision ?? record.revision;
      }
      deferredAgainst.delete(id);
      recorded.set(id, record);
      return record.revision;
    } catch (error) {
      const kept = known?.revision ?? 1;
      if (failedAt.get(id) !== hash) {
        failedAt.set(id, hash);
        options.diagnose(
          `The revision of agent file "${id}" could not be recorded, so it stays at ${kept}.`,
          error,
        );
      }
      return kept;
    }
  }

  /** The entry for a ready file, rebuilt at `revision`. */
  function atRevision(entry: FileEntry, revision: number): FileEntry {
    const { id, hash, definition, descriptor } = entry;
    if (hash === undefined || definition === undefined || descriptor === undefined) return entry;
    try {
      return {
        ...entry,
        agent: buildAgent(id, hash, definition, descriptor, revision),
        definitionRevision: revision,
      };
    } catch (error) {
      const { revision: catalogRevision } = entry;
      return {
        id,
        hash,
        revision: catalogRevision,
        definition,
        problem: modelSetupProblem(definition, error),
      };
    }
  }

  /** Settles the revision of every ready file in a scan (see the module documentation). */
  async function settleRevisions(
    loaded: ReadonlyMap<string, FileEntry>,
  ): Promise<ReadonlyMap<string, FileEntry>> {
    const settled = new Map(loaded);
    for (const [id, entry] of loaded) {
      if (entry.problem !== undefined || entry.hash === undefined) continue;
      const revision = await revisionOf(id, entry.hash);
      if (revision !== entry.definitionRevision) settled.set(id, atRevision(entry, revision));
    }
    return settled;
  }

  const directoryWatcher = createWatchedDirectory<FileEntry>({
    directory,
    label: 'agent directory',
    extension: AGENT_FILE_EXTENSION,
    sizeLimit: AGENT_FILE_SIZE_LIMIT,
    runtime: options.runtime,
    diagnose: options.diagnose,
    operations,
    ...(options.watch === undefined ? {} : { watch: options.watch }),
    ...(options.openWatcher === undefined ? {} : { openWatcher: options.openWatcher }),
    revision: () => options.modelCatalog.catalog().revision,
    evaluate,
    tooLarge,
    unreadable,
    sameSignature,
    settle: settleRevisions,
  });
  const { refresh } = directoryWatcher;

  const writer = createAgentFileWriter({
    directory,
    operations,
    validate(id, definition) {
      const checked = checkDeployment(id, definition);
      if ('problem' in checked) return checked.problem;
      // The host's resolver is asked here too, so a write is refused for a model it cannot set
      // up rather than committed and then listed invalid.
      try {
        options.resolveGenerate(checked.descriptor);
      } catch (error) {
        return modelSetupProblem(definition, error);
      }
      return undefined;
    },
    refresh,
    newTemporaryName: () => randomUUID(),
  });

  return {
    ...writer,

    publish: (id, publishOptions) => writer.setPublished(id, true, publishOptions),

    withdraw: (id, publishOptions) => writer.setPublished(id, false, publishOptions),

    list() {
      return [...directoryWatcher.entries().values()]
        .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .map(toListing);
    },

    async detail(id) {
      // A file edited since the last scan is settled first, so the text, the hash, and the
      // revision it returns describe one content: serving the new text at the previous scan's
      // revision would pair a revision with content it does not name. A file that keeps changing
      // under the reads is served as evaluated now, as an unsettled read.
      for (let attempt = 0; ; attempt += 1) {
        const known = directoryWatcher.entries().get(id);
        if (known === undefined) return undefined;
        const path = `${directory}/${id}${AGENT_FILE_EXTENSION}`;
        const revision = options.modelCatalog.catalog().revision;
        let entry: FileEntry;
        let text: string | undefined;
        try {
          const size = await operations.size(path);
          if (size === undefined) return undefined;
          if (size > AGENT_FILE_SIZE_LIMIT) {
            entry = tooLarge(id, size, revision);
          } else {
            const bytes = await operations.read(path);
            if (bytes === undefined) return undefined;
            const hash = hashAgentFileBytes(bytes);
            if (known.hash !== hash && attempt < DETAIL_SETTLE_ATTEMPTS) {
              await refresh();
              continue;
            }
            entry =
              known.hash === hash && known.revision === revision
                ? known
                : evaluate(id, bytes, hash, revision);
            text = decodeAgentFile(bytes);
          }
        } catch (error) {
          entry = unreadable(id, error, revision);
        }
        return { ...toListing(entry), text: text ?? null, definition: entry.definition ?? null };
      }
    },

    tools() {
      return Object.entries(options.tools)
        .map(([name, tool]) => ({ name, description: tool.description }))
        .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    },

    find(id) {
      return directoryWatcher.entries().get(id)?.agent;
    },

    refresh,

    onChange: directoryWatcher.onChange,

    agentFromSnapshot(snapshot, revision) {
      // Not `checkDeployment`: a run resumes as the file it began as even if a code agent has
      // since taken the name. Only what the agent needs to run is checked.
      const checked = checkResources(snapshot.definition);
      if ('problem' in checked) {
        throw new AgentSnapshotError(
          'snapshot-unresolvable',
          snapshot.id,
          snapshot.hash,
          `The snapshot of "${snapshot.id}" cannot be rebuilt: ${checked.problem.message}`,
        );
      }
      return buildAgent(
        snapshot.id,
        snapshot.hash,
        snapshot.definition,
        checked.descriptor,
        revision,
      );
    },

    close: directoryWatcher.close,
  };
}

/** The write input type, re-exported for the catalog's callers. */
export type { AgentFileDefinitionInput, AgentFileWriteResult };
