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
 * `fs.watch` is only a trigger. Any event marks the catalog dirty, and one single-flight loop
 * rescans the whole directory until nothing is dirty: bursts coalesce, and because a rescan is
 * idempotent it makes no difference whether a change arrived as an edit, a rename into place, a
 * delete, or the directory itself disappearing. There is no debounce interval. Because `fs.watch`
 * can drop an event, a once-a-second rescan ({@link AGENT_DIRECTORY_POLL_INTERVAL_MILLISECONDS})
 * backs it up; it reports nothing when nothing changed. A
 * directory that does not exist is an empty catalog, watched through its nearest existing
 * ancestor until it appears.
 *
 * @module agent-file-catalog
 */

import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  type BackendDescriptor,
  createAgent,
  type GenerateFunction,
} from '@lostgradient/operative';
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
import {
  type AgentFileWriter,
  type AgentFileWriteResult,
  createAgentFileWriter,
} from './agent-file-writer';
import type { AgentSnapshot } from './agent-snapshot-store';
import type { ModelCatalogService } from './model-catalog-refresh';
import { ownerOrLocal } from './owner-of-record';

/**
 * How often the catalog rescans the directory on its own, in milliseconds. `fs.watch` is the
 * primary signal, but it is lossy: on macOS a directory's creation went unreported in about one
 * of two hundred runs of a test that makes the directory and a file in it back to back. A rescan
 * is idempotent and finds nothing to report when nothing changed, so this safety net costs a
 * directory read and the agent files' bytes once a second, and bounds how long a change the
 * watcher missed can go unseen.
 */
export const AGENT_DIRECTORY_POLL_INTERVAL_MILLISECONDS = 1000;

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
  /** The agent for a file whose state is `ready`. */
  find(id: string): AnyRunnableAgent | undefined;
  /** Rescan the directory; resolves once the catalog reflects it. */
  refresh(): Promise<void>;
  /** Called after every rescan that added, changed, or removed an agent. Returns its unsubscribe. */
  onChange(listener: (change: AgentCatalogChange) => void): () => void;
  /** Rebuild the agent a run recorded, from its snapshot, resolving the model and tools afresh. */
  agentFromSnapshot(snapshot: AgentSnapshot): AnyRunnableAgent;
  /** Stop watching and wait for a scan in flight. */
  close(): Promise<void>;
}

interface FileEntry {
  readonly id: string;
  readonly hash: string | undefined;
  readonly modelRevision: number;
  readonly definition?: AgentFileDefinition;
  readonly agent?: AnyRunnableAgent;
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

function sameSignature(left: FileEntry | undefined, right: FileEntry | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.hash === right.hash &&
    left.problem?.code === right.problem?.code
  );
}

