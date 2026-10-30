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
 * The agent source (COR-1702) loads the files and reports changes outside Bureau; the directory
 * source watches, rescans, and backs the watch up with a poll. `definition-scanner.ts`, shared
 * with the workflow files (COR-1527), evaluates what the source loads.
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
 * ## References and compaction (COR-1866)
 *
 * A file's `references` name documents beside it (`agent-reference-documents.ts`). Every scan reads
 * them again, even for a file whose bytes did not change, because a document changes the agent
 * without changing the file. The revision identity is then not the file's hash but the identity
 * hash that folds in each document's digest (the file's own hash when there are no references), so
 * editing a document raises the `definitionRevision`; `definitionHash` and `expectedHash` stay the
 * file's bytes. While any agent has references the catalog also re-reads them at the source's own
 * poll interval (`AgentSource.referencePollMilliseconds`; none under a source that does not
 * watch) and rescans when one moved, because a source reports changes to agent files and not to
 * the documents they name. The source stamps each document (an ETag, or a file's size, inode and
 * modification time), and a document whose stamp is unchanged is not read again.
 *
 * A file with `compaction` enabled is `invalid` (`invalid-frontmatter`, path `compaction`) while
 * the deployment has no summarizer (`models.summarizer()`). Nothing tells the catalog the
 * `context.summarizerModel` setting changed, so the Bureau calls {@link AgentFileCatalog.revalidate}
 * when it does; a model catalog replace revalidates on its own.
 *
 * @module agent-file-catalog
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  type AgentSkillDescriptor,
  type BackendDescriptor,
  type ContextManagementOptions,
  createAgent,
  type GenerateFunction,
  type PermissionMode,
  shouldRetryProviderError,
  stopWhen,
} from '@lostgradient/operative';
import {
  type ConditionalTextValueStore,
  MemoryStorage,
  textValueStore,
} from '@lostgradient/storage';
import {
  type ApprovalStatus,
  type CapabilityTier,
  readToolShortDescription,
  resolveCapabilityTier,
  type Tool,
  type ToolSecretResolver,
} from 'armorer';

import type { AnyRunnableAgent } from './agent-catalog';
import {
  AGENT_COMPACTION_DEFAULT_THRESHOLD_PERCENT,
  AGENT_FILE_SIZE_LIMIT,
  type AgentFileDefinition,
  type AgentFileDefinitionInput,
  type AgentFileProblem,
  AgentFileError,
  AgentSnapshotError,
  agentFileInputOf,
  checkAgentIdentifier,
  decodeAgentFile,
  hashAgentFileBytes,
  parseAgentFile,
  serializeNewAgentFile,
} from './agent-file';
import {
  type AgentReferenceDocument,
  digestsOf,
  loadReferenceDocuments,
  type ReferenceCache,
  referenceCacheKey,
  referenceIdentity,
  renderInstructions,
} from './agent-reference-documents';
import { createFileAgentCompactor } from './file-agent-compaction';
import { isNamespacedIdentifier } from './namespaced-identifier';
import { createFileAgentGenerate } from './file-agent-generate';
import { costBudgetOptions, toolboxBudgetOf, usdPricingOfRow } from './file-agent-cost-budget';
import { guardrailsOfPreset } from './guardrail-presets';
import { createToolApprovalHooks, defaultToolApproval } from './tool-approval';
import { type AgentRevisionRecord, createAgentRevisionStore } from './agent-revision-store';
import {
  type AgentFileSaveOptions,
  type AgentFileWriter,
  type AgentFileWriteResult,
  createAgentFileWriter,
} from './agent-file-writer';
import {
  type AgentVersionInput,
  type AgentVersionRecord,
  createAgentVersionStore,
} from './agent-version-store';
import type { AgentSnapshot } from './agent-snapshot-store';
import type { Models } from './models/create-models';
import { ownerOrLocal } from './owner-of-record';
import { createDefinitionScanner, type DefinitionScannerHealth } from './definition-scanner';
import type { AgentSource, DefinitionEntry } from './sources/definition-source';

/**
 * What a code-defined agent states about itself, read-only (COR-1818), so an editor can show it and
 * offer to duplicate it into an agent file. It is read from the agent object, never from a file:
 * an agent that is not a `createAgent` result states less, and each statement it does not make is
 * `null` or empty here.
 */
export interface AgentCodeDefinition {
  /** The agent's display name. */
  readonly name: string;
  /** The agent's description, or `null` when it declares none. */
  readonly description: string | null;
  /**
   * The model the agent's next step would use with no override, written `<provider>/<model>`, or
   * `null` when the agent's generate attaches no single model (a scripted or routed agent).
   */
  readonly model: string | null;
  /** The models a session of the agent may be switched to, written `<provider>/<model>`. */
  readonly models: readonly string[];
  /** The names the model calls the agent's tools by (`StandaloneAgent.toolNames`). */
  readonly tools: readonly string[];
  /**
   * The executable skills the agent can activate, by name: the skills available in the catalog
   * revision it was composed with (`createAgentSkills`). Not `skillDescriptors`, which only
   * describe the agent.
   */
  readonly skills: readonly string[];
  /** The descriptive Agent Card skills the agent declares. */
  readonly skillDescriptors: readonly AgentSkillDescriptor[];
  /** The system instructions the agent was created with, or `null` when it has none. */
  readonly instructions: string | null;
}

