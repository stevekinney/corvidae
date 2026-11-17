/**
 * The owner-defined validators in a directory of JSON files (COR-2119): loaded, validated and kept
 * current as the files change, read-only.
 *
 * Every `*.json` file in the directory is a validator whose name is the filename without the
 * extension (`validator-file.ts` says what a file holds and what its version is). A file that cannot
 * be used is still listed, `invalid`, with a code and nothing else; it never resolves and it never
 * affects another file. Loading and watching go through a validator source, and the scan that
 * evaluates what the source loads is the one the agent and workflow files use
 * (`definition-scanner.ts`), so a change is found by the same watcher and reported through
 * `definitions.changed` as `validators`.
 *
 * The catalog serves a goal that is created. A goal that is running reads the copy of its definition
 * its record holds (`GoalState.validatorDefinition`), so nothing this catalog does reaches it.
 *
 * @module validator-file-catalog
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';

import {
  createDefinitionScanner,
  type DefinitionChange,
  type DefinitionScannerHealth,
} from './definition-scanner';
import type { ValidatorSource } from './sources/definition-source';
import {
  decodeValidatorFile,
  parseValidatorFile,
  VALIDATOR_FILE_SIZE_LIMIT,
  type ValidatorFileDefinition,
  type ValidatorFileProblemCode,
} from './validator-file';

/** One file in {@link ValidatorFileCatalog.list}. */
export interface ValidatorFileListing {
  /** The file's stem, which is the validator's name. */
  readonly name: string;
  readonly state: 'ready' | 'invalid';
  /** The SHA-256 of the file's bytes, when they could be read. */
  readonly hash?: string;
  /** The validator's version, the digest of its definition: for a ready file. */
  readonly version?: string;
  /** What the check is for: for a ready file. */
  readonly description?: string;
  /** Why an `invalid` file cannot be used: a code, and nothing of the file. */
  readonly problem?: ValidatorFileProblemCode;
}

/** A ready file as a goal needs it. */
export interface ReadyValidatorFile {
  readonly name: string;
  readonly hash: string;
  readonly version: string;
  readonly definition: ValidatorFileDefinition;
}

/** What `createGoalValidatorCatalog` reads the files through. */
export interface ValidatorFileLookup {
  /** The ready file named `name`, as the last scan found it. */
  readonly find: (name: string) => ReadyValidatorFile | undefined;
  /** Every ready file, by name. */
  readonly ready: () => readonly ReadyValidatorFile[];
}

export interface ValidatorFileCatalogOptions {
  /** Where the validator files come from. */
  readonly source: ValidatorSource;
  readonly runtime: RuntimeServices;
  /** Where watcher and scan failures are reported. */
  readonly diagnose: (message: string, cause: unknown) => void;
  /** Called after every rescan, whether or not it found a change. */
  readonly afterScan?: (() => void) | undefined;
  /**
   * Whether `model` is a row of the model catalog, which a `judge` file must name (COR-2123). Read
   * when a file is evaluated; left out, no judge's model is refused.
   */
  readonly modelKnown?: ((model: string) => boolean) | undefined;
  /** A number that changes when what `modelKnown` answers may have, so every file is read again. */
  readonly revision?: (() => number) | undefined;
}

export interface ValidatorFileCatalog extends ValidatorFileLookup {
  /** Every file in the directory that is a validator file, ready or invalid, by name. */
  readonly list: () => readonly ValidatorFileListing[];
  /** Rescan the directory; resolves once the catalog reflects it. */
  readonly refresh: () => Promise<void>;
  /** When the directory was last scanned, and the message of that scan's error. */
  readonly health: () => DefinitionScannerHealth;
  /** Called after every rescan that added, changed, or removed a file. Returns its unsubscribe. */
  readonly onChange: (listener: (change: DefinitionChange) => void) => () => void;
  /** Stop watching and wait for a scan in flight. */
  readonly close: () => Promise<void>;
}

interface ValidatorEntry {
  readonly id: string;
  readonly hash: string | undefined;
  readonly revision: number;
  readonly file?: ReadyValidatorFile;
  readonly problem?: ValidatorFileProblemCode;
}

export function createValidatorFileCatalog(
  options: ValidatorFileCatalogOptions,
): ValidatorFileCatalog {
  const invalid = (
    id: string,
    hash: string | undefined,
    revision: number,
    problem: ValidatorFileProblemCode,
  ): ValidatorEntry => ({ id, hash, revision, problem });

  const scanner = createDefinitionScanner<ValidatorEntry>({
    source: options.source,
    label: 'validator directory',
    runtime: options.runtime,
    diagnose: options.diagnose,
    ...(options.afterScan === undefined ? {} : { afterScan: options.afterScan }),
    revision: options.revision ?? (() => 0),
    evaluate: (id, bytes, hash, revision) => {
      const text = decodeValidatorFile(bytes);
      if (text === undefined) return invalid(id, hash, revision, 'VALIDATOR_FILE_NOT_UTF8');
      const parsed = parseValidatorFile(id, text, { modelKnown: options.modelKnown });
      if (!parsed.ok) return invalid(id, hash, revision, parsed.code);
      return {
        id,
        hash,
        revision,
        file: { name: id, hash, version: parsed.version, definition: parsed.definition },
      };
    },
    tooLarge: (id, _size, revision) => invalid(id, undefined, revision, 'VALIDATOR_FILE_TOO_LARGE'),
    unreadable: (id, _error, revision) =>
      invalid(id, undefined, revision, 'VALIDATOR_FILE_UNREADABLE'),
    // A file whose bytes changed but which says the same thing is not a change to a goal.
    sameSignature: (before, after) =>
      before.file?.version === after.file?.version && before.problem === after.problem,
    isRejected: (entry) => entry.problem !== undefined,
  });

  const entries = (): readonly ValidatorEntry[] =>
    [...scanner.entries().values()].toSorted((left, right) => left.id.localeCompare(right.id));

  return {
    list: () =>
      entries().map((entry): ValidatorFileListing => {
        const { file, problem } = entry;
        return {
          name: entry.id,
          state: file === undefined ? 'invalid' : 'ready',
          ...(entry.hash === undefined ? {} : { hash: entry.hash }),
          ...(file === undefined
            ? {}
            : { version: file.version, description: file.definition.description }),
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

export { VALIDATOR_FILE_SIZE_LIMIT };
