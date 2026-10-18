/**
 * Writing agent files (COR-1524): `create`, `update`, and `delete` through the same files the
 * catalog loads.
 *
 * A write goes to a temporary dotfile in the same directory and is renamed into place, so a
 * reader (the catalog's own watcher included) never sees half a file. `update` and `delete` take
 * the SHA-256 of the bytes the caller last read and refuse with an {@link AgentFileConflictError}
 * when the file has changed since. Writes are serialized in this process.
 *
 * ## What is not guaranteed
 *
 * There is no cross-process file lock. A different process writing the same file in the instant
 * between a write's last check and its `rename` is not detected: `rename` replaces whatever is
 * there, and for `create` it cannot refuse an existing target. The window is the time between two
 * system calls.
 *
 * @module agent-file-writer
 */

import { join } from 'node:path';

import {
  AGENT_FILE_EXTENSION,
  AGENT_FILE_SIZE_LIMIT,
  AgentFileConflictError,
  AgentFileError,
  type AgentFileDefinition,
  type AgentFileDefinitionInput,
  type AgentFileProblem,
  checkAgentIdentifier,
  decodeAgentFile,
  hashAgentFileBytes,
  parseAgentFile,
  resolveAgentFileDefinition,
  serializeNewAgentFile,
  serializeUpdatedAgentFile,
} from './agent-file';
import type { AgentFileOperations } from './agent-file-operations';

export interface AgentFileWriterDependencies {
  readonly directory: string;
  readonly operations: AgentFileOperations;
  /** The checks that depend on the deployment: a reserved identifier, the model, the tools. */
  validate(id: string, definition: AgentFileDefinition): AgentFileProblem | undefined;
  /** Rescan the directory; resolves once the catalog reflects it. */
  refresh(): Promise<void>;
  /** A name no other file in the directory has, for the temporary file. */
  newTemporaryName(): string;
}

/** What a successful write reports: the identifier and the hash of the file now on disk. */
export interface AgentFileWriteResult {
  readonly id: string;
  readonly hash: string;
}

export interface AgentFileWriter {
  /** The file's text and hash, or `undefined` when there is no such file. */
  read(id: string): Promise<{ readonly hash: string; readonly text: string } | undefined>;
  create(id: string, definition: AgentFileDefinitionInput): Promise<AgentFileWriteResult>;
  update(
    id: string,
    definition: AgentFileDefinitionInput,
    options: { readonly expectedHash: string },
  ): Promise<AgentFileWriteResult>;
  delete(id: string, options: { readonly expectedHash: string }): Promise<AgentFileWriteResult>;
}

function refuse(problem: AgentFileProblem): never {
  throw new AgentFileError(problem.code, problem.message, problem);
}