export function createAgentFileCatalog(options: AgentFileCatalogOptions): AgentFileCatalog {
  const operations = options.operations ?? nodeAgentFileOperations;
  const { directory } = options;
  const owner = ownerOrLocal(undefined);
  const openWatcher =
    options.openWatcher ?? ((path, listener) => watch(path, { persistent: false }, listener));
  let entries = new Map<string, FileEntry>();
  const listeners = new Set<(change: AgentCatalogChange) => void>();

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
  ): AnyRunnableAgent {
    const tools: Record<string, Tool> = {};
    for (const name of definition.tools) tools[name] = options.tools[name] as Tool;
    const instructions = definition.instructions.trim();
    const agent = createAgent({
      // The Bureau's own services: an agent rebuilt on every rescan must share its clock, not
      // mint a default instance and stamp its profile from the wall clock.
      runtime: options.runtime,
      name: id,
      generate: options.resolveGenerate(descriptor),
      ...(definition.description === null ? {} : { description: definition.description }),
      ...(definition.skills.length === 0 ? {} : { skillDescriptors: definition.skills }),
      ...(instructions === '' ? {} : { instructions }),
      ...(Object.keys(tools).length === 0 ? {} : { tools }),
    }) as AnyRunnableAgent;
    fileAgentBindings.set(agent, { id, hash, definition });
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

  function evaluate(id: string, bytes: Uint8Array, hash: string, modelRevision: number): FileEntry {
    const invalid = (problem: AgentFileProblem): FileEntry => ({
      id,
      hash,
      modelRevision,
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
    if ('problem' in checked)
      return { id, hash, modelRevision, definition, problem: checked.problem };
    try {
      const agent = buildAgent(id, hash, definition, checked.descriptor);
      return { id, hash, modelRevision, definition, agent };
    } catch (error) {
      return { id, hash, modelRevision, definition, problem: modelSetupProblem(definition, error) };
    }
  }

  async function loadEntry(
    id: string,
    name: string,
    modelRevision: number,
    previous: FileEntry | undefined,
  ): Promise<FileEntry | undefined> {
    const path = `${directory}/${name}`;
    try {
      const size = await operations.size(path);
      if (size === undefined) return undefined;
      if (size > AGENT_FILE_SIZE_LIMIT) {
        return {
          id,
          hash: undefined,
          modelRevision,
          problem: {
            code: 'file-too-large',
            message: `The file is ${size} bytes; an agent file may be at most ${AGENT_FILE_SIZE_LIMIT}.`,
          },
        };
      }
      const bytes = await operations.read(path);
      if (bytes === undefined) return undefined;
      const hash = hashAgentFileBytes(bytes);
      if (previous?.hash === hash && previous.modelRevision === modelRevision) return previous;
      return evaluate(id, bytes, hash, modelRevision);
    } catch (error) {
      return {
        id,
        hash: undefined,
        modelRevision,
        problem: {
          code: 'unreadable',
          message: `The file could not be read: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  async function scanOnce(): Promise<void> {
    const listing = await operations.listDirectory(directory);
    const modelRevision = options.modelCatalog.catalog().revision;
    const next = new Map<string, FileEntry>();
    for (const item of listing ?? []) {
      if (!item.isFile || item.name.startsWith('.') || !item.name.endsWith(AGENT_FILE_EXTENSION)) {
        continue;
      }
      const id = item.name.slice(0, -AGENT_FILE_EXTENSION.length);
      const entry = await loadEntry(id, item.name, modelRevision, entries.get(id));
      if (entry !== undefined) next.set(id, entry);
    }
    const added: string[] = [];
    const changed: string[] = [];
    const removed: string[] = [];
    for (const [id, entry] of next) {
      const before = entries.get(id);
      if (before === undefined) added.push(id);
      else if (!sameSignature(before, entry)) changed.push(id);
    }
    for (const id of entries.keys()) if (!next.has(id)) removed.push(id);
    entries = next;
    if (added.length + changed.length + removed.length === 0) return;
    for (const listener of listeners) {
      try {
        listener({ added, changed, removed });
      } catch (error) {
        options.diagnose('An agent catalog change listener threw.', error);
      }
    }
  }

  let dirty = false;
  let running: Promise<void> | undefined;
  let closed = false;
  /** The watchers that are open, by the path each watches. */
  const watchers = new Map<string, { readonly watcher: FSWatcher; readonly watches: string }>();
  let forceRearm = false;
  let pollTimer: unknown;

  /**
   * The nearest existing ancestor of the directory, and the name of the entry under it that leads
   * to the directory. Deleting a watched directory raises no event on the directory itself, so
   * the entry that holds it is watched too.
   */
  async function nearestExistingAncestor(): Promise<
    { readonly path: string; readonly entry: string } | undefined
  > {
    let child = directory;
    for (;;) {
      const parent = dirname(child);
      if (parent === child) return undefined;
      if ((await operations.size(parent)) !== undefined) {
        return { path: parent, entry: basename(child) };
      }
      child = parent;
    }
  }

  function open(path: string, entry: string | undefined): void {
    if (closed) return;
    try {
      const opened = openWatcher(path, (event, filename) => {
        const name = filename ?? null;
        if (entry !== undefined && name !== null && name !== entry) return;
        if (entry === undefined && event === 'rename' && name === null) forceRearm = true;
        trigger();
      });
      opened.on('error', (error) => {
        options.diagnose('The agent directory watcher failed.', error);
        forceRearm = true;
        trigger();
      });
      watchers.set(path, { watcher: opened, watches: entry ?? '' });
    } catch (error) {
      options.diagnose('The agent directory could not be watched.', error);
    }
  }

  async function arm(): Promise<void> {
    if (closed || options.watch === false) return;
    const wanted = new Map<string, string | undefined>();
    if ((await operations.size(directory)) !== undefined) wanted.set(directory, undefined);
    const ancestor = await nearestExistingAncestor();
    // `close()` may have landed while the directory was being looked at: open nothing then.
    if (closed) return;
    if (ancestor !== undefined) wanted.set(ancestor.path, ancestor.entry);
    for (const [path, held] of watchers) {
      const entry = wanted.get(path);
      if (
        !wanted.has(path) ||
        (entry ?? '') !== held.watches ||
        (forceRearm && path === directory)
      ) {
        held.watcher.close();
        watchers.delete(path);
      }
    }
    forceRearm = false;
    for (const [path, entry] of wanted) if (!watchers.has(path)) open(path, entry);
  }

  function startPolling(): void {
    if (pollTimer !== undefined || closed || options.watch === false) return;
    pollTimer = options.runtime.timers.setInterval(
      trigger,
      AGENT_DIRECTORY_POLL_INTERVAL_MILLISECONDS,
    );
  }

  async function loop(): Promise<void> {
    startPolling();
    for (;;) {
      // Decided and cleared in one synchronous step, so a `refresh()` is either behind a scan
      // that has not started yet or starts a loop of its own, never handed a loop that is over.
      if (!dirty || closed) {
        running = undefined;
        return;
      }
      dirty = false;
      // Armed before the scan, so a change after the scan reads the directory is not missed.
      try {
        await arm();
        await scanOnce();
      } catch (error) {
        options.diagnose('The agent directory could not be scanned.', error);
      }
    }
  }

  function trigger(): void {
    if (closed) return;
    dirty = true;
    running ??= loop();
  }

  function refresh(): Promise<void> {
    trigger();
    return running ?? Promise.resolve();
  }

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

    list() {
      return [...entries.values()]
        .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .map((entry): AgentListing => {
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
            ...(entry.problem === undefined ? {} : { problem: entry.problem }),
          };
        });
    },

    find(id) {
      return entries.get(id)?.agent;
    },

    refresh,

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    agentFromSnapshot(snapshot) {
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
      return buildAgent(snapshot.id, snapshot.hash, snapshot.definition, checked.descriptor);
    },

    async close() {
      closed = true;
      if (pollTimer !== undefined) options.runtime.timers.clearInterval(pollTimer);
      pollTimer = undefined;
      listeners.clear();
      // A scan in flight may be setting watchers up: it opens none once `closed` is set, and the
      // watchers it opened before are closed here, after it has stopped.
      await running;
      for (const held of watchers.values()) held.watcher.close();
      watchers.clear();
    },
  };
}

/** The write input type, re-exported for the catalog's callers. */
export type { AgentFileDefinitionInput, AgentFileWriteResult };