/** One agent as an editor needs it: the listing, the file's exact text, and what it parses to. */
export interface AgentFileDetail extends AgentListing {
  /**
   * For a code-defined agent, what it states about itself; absent for a file agent, whose
   * {@link AgentFileDetail.definition} is the parsed file.
   */
  readonly codeDefinition?: AgentCodeDefinition | undefined;
  /** The file's exact text, or `null` when its bytes could not be read as UTF-8. */
  readonly text: string | null;
  /** What the frontmatter and body parse to, or `null` when the file does not parse. */
  readonly definition: AgentFileDefinition | null;
}

/** One tool of the deployment's tool catalog, by the name an agent file uses. */
export interface AgentToolDescription {
  readonly name: string;
  /** The tool's model-facing description: a prompt, which can run to several paragraphs. */
  readonly description: string;
  /**
   * The one line a screen shows for the tool: its `metadata.shortDescription`, or `null` when it
   * declares none, in which case a screen derives a line from `description`.
   */
  readonly shortDescription: string | null;
  /**
   * The tool's input as a JSON Schema (draft 2020-12, the `input` side), or `null` when the schema
   * cannot be written as one. Another process never receives a function, so a screen that shows
   * what the tool takes reads this.
   */
  readonly inputSchema: Readonly<Record<string, unknown>> | null;
  /**
   * What the tool may technically do, from the tool's own `metadata` (`readOnly`, `mutates`,
   * `dangerous`) or its `readonly`/`mutating`/`dangerous` tags, or `null` when it declares none:
   * Armorer never reads an unclassified tool as read-only.
   */
  readonly tier: CapabilityTier | null;
  /**
   * What happens by default when an agent calls the tool: the rule a file agent's tool follows
   * when its `toolApproval` says nothing (COR-1913, `TOOL_APPROVAL_DEFAULT_MODE`, `on-changes`)
   * applied to {@link AgentToolDescription.tier}, so `allow` for a read-only tool and `ask` for a
   * tool that changes something, is dangerous, or declares nothing. A file's own `toolApproval`
   * entry for the tool replaces it for that agent: this is the default, not any one agent's setting.
   */
  readonly defaultApproval: Exclude<ApprovalStatus, 'deny'>;
  /**
   * Where the tool comes from: `bureau` for a tool Bureau adds itself (the settings and workflow
   * tools), `host` for a tool the host passed in `agentSource.tools`.
   */
  readonly source: 'host' | 'bureau';
  /**
   * The identifiers of the agents that use the tool now, sorted: a ready agent file that lists it
   * in `tools`, and a code-defined agent that names it. Read from the definitions as they stand,
   * so it changes when a file does.
   */
  readonly users: readonly string[];
}

/**
 * A tool's input schema, capability tier, and default approval. The schema is the one Armorer
 * serializes the tool with; a tool whose schema cannot be written as JSON Schema reports `null`
 * rather than failing the whole catalog.
 */
export function describeToolCapability(
  tool: Pick<Tool, 'metadata' | 'tags' | 'toJSON'>,
): Pick<AgentToolDescription, 'inputSchema' | 'tier' | 'defaultApproval'> {
  const tier = resolveCapabilityTier(tool.metadata, tool.tags);
  let inputSchema: Readonly<Record<string, unknown>> | null;
  try {
    inputSchema = { ...tool.toJSON().input };
  } catch {
    inputSchema = null;
  }
  return {
    inputSchema,
    tier: tier ?? null,
    defaultApproval: defaultToolApproval(tier),
  };
}

/** The reserved name of the implicit Bureau-wide agent, which no longer exists. No file may take its name. */
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
  /**
   * Whether the agent opts into A2A: a file agent's `a2a` frontmatter. Always `false` for a code
   * agent, which opts in through the handler's A2A allowlist.
   */
  readonly a2a: boolean;
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
  /**
   * COR-1873 — the plugin that ships the agent, for a file of a plugin's read-only layer
   * (`plugin:name`). Such a file cannot be written; `duplicate` copies it into the owner's source.
   * Absent for a code agent and an owner's file.
   */
  readonly plugin?: string;
}

/** The plugin a listed file belongs to: the namespace of a `plugin:name` the identifier check accepted. */
function pluginOfListing(id: string, problem: AgentFileProblem | undefined): string | undefined {
  if (problem?.code === 'invalid-identifier' || !isNamespacedIdentifier(id)) return undefined;
  return id.slice(0, id.indexOf(':'));
}

/** What changed in one rescan, by identifier. */
export interface AgentCatalogChange {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  /** Of `added` and `changed`, the identifiers whose file is invalid now and cannot run. */
  readonly rejected: readonly string[];
}

