/**
 * The workflows in a directory of JSON files (COR-1527): loaded, validated, kept current, and
 * written back, with the same rules as the agent files (COR-1524).
 *
 * Every `*.json` file in the directory is a workflow whose identifier is the filename without the
 * extension. Dotfiles, other extensions, and directories are ignored. A file that cannot be used is
 * still listed, with `state: 'invalid'` and a typed {@link WorkflowFileProblem}; it never runs and
 * it never affects another workflow. Loading, watching, and writing go through a workflow source
 * (COR-1702); the scan that evaluates what the source loads is shared with the agent files
 * (`definition-scanner.ts`).
 *
 * @module workflow-file-catalog
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import type { DocumentWorkflowHost } from '@lostgradient/weft';

import {
  createDefinitionScanner,
  type DefinitionChange,
  type DefinitionScannerHealth,
} from './definition-scanner';
import { ownerOrLocal } from './owner-of-record';
import {
  type DefinitionEntry,
  SourceConflictError,
  type WorkflowSource,
} from './sources/definition-source';
import {
  checkWorkflowIdentifier,
  decodeWorkflowFile,
  hashWorkflowFileBytes,
  parseWorkflowFile,
  serializeWorkflowFile,
  WORKFLOW_FILE_SIZE_LIMIT,
  WorkflowFileConflictError,
  type WorkflowFileContents,
  type WorkflowFileDefinition,
  WorkflowFileError,
  type WorkflowFileProblem,
  workflowVersionOf,
} from './workflow-file';

/** One workflow in {@link WorkflowFileCatalog.list}. */
export interface WorkflowListing {
  readonly id: string;
  readonly state: 'ready' | 'invalid';
  /** The deployment's owner of record. A file has no owner field. */
  readonly owner: string;
  /** The SHA-256 of the file's bytes, when they could be read. */
  readonly hash?: string;
  /** What the workflow is for, in a sentence, or `null` when the file gives none or is invalid. */
  readonly description: string | null;
  /** The identifier of the agent that wrote the file, or `null`. */
  readonly agent: string | null;
  readonly paused: boolean;
  /** The `kind` of the file's trigger, for a ready file, and `null` for an invalid one. */
  readonly triggerKind: string | null;
  /** The file's trigger as written (`kind` and the keys of that kind), for a ready file, else `null`. */
  readonly trigger: Readonly<{ kind: string } & Record<string, unknown>> | null;
  /** Weft's `workflowVersion` of the document, for a ready file. */
  readonly version?: string;
  /** Why an `invalid` file cannot run. */
  readonly problem?: WorkflowFileProblem;
}

/** A ready file as the runtime needs it. */
export interface ReadyWorkflowFile extends WorkflowFileContents {
  readonly id: string;
  readonly hash: string;
  readonly version: string;
}

/** What a successful write reports: the identifier and the hash of the file now on disk. */
export interface WorkflowFileWriteResult {
  readonly id: string;
  readonly hash: string;
}

export interface WorkflowFileCatalogOptions {
  /** Where the workflow files come from and are written back to. */
  readonly source: WorkflowSource;
  readonly host: DocumentWorkflowHost;
  /** Whether `id` names a workflow the engine already has from code; a file may not take it. */
  readonly isCodeWorkflow: (id: string) => boolean;
  readonly runtime: RuntimeServices;
  /** Where watcher and scan failures are reported. */
  readonly diagnose: (message: string, cause: unknown) => void;
  /** Called after every rescan, whether or not it found a change. */
  readonly afterScan?: (() => void) | undefined;
}

export interface WorkflowFileCatalog {
  /** Every file in the directory that is a workflow file, ready or invalid, by identifier. */
  readonly list: () => readonly WorkflowListing[];
  /** The file for an identifier whose state is `ready`. */
  readonly find: (id: string) => ReadyWorkflowFile | undefined;
  /** The file's text and hash, or `undefined` when there is no such file. */
  readonly read: (
    id: string,
  ) => Promise<{ readonly hash: string; readonly text: string } | undefined>;
  readonly create: (
    id: string,
    definition: WorkflowFileDefinition,
  ) => Promise<WorkflowFileWriteResult>;
  readonly update: (
    id: string,
    definition: WorkflowFileDefinition,
    options: { readonly expectedHash: string },
  ) => Promise<WorkflowFileWriteResult>;
  /** Set `paused` in the file. A file that already has that value is left untouched. */
  readonly setPaused: (
    id: string,
    paused: boolean,
    options: { readonly expectedHash: string },
  ) => Promise<WorkflowFileWriteResult>;
  readonly delete: (
    id: string,
    options: { readonly expectedHash: string },
  ) => Promise<WorkflowFileWriteResult>;
  /** Rescan the directory; resolves once the catalog reflects it. */
  readonly refresh: () => Promise<void>;
  /** When the directory was last scanned and the message of that scan's error (COR-1731). */
  readonly health: () => DefinitionScannerHealth;
  /** Called after every rescan that added, changed, or removed a workflow. Returns its unsubscribe. */
  readonly onChange: (listener: (change: DefinitionChange) => void) => () => void;
  /** Stop watching and wait for a scan in flight. */
  readonly close: () => Promise<void>;
}

