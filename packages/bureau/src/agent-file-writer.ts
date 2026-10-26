/**
 * Writing agent files (COR-1524): `create`, `update`, and `delete` through the same files the
 * catalog loads.
 *
 * A write goes to a temporary dotfile in the same directory and is renamed into place, so a
 * reader (the catalog's own watcher included) never sees half a file. `update` and `delete` take
 * the SHA-256 of the bytes the caller last read and refuse with an {@link AgentFileConflictError}
 * when the file has changed since. Writes are serialized in this process.
 *
 * The write goes through the agent source (COR-1702): `source.write` and `source.delete` compare
 * against the hash the caller read as late as possible and reject with a `SourceConflictError`,
 * which this module reports as the {@link AgentFileConflictError} callers know. The directory
 * source's atomic rename is `sources/atomic-file-writer.ts`.
 *
 * @module agent-file-writer
 */

import {
  AGENT_FILE_SIZE_LIMIT,
  AgentFileConflictError,
  AgentFileError,
  type AgentFileDefinition,
  type AgentFileDefinitionInput,
  type AgentFileProblem,
  checkAgentIdentifier,
  decodeAgentFile,
  parseAgentFile,
  resolveAgentFileDefinition,
  serializeNewAgentFile,
  serializeUpdatedAgentFile,
} from './agent-file';
import { serializePublication } from './agent-file-publication';
import {
  type AgentSource,
  type DefinitionEntry,
  SourceConflictError,
} from './sources/definition-source';

export interface AgentFileWriterDependencies {
  readonly source: AgentSource;
  /** The checks that depend on the deployment: a reserved identifier, the model, the tools. */
  validate(id: string, definition: AgentFileDefinition): AgentFileProblem | undefined;
  /** The definition as the source holds it now, read from the source and not from the last scan. */
  read(id: string): Promise<DefinitionEntry | undefined>;
  /** Reload the source after a write; resolves once the catalog reflects it, rejects if it cannot. */
  refresh(): Promise<void>;
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
  /**
   * Set `published` in the file's frontmatter and change nothing else, if the file still hashes
   * to `expectedHash`. Publishing refuses a file the deployment could not run; withdrawing does
   * not, so an agent whose model has left the catalog can still be taken out of offer. Writes
   * nothing for a file that already has the state.
   */
  setPublished(
    id: string,
    published: boolean,
    options: { readonly expectedHash: string },
  ): Promise<AgentFileWriteResult>;
}

function refuse(problem: AgentFileProblem): never {
  throw new AgentFileError(problem.code, problem.message, problem);
}

export function createAgentFileWriter(dependencies: AgentFileWriterDependencies): AgentFileWriter {
  const { source } = dependencies;
  let tail: Promise<unknown> = Promise.resolve();
  /** Run `work` after every earlier write has settled: writes are serialized in this process. */
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  }

  /** The error for a source that found the file in a state the caller did not expect. */
  function conflictOf(error: SourceConflictError): AgentFileError {
    const { id, expectedHash, actualHash } = error;
    if (actualHash === null) {
      return new AgentFileError('agent-file-not-found', `There is no agent file for "${id}".`);
    }
    return expectedHash === null
      ? new AgentFileConflictError(
          'agent-file-exists',
          `An agent file for "${id}" already exists.`,
          actualHash,
        )
      : new AgentFileConflictError(
          'agent-file-changed',
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

  /** The file's bytes, which must still hold `expectedHash`. */
  async function readExisting(id: string, expectedHash: string): Promise<Uint8Array> {
    const entry = await dependencies.read(id);
    if (entry === undefined) throw conflictOf(new SourceConflictError(id, expectedHash, null));
    if (entry.problem !== undefined) {
      throw new AgentFileError(
        'agent-file-unreadable',
        `The file for "${id}" cannot be read: ${entry.problem.message}`,
      );
    }
    if (entry.hash !== expectedHash) {
      throw conflictOf(new SourceConflictError(id, expectedHash, entry.hash));
    }
    return entry.bytes;
  }

  /** Replace the file, which must still hold `expectedHash`, with `bytes`. */
  async function replace(
    id: string,
    bytes: Uint8Array,
    expectedHash: string | null,
  ): Promise<AgentFileWriteResult> {
    const written = await throughSource(() => source.write(id, bytes, { expectedHash }));
    await dependencies.refresh();
    return { id, hash: written.hash };
  }

  function checkIdentifier(id: string): void {
    const problem = checkAgentIdentifier(id);
    if (problem !== undefined) refuse(problem);
  }

  /**
   * Refuse unless `bytes` would load as a usable agent named `id`. `deployment: false` checks the
   * file's own shape and leaves out what depends on the deployment (its model and tools).
   */
  function checkWritable(id: string, bytes: Uint8Array, deployment = true): void {
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
    if (!deployment) return;
    const problem = dependencies.validate(id, parsed.file.definition);
    if (problem !== undefined) refuse(problem);
  }

  return {
    async read(id) {
      checkIdentifier(id);
      const entry = await dependencies.read(id);
      if (entry === undefined) return undefined;
      if (entry.problem !== undefined) {
        throw new AgentFileError(
          'agent-file-unreadable',
          `The file for "${id}" cannot be read: ${entry.problem.message}`,
        );
      }
      const text = decodeAgentFile(entry.bytes);
      if (text === undefined) {
        throw new AgentFileError('not-utf8', `The file for "${id}" is not valid UTF-8.`);
      }
      return { hash: entry.hash, text };
    },

    create(id, definition) {
      return exclusive(async () => {
        checkIdentifier(id);
        const bytes = serializeNewAgentFile(definition);
        checkWritable(id, bytes);
        return replace(id, bytes, null);
      });
    },

    update(id, definition, { expectedHash }) {
      return exclusive(async () => {
        checkIdentifier(id);
        const current = await readExisting(id, expectedHash);
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
        if (next === undefined) return { id, hash: expectedHash };
        checkWritable(id, next);
        return replace(id, next, expectedHash);
      });
    },

    setPublished(id, published, { expectedHash }) {
      return exclusive(async () => {
        checkIdentifier(id);
        const current = await readExisting(id, expectedHash);
        const text = decodeAgentFile(current);
        const parsed = text === undefined ? undefined : parseAgentFile(id, text);
        if (parsed === undefined || !parsed.ok) {
          throw new AgentFileError(
            'agent-file-unreadable',
            `The file for "${id}" cannot be read as an agent file, so it cannot be ${published ? 'published' : 'withdrawn'}.`,
            parsed?.ok === false ? parsed.problem : undefined,
          );
        }
        const next = serializePublication(parsed.file, published);
        // A file that already has the state is not rewritten, and a publish still reports a file
        // the deployment could not run.
        if (next === undefined) {
          if (published) {
            const problem = dependencies.validate(id, parsed.file.definition);
            if (problem !== undefined) refuse(problem);
          }
          return { id, hash: expectedHash };
        }
        checkWritable(id, next, published);
        return replace(id, next, expectedHash);
      });
    },

    delete(id, { expectedHash }) {
      return exclusive(async () => {
        checkIdentifier(id);
        await throughSource(() => source.delete(id, { expectedHash }));
        await dependencies.refresh();
        return { id, hash: expectedHash };
      });
    },
  };
}