/** The tie between a file agent object and the definition it was built from. */
export interface FileAgentBinding {
  readonly id: string;
  /**
   * The agent's identity hash: the SHA-256 of the file's bytes, or, for an agent with references,
   * the hash that also folds in the digest of each document it read. A snapshot is keyed by it.
   */
  readonly hash: string;
  readonly definition: AgentFileDefinition;
  /** The documents the definition's `references` named, as the agent was given them. */
  readonly referenceDocuments?: readonly AgentReferenceDocument[];
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
  /** Where the agent files come from and are written back to. */
  readonly source: AgentSource;
  /** Identifiers a file may not take: the code-defined agents and the default agent. */
  readonly reservedIdentifiers: ReadonlySet<string>;
  /** The deployment's tool catalog, by the name an agent file uses. */
  readonly tools: Readonly<Record<string, Tool>>;
  /**
   * The names in {@link AgentFileCatalogOptions.tools} that Bureau added itself rather than the
   * host (`AgentToolDescription.source`). Omitted, every tool is the host's.
   */
  readonly bureauToolNames?: ReadonlySet<string> | undefined;
  readonly models: Pick<Models, 'catalog' | 'summarizer'>;
  /** Turns a catalog model into the function a run calls. The host holds the credentials. */
  readonly resolveGenerate: (descriptor: BackendDescriptor) => GenerateFunction;
  readonly runtime: RuntimeServices;
  /**
   * The secret that signs the tool approvals a file agent raises (COR-1913), which must be the same
   * across restarts and across the processes that resolve them. Without one an approval is raised
   * unsigned and `reviews.resolve` refuses to approve it (`NOT_CONFIGURED`); it can only be denied.
   */
  readonly approvalSecret?: string | undefined;
  /**
   * The tools a person allowed for the rest of the chat a run belongs to (COR-1828), read when the
   * run's tool call is decided. Omitted, nothing is remembered. A run whose context names no run id
   * has no chat to read, so its calls ask as the agent file says.
   */
  readonly rememberedTools?: ((runId: string) => Promise<ReadonlySet<string>>) | undefined;
  /**
   * The permission mode of the chat a run belongs to (COR-1936), read when the run's tool call is
   * decided, so a steer applies from the next call; `undefined` for a run that belongs to no chat.
   * A rejection is read as `read-only`. Omitted, no run has a mode and each tool's own setting
   * decides.
   */
  readonly permissionModeOfRun?:
    ((runId: string) => Promise<PermissionMode | undefined>) | undefined;
  /**
   * Reads a secret answer back for a tool that declares `acceptsSecrets` (COR-1920). A file
   * agent's per-run toolbox is built here, so it is handed the resolver the Bureau's own toolbox
   * has; without one such a tool sees no secret.
   */
  readonly secretResolver?: ToolSecretResolver | undefined;
  /** Where watcher and scan failures are reported. */
  readonly diagnose: (message: string, cause: unknown) => void;
  /**
   * Where the revision record of each file agent lives (COR-1584). The Bureau's key-value store
   * when it has one, so the revision survives a restart and is shared by every process on the
   * store. Defaults to a store that lasts as long as the catalog.
   */
  readonly revisionStore?: ConditionalTextValueStore | undefined;
  /**
   * The definition revisions of an agent that a retained run references (COR-1815), which the
   * pruning of saved versions must keep. Omitted, no revision is protected.
   */
  readonly retainedRevisions?: ((id: string) => Promise<ReadonlySet<number>>) | undefined;
}

/** What the saved versions of file agents offer (COR-1815). */
export interface AgentFileVersions {
  /** The stored versions of `id`, newest revision first. Empty for an agent with none. */
  list(id: string): Promise<readonly AgentVersionRecord[]>;
  /**
   * Write the definition of the version of `id` at `revision` back through the writer, as a new
   * revision (and so a new version) saved by `options.savedBy`, if the file still hashes to
   * `options.expectedHash`. The version's `references` list is restored with the rest of the
   * definition, but a document is not: it is whatever the path names when the file is read
   * again, and the version's `referenceDigests` say what it was. `examples` are not restored
   * either: they stay as the file has them. Fails with `AgentFileError` `agent-version-not-found` when no
   * such version is stored, with `AgentFileConflictError` when the file has moved, and with
   * `AgentFileError` `unknown-model`, `unknown-tool`, `missing-reference` or
   * `reference-too-large` when the definition no longer resolves against the deployment, and with
   * `invalid-frontmatter` when it enables compaction and no summarizer is configured; each
   * writes nothing. Restoring the definition the file already has
   * writes nothing and returns the file's current hash.
   */
  restore(
    id: string,
    revision: number,
    options: { readonly expectedHash: string } & AgentFileSaveOptions,
  ): Promise<AgentFileWriteResult>;
}

