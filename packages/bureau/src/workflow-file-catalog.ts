/**
 * The workflows in a directory of JSON files (COR-1527): loaded, validated, kept current, and
 * written back, with the same rules as the agent files (COR-1524).
 *
 * Every `*.json` file in the directory is a workflow whose identifier is the filename without the
 * extension. Dotfiles, other extensions, and directories are ignored. A file that cannot be used is
 * still listed, with `state: 'invalid'` and a typed {@link WorkflowFileProblem}; it never runs and
 * it never affects another workflow. Watching, the safety rescan, and the atomic write are shared
 * with the agent files (`watched-directory.ts`, `atomic-file-writer.ts`).
 *
 * @module workflow-file-catalog
 */

import { randomUUID } from 'node:crypto';
import type { FSWatcher } from 'node:fs';

import type { RuntimeServices } from '@lostgradient/lifecycle';
import type { DocumentWorkflowHost } from '@lostgradient/weft';

import { type AgentFileOperations, nodeAgentFileOperations } from './agent-file-operations';
import { createAtomicFileWriter } from './atomic-file-writer';
import { ownerOrLocal } from './owner-of-record';
import { createWatchedDirectory, type DirectoryChange } from './watched-directory';
import {
  checkWorkflowIdentifier,
  decodeWorkflowFile,
  hashWorkflowFileBytes,
  parseWorkflowFile,
  serializeWorkflowFile,
  WORKFLOW_FILE_EXTENSION,
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
  readonly directory: string;
  readonly host: DocumentWorkflowHost;
  /** Whether `id` names a workflow the engine already has from code; a file may not take it. */
  readonly isCodeWorkflow: (id: string) => boolean;
  readonly runtime: RuntimeServices;
  /** Where watcher and scan failures are reported. */
  readonly diagnose: (message: string, cause: unknown) => void;
  readonly operations?: AgentFileOperations | undefined;
  /** Called after every rescan, whether or not it found a change. */
  readonly afterScan?: (() => void) | undefined;
  /** Watch the directory. Defaults to `true`; `false` leaves reloading to `refresh()`. */
  readonly watch?: boolean | undefined;
  readonly openWatcher?:
    | ((path: string, listener: (event: string, filename: string | null) => void) => FSWatcher)
    | undefined;
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
  /** Called after every rescan that added, changed, or removed a workflow. Returns its unsubscribe. */
  readonly onChange: (listener: (change: DirectoryChange) => void) => () => void;
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
  const operations = options.operations ?? nodeAgentFileOperations;
  const { directory, host } = options;
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

  const watched = createWatchedDirectory<WorkflowEntry>({
    directory,
    label: 'workflow directory',
    extension: WORKFLOW_FILE_EXTENSION,
    sizeLimit: WORKFLOW_FILE_SIZE_LIMIT,
    runtime: options.runtime,
    diagnose: options.diagnose,
    operations,
    ...(options.afterScan === undefined ? {} : { afterScan: options.afterScan }),
    ...(options.watch === undefined ? {} : { watch: options.watch }),
    ...(options.openWatcher === undefined ? {} : { openWatcher: options.openWatcher }),
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
  });

  const files = createAtomicFileWriter({
    directory,
    operations,
    extension: WORKFLOW_FILE_EXTENSION,
    newTemporaryName: () => randomUUID(),
    notFound: (id) =>
      new WorkflowFileError('workflow-file-not-found', `There is no workflow file for "${id}".`),
    exists: (id, currentHash) =>
      new WorkflowFileConflictError(
        'workflow-file-exists',
        `A workflow file for "${id}" already exists.`,
        currentHash,
      ),
    changed: (id, currentHash) =>
      new WorkflowFileConflictError(
        'workflow-file-changed',
        `The file for "${id}" has changed since it was read.`,
        currentHash,
      ),
  });

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

  /** Replace the file, which must still hold `expectedHash`, with `bytes`. */
  async function replace(
    id: string,
    bytes: Uint8Array,
    expectedHash: string,
  ): Promise<WorkflowFileWriteResult> {
    await files.readExisting(id, expectedHash);
    await files.publish(id, bytes, () => files.recheck(id, expectedHash));
    await watched.refresh();
    return { id, hash: hashWorkflowFileBytes(bytes) };
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
      const bytes = await files.readBytes(id);
      if (bytes === undefined) return undefined;
      const text = decodeWorkflowFile(bytes);
      if (text === undefined) {
        throw new WorkflowFileError('not-utf8', `The file for "${id}" is not valid UTF-8.`);
      }
      return { hash: hashWorkflowFileBytes(bytes), text };
    },

    create(id, definition) {
      return files.exclusive(async () => {
        checkIdentifier(id);
        const bytes = bytesFor(id, definition);
        const absent = (): Promise<void> => files.assertAbsent(id);
        await absent();
        await files.publish(id, bytes, absent);
        await watched.refresh();
        return { id, hash: hashWorkflowFileBytes(bytes) };
      });
    },

    update(id, definition, { expectedHash }) {
      return files.exclusive(async () => {
        checkIdentifier(id);
        const bytes = bytesFor(id, definition);
        const current = await files.readExisting(id, expectedHash);
        // An update that changes nothing writes nothing.
        if (hashWorkflowFileBytes(bytes) === current.hash) return { id, hash: current.hash };
        return replace(id, bytes, expectedHash);
      });
    },

    setPaused(id, paused, { expectedHash }) {
      return files.exclusive(async () => {
        checkIdentifier(id);
        const current = await files.readExisting(id, expectedHash);
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
        return replace(id, bytes, expectedHash);
      });
    },

    delete(id, { expectedHash }) {
      return files.exclusive(async () => {
        checkIdentifier(id);
        const { hash } = await files.readExisting(id, expectedHash);
        await files.recheck(id, expectedHash);
        await files.remove(id);
        await watched.refresh();
        return { id, hash };
      });
    },

    refresh: watched.refresh,
    onChange: watched.onChange,
    close: watched.close,
  };
}
