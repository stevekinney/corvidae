/**
 * The owner-defined guardrails in a directory of JSON files (COR-2120): loaded, validated and kept
 * current as the files change, read-only, on the scan the agent, workflow and validator files share
 * (`definition-scanner.ts`), and reported through `definitions.changed` as `guardrails`.
 *
 * Every `*.json` file in the directory is a guardrail whose name is the filename without the
 * extension (`guardrail-file.ts` says what a file holds). A file that cannot be used is still listed,
 * `invalid`, with a code and nothing else; it resolves for no agent and never affects another file.
 *
 * What an agent named a guardrail for is not read from here again once the agent has copied it: the
 * agent's identity folds the digest in and its snapshot holds the definition (`agent-file-catalog.ts`).
 *
 * @module guardrail-file-catalog
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';

import {
  createDefinitionScanner,
  type DefinitionChange,
  type DefinitionScannerHealth,
} from './definition-scanner';
import {
  decodeGuardrailFile,
  type GuardrailFileDefinition,
  type GuardrailFileProblemCode,
  parseGuardrailFile,
} from './guardrail-file';
import type { GuardrailSource } from './sources/definition-source';

/** One file in {@link GuardrailFileCatalog.list}. */
export interface GuardrailFileListing {
  /** The file's stem, which an agent file lists the guardrail by. */
  readonly name: string;
  readonly state: 'ready' | 'invalid';
  /** The SHA-256 of the file's bytes, when they could be read. */
  readonly hash?: string;
  /** The digest of the definition, which is the guardrail's version: for a ready file. */
  readonly digest?: string;
  /** Why an `invalid` file cannot be used: a code, and nothing of the file. */
  readonly problem?: GuardrailFileProblemCode;
}

/** A ready file as an agent needs it. */
export interface ReadyGuardrailFile {
  readonly name: string;
  readonly hash: string;
  readonly digest: string;
  readonly definition: GuardrailFileDefinition;
}

export interface GuardrailFileCatalogOptions {
  /** Where the guardrail files come from. */
  readonly source: GuardrailSource;
  readonly runtime: RuntimeServices;
  /** Where watcher and scan failures are reported. */
  readonly diagnose: (message: string, cause: unknown) => void;
}

export interface GuardrailFileCatalog {
  /** Every file in the directory that is a guardrail file, ready or invalid, by name. */
  readonly list: () => readonly GuardrailFileListing[];
  /** The ready file named `name`, as the last scan found it. */
  readonly find: (name: string) => ReadyGuardrailFile | undefined;
  /** Every ready file, by name. */
  readonly ready: () => readonly ReadyGuardrailFile[];
  /** Rescan the directory; resolves once the catalog reflects it. */
  readonly refresh: () => Promise<void>;
  /** When the directory was last scanned, and the message of that scan's error. */
  readonly health: () => DefinitionScannerHealth;
  /** Called after every rescan that added, changed, or removed a file. Returns its unsubscribe. */
  readonly onChange: (listener: (change: DefinitionChange) => void) => () => void;
  /** Stop watching and wait for a scan in flight. */
  readonly close: () => Promise<void>;
}

interface GuardrailEntry {
  readonly id: string;
  readonly hash: string | undefined;
  readonly revision: number;
  readonly file?: ReadyGuardrailFile;
  readonly problem?: GuardrailFileProblemCode;
}

export function createGuardrailFileCatalog(
  options: GuardrailFileCatalogOptions,
): GuardrailFileCatalog {
  const invalid = (
    id: string,
    hash: string | undefined,
    revision: number,
    problem: GuardrailFileProblemCode,
  ): GuardrailEntry => ({ id, hash, revision, problem });

  const scanner = createDefinitionScanner<GuardrailEntry>({
    source: options.source,
    label: 'guardrail directory',
    runtime: options.runtime,
    diagnose: options.diagnose,
    revision: () => 0,
    evaluate: (id, bytes, hash, revision) => {
      const text = decodeGuardrailFile(bytes);
      if (text === undefined) return invalid(id, hash, revision, 'GUARDRAIL_FILE_NOT_UTF8');
      const parsed = parseGuardrailFile(id, text);
      if (!parsed.ok) return invalid(id, hash, revision, parsed.code);
      return {
        id,
        hash,
        revision,
        file: { name: id, hash, digest: parsed.digest, definition: parsed.definition },
      };
    },
    tooLarge: (id, _size, revision) => invalid(id, undefined, revision, 'GUARDRAIL_FILE_TOO_LARGE'),
    unreadable: (id, _error, revision) =>
      invalid(id, undefined, revision, 'GUARDRAIL_FILE_UNREADABLE'),
    // A file whose bytes changed but which says the same thing is not a change to an agent.
    sameSignature: (before, after) =>
      before.file?.digest === after.file?.digest && before.problem === after.problem,
    isRejected: (entry) => entry.problem !== undefined,
  });

  const entries = (): readonly GuardrailEntry[] =>
    [...scanner.entries().values()].toSorted((left, right) => left.id.localeCompare(right.id));

  return {
    list: () =>
      entries().map((entry): GuardrailFileListing => {
        const { file, problem } = entry;
        return {
          name: entry.id,
          state: file === undefined ? 'invalid' : 'ready',
          ...(entry.hash === undefined ? {} : { hash: entry.hash }),
          ...(file === undefined ? {} : { digest: file.digest }),
          ...(problem === undefined ? {} : { problem }),
        };
      }),
    find: (name) => scanner.entries().get(name)?.file,
    ready: () => entries().flatMap((entry) => (entry.file === undefined ? [] : [entry.file])),
    refresh: scanner.refresh,
    health: scanner.health,
    onChange: scanner.onChange,
    close: scanner.close,
  };
}