export interface AgentFileCatalog extends AgentFileWriter {
  /** The saved versions of the file agents (COR-1815). */
  readonly versions: AgentFileVersions;
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
  /** The agent for a file whose state is `ready`. */
  find(id: string): AnyRunnableAgent | undefined;
  /**
   * Builds an agent from `definition` as `create` would, and writes nothing (COR-1911): the same
   * serialization, size limit, frontmatter schema and deployment checks (reserved names, the model,
   * the tools, `toolApproval`, compaction), so a definition that would not load as a file is
   * refused with the same field-named {@link AgentFileError} and one that would is built. The
   * agent is not in the catalog, is not tied to a file or a snapshot, and exists only as long as
   * the caller holds it. `id` names the agent in the run records it makes; it is not checked as a
   * file identifier, because no file is named for it. A definition that lists `references` is
   * refused (`references`), since the documents are read from beside a file and there is none.
   */
  ephemeral(id: string, definition: AgentFileDefinitionInput): AnyRunnableAgent;
  /** Rescan the directory; resolves once the catalog reflects it. */
  refresh(): Promise<void>;
  /**
   * Check every file again against the deployment as it is now, whether or not the model catalog
   * changed, and resolve once the catalog reflects it. The Bureau calls it when the summarizer
   * setting changes, which turns the files that enable compaction valid or invalid. A rescan
   * keeps a file's revision when the file did not change.
   */
  revalidate(): Promise<void>;
  /** When the directory was last scanned and the message of that scan's error (COR-1731). */
  health(): DefinitionScannerHealth;
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
  /**
   * The identity hash `agent` was built at, set only for a file with references: `hash`, folded
   * with the digest of each document read. A file without references has none, and its identity
   * is `hash`.
   */
  readonly identity?: string;
  /** The documents `agent` was given, for a file with references. */
  readonly documents?: readonly AgentReferenceDocument[];
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

/**
 * The catalog rows a file agent allows: the rows its `models` entries name, in the order listed
 * and without repeats, or every row that is not retired when it lists none. An entry the catalog
 * does not hold is left out; it is not an error.
 */
export function allowedDescriptorsOfFileAgent(
  models: readonly string[] | undefined,
  descriptors: readonly BackendDescriptor[],
): BackendDescriptor[] {
  if (models === undefined) return descriptors.filter((row) => row.lifecycle !== 'retired');
  const rows: BackendDescriptor[] = [];
  for (const entry of models) {
    const resolved = resolveModelDescriptor(entry, descriptors);
    if (!isProblem(resolved) && !rows.includes(resolved)) rows.push(resolved);
  }
  return rows;
}

function isProblem(value: BackendDescriptor | AgentFileProblem): value is AgentFileProblem {
  return 'code' in value && 'message' in value && !('provider' in value);
}

function sameSignature(left: FileEntry, right: FileEntry): boolean {
  return (
    left.hash === right.hash &&
    left.identity === right.identity &&
    left.problem?.code === right.problem?.code &&
    // A problem that names another path (a second missing reference) is a change a listener hears.
    left.problem?.message === right.problem?.message &&
    left.definitionRevision === right.definitionRevision
  );
}

/** How many times `detail` settles a file that changed under it before it serves the read as it is. */
const DETAIL_SETTLE_ATTEMPTS = 3;

/** Whether `entry` is a file whose references are read on every scan. */
function hasReferences(entry: FileEntry): boolean {
  return (
    entry.hash !== undefined &&
    entry.descriptor !== undefined &&
    entry.definition?.references !== undefined &&
    entry.definition.references.length > 0
  );
}

export function createAgentFileCatalog(options: AgentFileCatalogOptions): AgentFileCatalog {
  const owner = ownerOrLocal(undefined);
  /** The documents read last, by path, so a reading that finds one unchanged does not fetch it. */
  const referenceCache: ReferenceCache = new Map();
  /**
   * What the scanner compares an entry's deployment state with. It rises when the model catalog's
   * revision moves and when {@link AgentFileCatalog.revalidate} is called, so a change the model
   * catalog does not carry (the summarizer setting) still re-evaluates every file.
   */
  let validationEpoch = 0;
  let seenCatalogRevision = options.models.catalog().revision;
  function deploymentRevision(): number {
    const current = options.models.catalog().revision;
    if (current !== seenCatalogRevision) {
      seenCatalogRevision = current;
      validationEpoch += 1;
    }
    return validationEpoch;
  }
  const revisionRecords = options.revisionStore ?? textValueStore(new MemoryStorage());
  const revisions = createAgentRevisionStore({ store: revisionRecords });
  const versionStore = createAgentVersionStore({ store: revisionRecords });
  /**
   * Who is saving a file through the writer, by identifier and the hash its bytes will have, from
   * before the bytes reach the source until the write has settled. The scan that raises the
   * revision reads it to name the saver on the version; a hash with no entry was written outside
   * the writer.
   */
  const savers = new Map<string, string>();
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
    const plugin = pluginOfListing(entry.id, entry.problem);
    return {
      id: entry.id,
      source: 'file',
      state: ready ? 'ready' : 'invalid',
      name: entry.definition?.name ?? entry.id,
      description: entry.definition?.description ?? null,
      a2a: ready && entry.definition?.a2a === true,
      owner,
      ...(entry.hash === undefined ? {} : { definitionHash: entry.hash }),
      ...(!ready || entry.definitionRevision === undefined
        ? {}
        : { definitionRevision: entry.definitionRevision }),
      ...(entry.problem === undefined ? {} : { problem: entry.problem }),
      ...(plugin === undefined ? {} : { plugin }),
    };
  }

  function missingTools(names: readonly string[]): string[] {
    return names.filter((name) => !Object.hasOwn(options.tools, name));
  }