interface WorkflowEntry {
  readonly id: string;
  readonly hash: string | undefined;
  readonly revision: number;
  readonly file?: ReadyWorkflowFile;
  readonly problem?: WorkflowFileProblem;
}

function refuse(problem: WorkflowFileProblem): never {
  throw new WorkflowFileError(problem.code, problem.message, problem);
}

export function createWorkflowFileCatalog(
  options: WorkflowFileCatalogOptions,
): WorkflowFileCatalog {
  const { source, host } = options;
  const owner = ownerOrLocal(undefined);

  function evaluate(id: string, bytes: Uint8Array, hash: string, revision: number): WorkflowEntry {
    const invalid = (problem: WorkflowFileProblem): WorkflowEntry => ({
      id,
      hash,
      revision,
      problem,
    });
    const text = decodeWorkflowFile(bytes);
    if (text === undefined) {
      return invalid({ code: 'not-utf8', message: 'The file is not valid UTF-8.' });
    }
    const parsed = parseWorkflowFile(id, text, host);
    if (!parsed.ok) return invalid(parsed.problem);
    if (options.isCodeWorkflow(id)) {
      return invalid({
        code: 'shadows-code-workflow',
        message: `"${id}" is the name of a code-defined workflow, so a file cannot be that workflow.`,
      });
    }
    return {
      id,
      hash,
      revision,
      file: { ...parsed.file, id, hash, version: workflowVersionOf(parsed.file.document) },
    };
  }

  const watched = createDefinitionScanner<WorkflowEntry>({
    source,
    label: 'workflow directory',
    runtime: options.runtime,
    diagnose: options.diagnose,
    ...(options.afterScan === undefined ? {} : { afterScan: options.afterScan }),
    revision: () => 0,
    evaluate,
    tooLarge: (id, size, revision) => ({
      id,
      hash: undefined,
      revision,
      problem: {
        code: 'file-too-large',
        message: `The file is ${size} bytes; a workflow file may be at most ${WORKFLOW_FILE_SIZE_LIMIT}.`,
      },
    }),
    unreadable: (id, error, revision) => ({
      id,
      hash: undefined,
      revision,
      problem: {
        code: 'unreadable',
        message: `The file could not be read: ${error instanceof Error ? error.message : String(error)}`,
      },
    }),
    sameSignature: (before, after) =>
      before.hash === after.hash && before.problem?.code === after.problem?.code,
    isRejected: (entry) => entry.problem !== undefined,
  });

  let tail: Promise<unknown> = Promise.resolve();
  /** Run `work` after every earlier write has settled: writes are serialized in this process. */
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  }

  /** The error for a source that found the file in a state the caller did not expect. */
  function conflictOf(error: SourceConflictError): WorkflowFileError {
    const { id, expectedHash, actualHash } = error;
    if (actualHash === null) {
      return new WorkflowFileError(
        'workflow-file-not-found',
        `There is no workflow file for "${id}".`,
      );
    }
    return expectedHash === null
      ? new WorkflowFileConflictError(
          'workflow-file-exists',
          `A workflow file for "${id}" already exists.`,
          actualHash,
        )
      : new WorkflowFileConflictError(
          'workflow-file-changed',
          `The file for "${id}" has changed since it was read.`,
          actualHash,
        );
  }

  async function throughSource<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw error instanceof SourceConflictError ? conflictOf(error) : error;
    }
  }

  /** The definition as the source holds it now, read from the source and not from the last scan. */
  async function readFresh(id: string): Promise<DefinitionEntry | undefined> {
    const entries = await source.load();
    return entries.find((candidate) => candidate.id === id);
  }

  /** The file's bytes, which must still hold `expectedHash`. */
  async function readExisting(
    id: string,
    expectedHash: string,
  ): Promise<{ readonly bytes: Uint8Array; readonly hash: string }> {
    const entry = await readFresh(id);
    if (entry === undefined) throw conflictOf(new SourceConflictError(id, expectedHash, null));
    if (entry.problem !== undefined) {
      throw new WorkflowFileError(
        entry.problem.code,
        `The file for "${id}" cannot be read: ${entry.problem.message}`,
      );
    }
    if (entry.hash !== expectedHash) {
      throw conflictOf(new SourceConflictError(id, expectedHash, entry.hash));
    }
    return { bytes: entry.bytes, hash: entry.hash };
  }

  function checkIdentifier(id: string): void {
    const problem = checkWorkflowIdentifier(id);
    if (problem !== undefined) refuse(problem);
  }

  /** The bytes of `definition` as the workflow `id`, refusing any that would not load. */
  function bytesFor(id: string, definition: WorkflowFileDefinition): Uint8Array {
    const bytes = new TextEncoder().encode(serializeWorkflowFile(id, definition));
    if (bytes.length > WORKFLOW_FILE_SIZE_LIMIT) {
      refuse({
        code: 'file-too-large',
        message: `A workflow file may be at most ${WORKFLOW_FILE_SIZE_LIMIT} bytes.`,
      });
    }
    const parsed = parseWorkflowFile(id, new TextDecoder().decode(bytes), host);
    if (!parsed.ok) refuse(parsed.problem);
    if (options.isCodeWorkflow(id)) {
      refuse({
        code: 'shadows-code-workflow',
        message: `"${id}" is the name of a code-defined workflow, so a file cannot be that workflow.`,
      });
    }
    return bytes;
  }

  /** Write `bytes` as the file `id`: a create for `expectedHash: null`, else a replace. */
  async function write(
    id: string,
    bytes: Uint8Array,
    expectedHash: string | null,
  ): Promise<WorkflowFileWriteResult> {
    const written = await throughSource(() => source.write(id, bytes, { expectedHash }));
    await watched.reload();
    return { id, hash: written.hash };
  }

  return {
    list() {
      return [...watched.entries().values()]
        .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .map((entry): WorkflowListing => {
          const ready = entry.file !== undefined;
          return {
            id: entry.id,
            state: ready ? 'ready' : 'invalid',
            owner,
            description: entry.file?.description ?? null,
            agent: entry.file?.agent ?? null,
            paused: entry.file?.paused ?? false,
            triggerKind: entry.file?.document.trigger.kind ?? null,
            trigger: entry.file?.document.trigger ?? null,
            ...(entry.hash === undefined ? {} : { hash: entry.hash }),
            ...(entry.file === undefined ? {} : { version: entry.file.version }),
            ...(entry.problem === undefined ? {} : { problem: entry.problem }),
          };
        });
    },

    find: (id) => watched.entries().get(id)?.file,

    async read(id) {
      checkIdentifier(id);
      const entry = await readFresh(id);
      if (entry === undefined) return undefined;
      if (entry.problem !== undefined) {
        throw new WorkflowFileError(
          entry.problem.code,
          `The file for "${id}" cannot be read: ${entry.problem.message}`,
        );
      }
      const text = decodeWorkflowFile(entry.bytes);
      if (text === undefined) {
        throw new WorkflowFileError('not-utf8', `The file for "${id}" is not valid UTF-8.`);
      }
      return { hash: entry.hash, text };
    },

    create(id, definition) {
      return exclusive(async () => {
        checkIdentifier(id);
        return write(id, bytesFor(id, definition), null);
      });
    },

    update(id, definition, { expectedHash }) {
      return exclusive(async () => {
        checkIdentifier(id);
        const bytes = bytesFor(id, definition);
        const current = await readExisting(id, expectedHash);
        // An update that changes nothing writes nothing.
        if (hashWorkflowFileBytes(bytes) === current.hash) return { id, hash: current.hash };
        return write(id, bytes, expectedHash);
      });
    },

    setPaused(id, paused, { expectedHash }) {
      return exclusive(async () => {
        checkIdentifier(id);
        const current = await readExisting(id, expectedHash);
        const text = decodeWorkflowFile(current.bytes);
        const parsed = text === undefined ? undefined : parseWorkflowFile(id, text, host);
        if (parsed === undefined || !parsed.ok) {
          throw new WorkflowFileError(
            'invalid-document',
            `The file for "${id}" cannot be read as a workflow file, so it cannot be ${paused ? 'paused' : 'resumed'} in place. Fix it or delete it.`,
            parsed?.ok === false ? parsed.problem : undefined,
          );
        }
        if (parsed.file.paused === paused) return { id, hash: current.hash };
        const { name: _name, ...document } = parsed.file.document;
        const bytes = bytesFor(id, {
          ...(parsed.file.description === null ? {} : { description: parsed.file.description }),
          ...(parsed.file.agent === null ? {} : { agent: parsed.file.agent }),
          paused,
          trigger: document.trigger,
          steps: document.steps,
        });
        return write(id, bytes, expectedHash);
      });
    },

    delete(id, { expectedHash }) {
      return exclusive(async () => {
        checkIdentifier(id);
        await throughSource(() => source.delete(id, { expectedHash }));
        await watched.reload();
        return { id, hash: expectedHash };
      });
    },

    refresh: watched.refresh,
    health: watched.health,
    onChange: watched.onChange,
    close: watched.close,
  };
}