export function createAgentFileWriter(dependencies: AgentFileWriterDependencies): AgentFileWriter {
  const { directory, operations } = dependencies;
  let tail: Promise<unknown> = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  }

  const pathOf = (id: string): string => join(directory, `${id}${AGENT_FILE_EXTENSION}`);
  const temporaryPathOf = (id: string): string =>
    join(directory, `.${id}${AGENT_FILE_EXTENSION}.${dependencies.newTemporaryName()}.tmp`);

  function checkIdentifier(id: string): void {
    const problem = checkAgentIdentifier(id);
    if (problem !== undefined) refuse(problem);
  }

  /** Refuse unless `bytes` would load as a usable agent named `id`. */
  function checkWritable(id: string, bytes: Uint8Array): void {
    if (bytes.length > AGENT_FILE_SIZE_LIMIT) {
      refuse({
        code: 'file-too-large',
        message: `An agent file may be at most ${AGENT_FILE_SIZE_LIMIT} bytes.`,
      });
    }
    const text = decodeAgentFile(bytes);
    const parsed = text === undefined ? undefined : parseAgentFile(id, text);
    if (parsed === undefined || !parsed.ok) {
      refuse(
        parsed?.ok === false
          ? parsed.problem
          : { code: 'not-utf8', message: 'The agent file is not valid UTF-8.' },
      );
    }
    const problem = dependencies.validate(id, parsed.file.definition);
    if (problem !== undefined) refuse(problem);
  }

  async function readExisting(
    id: string,
    expectedHash: string,
  ): Promise<{ readonly bytes: Uint8Array; readonly hash: string }> {
    const bytes = await operations.read(pathOf(id));
    if (bytes === undefined) {
      throw new AgentFileError('agent-file-not-found', `There is no agent file for "${id}".`);
    }
    const hash = hashAgentFileBytes(bytes);
    if (hash !== expectedHash) {
      throw new AgentFileConflictError(
        'agent-file-changed',
        `The file for "${id}" has changed since it was read.`,
        hash,
      );
    }
    return { bytes, hash };
  }

  /** Check, once more and as late as possible, that the target still holds `expectedHash`. */
  async function recheck(id: string, expectedHash: string): Promise<void> {
    const bytes = await operations.read(pathOf(id));
    if (bytes === undefined) {
      throw new AgentFileError('agent-file-not-found', `There is no agent file for "${id}".`);
    }
    const hash = hashAgentFileBytes(bytes);
    if (hash !== expectedHash) {
      throw new AgentFileConflictError(
        'agent-file-changed',
        `The file for "${id}" has changed since it was read.`,
        hash,
      );
    }
  }

  async function publish(
    id: string,
    bytes: Uint8Array,
    beforeRename: () => Promise<void>,
  ): Promise<void> {
    const temporary = temporaryPathOf(id);
    await operations.makeDirectory(directory);
    await operations.writeTemporary(temporary, bytes);
    try {
      await beforeRename();
      await operations.rename(temporary, pathOf(id));
    } catch (error) {
      await operations.remove(temporary).catch(() => undefined);
      throw error;
    }
  }

  return {
    async read(id) {
      checkIdentifier(id);
      const bytes = await operations.read(pathOf(id));
      if (bytes === undefined) return undefined;
      const text = decodeAgentFile(bytes);
      if (text === undefined) {
        throw new AgentFileError('not-utf8', `The file for "${id}" is not valid UTF-8.`);
      }
      return { hash: hashAgentFileBytes(bytes), text };
    },

    create(id, definition) {
      return exclusive(async () => {
        checkIdentifier(id);
        const bytes = serializeNewAgentFile(definition);
        checkWritable(id, bytes);
        const existing = async (): Promise<void> => {
          const current = await operations.read(pathOf(id));
          if (current !== undefined) {
            throw new AgentFileConflictError(
              'agent-file-exists',
              `An agent file for "${id}" already exists.`,
              hashAgentFileBytes(current),
            );
          }
        };
        await existing();
        await publish(id, bytes, existing);
        await dependencies.refresh();
        return { id, hash: hashAgentFileBytes(bytes) };
      });
    },

    update(id, definition, { expectedHash }) {
      return exclusive(async () => {
        checkIdentifier(id);
        const { bytes: current, hash } = await readExisting(id, expectedHash);
        const text = decodeAgentFile(current);
        const parsed = text === undefined ? undefined : parseAgentFile(id, text);
        if (parsed === undefined || !parsed.ok) {
          throw new AgentFileError(
            'agent-file-unreadable',
            `The file for "${id}" cannot be read as an agent file, so it cannot be updated in place. Delete it and create it again.`,
            parsed?.ok === false ? parsed.problem : undefined,
          );
        }
        // The definition is checked even when it changes nothing: an update never reports a
        // success for a file that would not load.
        const problem = dependencies.validate(id, resolveAgentFileDefinition(id, definition));
        if (problem !== undefined) refuse(problem);
        const next = serializeUpdatedAgentFile(id, parsed.file, definition);
        if (next === undefined) return { id, hash };
        checkWritable(id, next);
        await publish(id, next, () => recheck(id, expectedHash));
        await dependencies.refresh();
        return { id, hash: hashAgentFileBytes(next) };
      });
    },

    delete(id, { expectedHash }) {
      return exclusive(async () => {
        checkIdentifier(id);
        const { hash } = await readExisting(id, expectedHash);
        await recheck(id, expectedHash);
        await operations.remove(pathOf(id));
        await dependencies.refresh();
        return { id, hash };
      });
    },
  };
}