  /** The model and the tools, which a snapshot is rebuilt against as much as a file is. */
  function checkResources(
    definition: AgentFileDefinition,
  ): { readonly descriptor: BackendDescriptor } | { readonly problem: AgentFileProblem } {
    const resolved = resolveModelDescriptor(definition.model, options.models.catalog().descriptors);
    if (isProblem(resolved)) return { problem: resolved };
    if (definition.costBudget !== undefined && usdPricingOfRow(resolved) === undefined) {
      return {
        problem: {
          code: 'invalid-frontmatter',
          message: `The model "${definition.model}" has no price in US dollars in the model catalog, so the file's costBudget could not be enforced. Use a model that has one, or remove costBudget.`,
          issues: [
            {
              path: 'costBudget',
              message: `"${definition.model}" has no price in US dollars in the model catalog`,
            },
          ],
        },
      };
    }
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
    const unlisted = Object.keys(definition.toolApproval ?? {}).filter(
      (name) => !definition.tools.includes(name),
    );
    if (unlisted.length > 0) {
      return {
        problem: {
          code: 'unknown-approval-tool',
          message: `toolApproval names ${unlisted.map((name) => `"${name}"`).join(', ')}, which the file's tools do not list. Add the tool to tools, or remove its toolApproval entry.`,
          issues: unlisted.map((name) => ({
            path: `toolApproval.${name}`,
            message: `"${name}" is not in tools`,
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
    const resources = checkResources(definition);
    if ('problem' in resources) return resources;
    if (definition.compaction?.enabled === true && options.models.summarizer() === undefined) {
      const message =
        'Compaction is enabled, but the deployment has no summarizer model. Set the context.summarizerModel setting to a model in the catalog, or turn compaction off.';
      return {
        problem: {
          code: 'invalid-frontmatter',
          message,
          issues: [{ path: 'compaction', message }],
        },
      };
    }
    return resources;
  }

  /** What a run needs to compact its conversation, or nothing when the file does not ask for it. */
  function contextManagementOf(
    id: string,
    definition: AgentFileDefinition,
    descriptor: BackendDescriptor,
  ): { readonly contextManagement: ContextManagementOptions } | Record<string, never> {
    const { compaction } = definition;
    const maxTokens = descriptor.contextWindowTokens;
    if (compaction?.enabled !== true || !Number.isFinite(maxTokens) || maxTokens <= 0) return {};
    const percent = compaction.thresholdPercent ?? AGENT_COMPACTION_DEFAULT_THRESHOLD_PERCENT;
    return {
      contextManagement: {
        // The default model's window; a session switched to a smaller model leans on Operative's
        // overflow recovery.
        maxTokens,
        compactionThreshold: Math.floor((maxTokens * percent) / 100),
        onCompact: createFileAgentCompactor({
          agentId: id,
          diagnose: options.diagnose,
          summarizer: () => {
            const row = options.models.summarizer();
            return row === undefined ? undefined : options.resolveGenerate(row);
          },
        }),
      },
    };
  }

  function buildAgent(
    id: string,
    hash: string,
    definition: AgentFileDefinition,
    descriptor: BackendDescriptor,
    revision: number | undefined,
    documents: readonly AgentReferenceDocument[] = [],
    bind = true,
  ): AnyRunnableAgent {
    const tools: Record<string, Tool> = {};
    for (const name of definition.tools) {
      tools[name] = (Object.hasOwn(options.tools, name) ? options.tools[name] : undefined) as Tool;
    }
    const instructions = renderInstructions(definition.instructions.trim(), documents);
    const agent = createAgent({
      // The Bureau's own services: an agent rebuilt on every rescan must share its clock, not
      // mint a default instance and stamp its profile from the wall clock.
      runtime: options.runtime,
      name: id,
      ...(revision === undefined ? {} : { revision }),
      // COR-1559: a file agent is selectable. Its generate picks each step's model from that
      // step's steering, and its profile offers the models the file allows against the catalog now.
      generate: createFileAgentGenerate({
        defaultGenerate: options.resolveGenerate(descriptor),
        defaultDescriptor: descriptor,
        allowed: () =>
          allowedDescriptorsOfFileAgent(definition.models, options.models.catalog().descriptors),
        resolveGenerate: options.resolveGenerate,
      }),
      allowedCandidates: allowedDescriptorsOfFileAgent(
        definition.models,
        options.models.catalog().descriptors,
      ).map((row) => ({ provider: row.provider, model: row.model })),
      ...(definition.description === null ? {} : { description: definition.description }),
      ...(definition.skillDescriptors.length === 0
        ? {}
        : { skillDescriptors: definition.skillDescriptors }),
      ...(instructions === '' ? {} : { instructions }),
      ...(Object.keys(tools).length === 0 ? {} : { tools }),
      // Built for each run (COR-1913): the hook is the agent's per-tool approval, and the secret
      // signs the approvals it raises, so a restart can still resolve one.
      toolboxOptions: (context) => {
        const runId = context?.runId;
        const rememberedTools = options.rememberedTools;
        const permissionModeOfRun = options.permissionModeOfRun;
        return {
          // Only the agent's own tools: the toolbox also holds the tools Bureau adds to a run.
          policy: createToolApprovalHooks(definition.toolApproval, {
            tools: definition.tools,
            // A tool a person allowed for the rest of this chat skips its `on-changes` ask.
            ...(rememberedTools === undefined || runId === undefined
              ? {}
              : {
                  remembered: async (toolName: string) => {
                    const granted = await rememberedTools(runId);
                    return granted.has(toolName);
                  },
                }),
            // The chat's permission mode, read for each call so a steer applies from the next.
            ...(permissionModeOfRun === undefined || runId === undefined
              ? {}
              : {
                  permissionMode: async () => (await permissionModeOfRun(runId)) ?? 'on-changes',
                }),
          }),
          // COR-1915: the toolbox is built for this run, so its counters are the run's own. It
          // counts every call the run makes through it, the tools Bureau adds included.
          ...(definition.toolBudget === undefined
            ? {}
            : { budget: toolboxBudgetOf(definition.toolBudget) }),
          ...(options.approvalSecret === undefined
            ? {}
            : { approvalSecret: options.approvalSecret }),
          ...(options.secretResolver === undefined
            ? {}
            : { secretResolver: options.secretResolver }),
        };
      },
      // A call that asks parks the run on the approval: the answer comes from a person, not the
      // model, and a model that is told "action required" would only ask again.
      stopWhen: [stopWhen.pendingApproval(), stopWhen.noToolCalls()],
      ...(definition.guardrails === undefined
        ? {}
        : { guardrails: guardrailsOfPreset(definition.guardrails) }),
      ...(definition.costBudget === undefined
        ? {}
        : costBudgetOptions(
            definition.costBudget,
            descriptor,
            allowedDescriptorsOfFileAgent(definition.models, options.models.catalog().descriptors),
          )),
      ...(definition.stepLimit === undefined ? {} : { maximumSteps: definition.stepLimit }),
      ...contextManagementOf(id, definition, descriptor),
      ...(definition.retry === undefined
        ? {}
        : {
            retry: {
              attempts: definition.retry.attempts,
              delay: definition.retry.delayMilliseconds ?? 0,
              jitter: definition.retry.jitter ?? false,
              shouldRetry: shouldRetryProviderError,
            },
          }),
    }) as AnyRunnableAgent;
    // An agent that is not tied to a file (`ephemeral`) has no binding, so a run of it records no
    // snapshot and no hash: nothing about it outlives the run's own records.
    if (bind) {
      fileAgentBindings.set(agent, {
        id,
        hash,
        definition,
        ...(documents.length === 0 ? {} : { referenceDocuments: documents }),
        ...(revision === undefined ? {} : { definitionRevision: revision }),
      });
    }
    return agent;
  }

  /**
   * `problem` with each issue naming the field at fault, as a person editing a definition needs:
   * an unknown tool by its place in `tools` (`tools.1`), and an unknown model as `model`. A file's
   * problem names `tools` as a whole, because a file has no list to point into.
   */
  function fieldNamed(
    problem: AgentFileProblem,
    definition: AgentFileDefinition,
  ): AgentFileProblem {
    const named = (issues: readonly { path: string; message: string }[]): AgentFileProblem => ({
      ...problem,
      message: `The definition cannot be used: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
      issues,
    });
    if (problem.code === 'unknown-model' && problem.issues === undefined) {
      return named([{ path: 'model', message: problem.message }]);
    }
    if (problem.code === 'unknown-tool') {
      return named(
        definition.tools.flatMap((name, index) =>
          missingTools([name]).length === 0
            ? []
            : [{ path: `tools.${index}`, message: `"${name}" is not a registered tool` }],
        ),
      );
    }
    return problem;
  }

  /** The problem a model that is in the catalog but cannot be set up leaves a file with. */
  function modelSetupProblem(definition: AgentFileDefinition, error: unknown): AgentFileProblem {
    const message = error instanceof Error ? error.message : String(error);
    return {
      code: 'unknown-model',
      message: `The model "${definition.model}" could not be set up: ${message}`,
    };
  }

  function evaluate(
    id: string,
    bytes: Uint8Array,
    hash: string,
    revision: number,
    plugin: string | undefined,
  ): FileEntry {
    const invalid = (problem: AgentFileProblem): FileEntry => ({
      id,
      hash,
      revision,
      problem,
    });
    const identifierProblem = checkAgentIdentifier(id, plugin);
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
    // The documents are read when the scan settles, which is async: the entry waits for them.
    if (definition.references !== undefined) {
      return { id, hash, revision, definition, descriptor: checked.descriptor };
    }
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
  async function revisionOf(id: string, entry: FileEntry): Promise<number> {
    const { definition } = entry;
    // The record describes the identity hash; a writer declares the file's own bytes (`savers`).
    const fileHash = entry.hash ?? '';
    const hash = entry.identity ?? fileHash;
    if (definition === undefined) return recorded.get(id)?.revision ?? 1;
    const known = recorded.get(id);
    try {
      const record = await revisions.advance(id, hash, {
        version: versionOf(id, fileHash, definition, entry.documents),
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

  /**
   * The version to record if the revision is raised for `hash`: the definition, when, and by whom.
   * A hash no writer declared is an edit made outside it, and has no saver.
   */
  function versionOf(
    id: string,
    hash: string,
    definition: AgentFileDefinition,
    documents: readonly AgentReferenceDocument[] | undefined,
  ): AgentVersionInput {
    const { retainedRevisions } = options;
    return {
      definition,
      ...(documents === undefined || documents.length === 0
        ? {}
        : { referenceDigests: digestsOf(documents) }),
      savedAt: options.runtime.clock.nowISO(),
      savedBy: savers.get(`${id}:${hash}`) ?? null,
      owner,
      ...(retainedRevisions === undefined
        ? {}
        : { retainedRevisions: () => retainedRevisions(id) }),
    };
  }

  /** The entry for a ready file, rebuilt at `revision`. */
  function atRevision(entry: FileEntry, revision: number): FileEntry {
    const { id, hash, definition, descriptor } = entry;
    if (hash === undefined || definition === undefined || descriptor === undefined) return entry;
    try {
      return {
        ...entry,
        agent: buildAgent(
          id,
          entry.identity ?? hash,
          definition,
          descriptor,
          revision,
          entry.documents,
        ),
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

  /**
   * `entry`, a file with references, with the documents read now: the entry itself when they are
   * what it was built with, otherwise an entry that is `invalid` (a document is missing, unreadable
   * or too large) or ready, with its agent built at the last revision this catalog knows. The
   * revision is settled afterwards, by {@link settleRevisions}.
   */
  async function withReferences(entry: FileEntry): Promise<FileEntry> {
    const { id, hash, revision, definition, descriptor } = entry;
    if (hash === undefined || definition?.references === undefined || descriptor === undefined) {
      return entry;
    }
    const loaded = await loadReferenceDocuments(
      options.source,
      definition.references,
      referenceCache,
      id,
    );
    if (!loaded.ok) return { id, hash, revision, definition, descriptor, problem: loaded.problem };
    const identity = referenceIdentity(hash, loaded.documents);
    if (entry.agent !== undefined && entry.identity === identity) return entry;
    const definitionRevision = recorded.get(id)?.revision ?? 1;
    try {
      return {
        id,
        hash,
        revision,
        definition,
        descriptor,
        identity,
        documents: loaded.documents,
        agent: buildAgent(
          id,
          identity,
          definition,
          descriptor,
          definitionRevision,
          loaded.documents,
        ),
        definitionRevision,
      };
    } catch (error) {
      return { id, hash, revision, definition, problem: modelSetupProblem(definition, error) };
    }
  }

  /** Whether reading the references again found something `before` does not describe. */
  function referencesMoved(before: FileEntry, after: FileEntry): boolean {
    return (
      before.identity !== after.identity ||
      before.problem?.code !== after.problem?.code ||
      before.problem?.message !== after.problem?.message
    );
  }

  /** Settles the revision of every ready file in a scan (see the module documentation). */
  async function settleRevisions(
    loaded: ReadonlyMap<string, FileEntry>,
  ): Promise<ReadonlyMap<string, FileEntry>> {
    const settled = new Map(loaded);
    const referenced = new Set<string>();
    for (const [id, scanned] of loaded) {
      for (const path of scanned.definition?.references ?? []) {
        referenced.add(referenceCacheKey(id, path));
      }
      let entry = scanned;
      if (hasReferences(entry)) {
        entry = await withReferences(entry);
        settled.set(id, entry);
      }
      if (entry.problem !== undefined || entry.hash === undefined) continue;
      if (entry.definition === undefined) continue; // A ready entry always has one.
      const revision = await revisionOf(id, entry);
      if (revision !== entry.definitionRevision) settled.set(id, atRevision(entry, revision));
    }
    // A document no agent names any more is not kept.
    for (const key of referenceCache.keys()) if (!referenced.has(key)) referenceCache.delete(key);
    return settled;
  }

  const directoryWatcher = createDefinitionScanner<FileEntry>({
    source: options.source,
    label: 'agent directory',
    runtime: options.runtime,
    diagnose: options.diagnose,
    revision: deploymentRevision,
    evaluate,
    tooLarge,
    unreadable,
    sameSignature,
    isRejected: (entry) => entry.problem !== undefined,
    settle: settleRevisions,
    afterScan: () => scheduleReferencePoll(),
  });
  const { refresh } = directoryWatcher;

  let closing = false;
  let referenceTimer: unknown;
  /** The poll that is reading references now, so `close()` can wait for it. */
  let polling: Promise<void> | undefined;

  /**
   * Arms the next read of the references while any agent has some. A source reports changes to
   * agent files, not to the documents they name, so nothing else would notice an edit to one.
   */
  function scheduleReferencePoll(): void {
    if (closing || referenceTimer !== undefined) return;
    const period = options.source.referencePollMilliseconds;
    if (period === undefined) return;
    if (![...directoryWatcher.entries().values()].some(hasReferences)) return;
    referenceTimer = options.runtime.timers.setTimeout(() => {
      referenceTimer = undefined;
      polling = pollReferences().finally(() => {
        polling = undefined;
      });
    }, period);
  }

  /** Read every agent's references; rescan if one moved. Never rejects. */
  async function pollReferences(): Promise<void> {
    try {
      for (const entry of directoryWatcher.entries().values()) {
        if (closing || !hasReferences(entry)) continue;
        if (referencesMoved(entry, await withReferences(entry))) {
          await refresh();
          return;
        }
      }
    } catch (error) {
      options.diagnose('The reference documents of the agent files could not be read.', error);
    } finally {
      scheduleReferencePoll();
    }
  }

  /** The definition as the source holds it now, read from the source and not from the last scan. */
  async function readFresh(id: string): Promise<DefinitionEntry | undefined> {
    const entries = await options.source.load();
    return entries.find((candidate) => candidate.id === id);
  }

  const writer = createAgentFileWriter({
    source: options.source,
    read: readFresh,
    async validate(id, definition) {
      const checked = checkDeployment(id, definition);
      if ('problem' in checked) return checked.problem;
      // The host's resolver is asked here too, so a write is refused for a model it cannot set
      // up rather than committed and then listed invalid.
      try {
        options.resolveGenerate(checked.descriptor);
      } catch (error) {
        return modelSetupProblem(definition, error);
      }
      // A reference the source cannot read would list the file `invalid` as soon as it was written.
      if (definition.references !== undefined) {
        const loaded = await loadReferenceDocuments(
          options.source,
          definition.references,
          undefined,
          id,
        );
        if (!loaded.ok) return loaded.problem;
      }
      return undefined;
    },
    refresh: directoryWatcher.reload,
    expectSave(id, hash, savedBy) {
      const key = `${id}:${hash}`;
      savers.set(key, ownerOrLocal(savedBy));
      return () => {
        savers.delete(key);
      };
    },
  });

  const versions: AgentFileVersions = {
    list: (id) => versionStore.list(id),

    async restore(id, revision, restoreOptions) {
      const version = await versionStore.read(id, revision);
      if (version === undefined) {
        throw new AgentFileError(
          'agent-version-not-found',
          `Agent "${id}" has no stored version ${revision}.`,
        );
      }
      return writer.update(id, agentFileInputOf(version.definition), restoreOptions);
    },
  };

  return {
    ...writer,
    versions,

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
        const raw = await readFresh(id);
        if (raw === undefined) return undefined;
        const revision = deploymentRevision();
        let entry: FileEntry;
        let text: string | undefined;
        if (raw.problem !== undefined) {
          entry =
            raw.problem.code === 'file-too-large'
              ? tooLarge(id, raw.problem.size ?? 0, revision)
              : unreadable(id, new Error(raw.problem.message), revision);
        } else {
          // The documents an agent names are read again too: they can have changed since the scan.
          const stale =
            known.hash !== raw.hash ||
            (hasReferences(known) && referencesMoved(known, await withReferences(known)));
          if (stale && attempt < DETAIL_SETTLE_ATTEMPTS) {
            await refresh();
            continue;
          }
          try {
            entry =
              known.hash === raw.hash && known.revision === revision
                ? known
                : evaluate(id, raw.bytes, raw.hash, revision, raw.plugin);
            // An entry evaluated here has not read its documents yet.
            if (entry.agent === undefined && hasReferences(entry)) {
              entry = await withReferences(entry);
            }
            text = decodeAgentFile(raw.bytes);
          } catch (error) {
            entry = unreadable(id, error, revision);
          }
        }
        return { ...toListing(entry), text: text ?? null, definition: entry.definition ?? null };
      }
    },

    tools() {
      const users = new Map<string, string[]>();
      for (const entry of directoryWatcher.entries().values()) {
        if (entry.agent === undefined || entry.definition === undefined) continue;
        for (const name of entry.definition.tools) {
          users.set(name, [...(users.get(name) ?? []), entry.id]);
        }
      }
      return Object.entries(options.tools)
        .map(([name, tool]): AgentToolDescription => ({
          name,
          description: tool.description,
          shortDescription: readToolShortDescription(tool.metadata) ?? null,
          ...describeToolCapability(tool),
          source: options.bureauToolNames?.has(name) === true ? 'bureau' : 'host',
          users: (users.get(name) ?? []).toSorted(),
        }))
        .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    },

    find(id) {
      return directoryWatcher.entries().get(id)?.agent;
    },

    ephemeral(id, definition) {
      const refuse = (problem: AgentFileProblem): never => {
        throw new AgentFileError(problem.code, problem.message, problem);
      };
      const bytes = serializeNewAgentFile({ ...definition, a2a: false });
      if (bytes.length > AGENT_FILE_SIZE_LIMIT) {
        return refuse({
          code: 'file-too-large',
          message: `An agent definition may be at most ${AGENT_FILE_SIZE_LIMIT} bytes.`,
        });
      }
      const text = decodeAgentFile(bytes);
      const parsed = text === undefined ? undefined : parseAgentFile(id, text);
      if (parsed === undefined) {
        return refuse({ code: 'not-utf8', message: 'The agent definition is not valid UTF-8.' });
      }
      if (!parsed.ok) return refuse(parsed.problem);
      const { definition: parsedDefinition } = parsed.file;
      if (parsedDefinition.references !== undefined) {
        const message =
          'A definition that is being tried cannot list references: they name documents beside an agent file, and a tried definition has none. Remove references, or save the agent first.';
        return refuse({
          code: 'invalid-frontmatter',
          message,
          issues: [{ path: 'references', message }],
        });
      }
      const checked = checkDeployment(id, parsedDefinition);
      if ('problem' in checked) return refuse(fieldNamed(checked.problem, parsedDefinition));
      try {
        return buildAgent(
          id,
          hashAgentFileBytes(bytes),
          parsedDefinition,
          checked.descriptor,
          1,
          [],
          false,
        );
      } catch (error) {
        return refuse(modelSetupProblem(parsedDefinition, error));
      }
    },

    refresh,

    revalidate() {
      validationEpoch += 1;
      return refresh();
    },

    health: directoryWatcher.health,

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
        snapshot.referenceDocuments,
      );
    },

    async close() {
      closing = true;
      if (referenceTimer !== undefined) options.runtime.timers.clearTimeout(referenceTimer);
      referenceTimer = undefined;
      await polling;
      await directoryWatcher.close();
    },
  };
}

/** The write input type, re-exported for the catalog's callers. */
export type { AgentFileDefinitionInput, AgentFileWriteResult };
