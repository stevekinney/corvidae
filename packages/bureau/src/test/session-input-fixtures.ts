/**
 * COR-1476 — what the session-input tests share: a storage seam that decides an
 * interleaving instead of a timer, and the small helpers every one of them
 * repeats.
 *
 * `seamStorage` wraps a real `Storage` so a test can hold one read until it
 * says so, make a class of reads fail, and learn when a write of interest has
 * been issued. Every hook keys on the storage key (and, for writes, the text of
 * the value), which is how a test names "the ending run's mailbox read" or "the
 * admission's commit" without reaching into Bureau. Not a test file: it is
 * imported by the `session-input-*.test.ts` files.
 */
import {
  type GenerateContext,
  type GenerateFunction,
  stopWhen,
  createAgent,
} from '@lostgradient/operative';
import {
  type BatchOperation,
  type ConditionalBatchCondition,
  encodeStorageKeyComponent,
  resolveStorage,
  type Storage,
  yieldToPortableEventLoop,
} from '@lostgradient/weft';
import { createToolbox } from 'armorer';

import type { AgentDefinitions } from '../agent-catalog';
import { createBureau } from '../create-bureau';
import type { Bureau, BureauOptions } from '../types';

export function deferred<T = void>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

export function userTexts(conversation: GenerateContext['conversation']): string[] {
  return conversation
    .getMessages()
    .filter((message) => message.role === 'user')
    .map((message) => (typeof message.content === 'string' ? message.content : ''));
}

/** Waits for a state to become true, yielding between reads; throws when it never does. */
export async function pollUntil(
  check: () => boolean | Promise<boolean>,
  attempts = 400,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await yieldToPortableEventLoop();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the condition never became true');
}

const textDecoder = new TextDecoder();

/** The text of a write's value, for matching a write by what it says. */
export function textOf(operation: BatchOperation): string {
  return operation.type === 'put' ? textDecoder.decode(operation.value) : '';
}

/** A held read: `reached` resolves once the read is held; `release` lets it continue. */
export interface HeldRead {
  readonly reached: Promise<string>;
  readonly release: () => void;
}

/** A held write: `reached` resolves once the write is held; `release` lets it commit. */
export interface HeldWrite {
  readonly reached: Promise<BatchOperation[]>;
  readonly release: () => void;
}

export interface StorageSeam {
  readonly storage: Storage;
  /**
   * Holds the next read (a `get`, or a `scan` by prefix) of a key `matches`
   * accepts, once `after` has resolved when given, until the hold is released.
   */
  holdRead(matches: (key: string) => boolean, after?: Promise<unknown>): HeldRead;
  /** Resolves with the operations of the first write that `matches` accepts, as it is issued. */
  awaitWrite(
    matches: (operations: readonly BatchOperation[]) => boolean,
  ): Promise<BatchOperation[]>;
  /** Resolves with the operations of the first write that `matches` accepts, once it has committed. */
  awaitWriteCommitted(
    matches: (operations: readonly BatchOperation[]) => boolean,
  ): Promise<BatchOperation[]>;
  /** Holds the next write that `matches` accepts before it commits, until the hold is released. */
  holdWrite(matches: (operations: readonly BatchOperation[]) => boolean): HeldWrite;
  /**
   * Every read of a key `matches` accepts throws `error`, from the moment `after`
   * resolves (at once when omitted) until the returned function is called.
   * `attempts` counts the reads it failed.
   */
  failReads(
    matches: (key: string) => boolean,
    error: Error,
    after?: Promise<unknown>,
  ): { readonly stop: () => void; readonly attempts: () => number };
  /**
   * Every write that `matches` accepts throws `error` until the returned
   * function is called. `attempts` counts the writes it failed.
   */
  failWrites(
    matches: (operations: readonly BatchOperation[]) => boolean,
    error: Error,
  ): { readonly stop: () => void; readonly attempts: () => number };
  /** How many reads of keys `matches` accepts have happened so far. */
  countReads(matches: (key: string) => boolean): () => number;
}

interface ReadRule {
  readonly matches: (key: string) => boolean;
  armed: boolean;
  readonly apply: (key: string) => Promise<void>;
}

interface WriteRule {
  readonly matches: (operations: readonly BatchOperation[]) => boolean;
  armed: boolean;
  /** Runs before the write; a promise it returns is awaited before the write commits. */
  readonly apply: (operations: readonly BatchOperation[]) => void | Promise<void>;
  /** Runs once the write has committed. */
  readonly committed?: (operations: readonly BatchOperation[]) => void;
}

export function seamStorage(real: Storage): StorageSeam {
  const readRules = new Set<ReadRule>();
  const writeRules = new Set<WriteRule>();

  async function beforeRead(key: string): Promise<void> {
    for (const rule of readRules) {
      if (rule.armed && rule.matches(key)) await rule.apply(key);
    }
  }

  async function beforeWrite(operations: readonly BatchOperation[]): Promise<WriteRule[]> {
    const matched: WriteRule[] = [];
    for (const rule of writeRules) {
      if (rule.armed && rule.matches(operations)) {
        matched.push(rule);
        await rule.apply(operations);
      }
    }
    return matched;
  }

  function afterWrite(matched: readonly WriteRule[], operations: readonly BatchOperation[]): void {
    for (const rule of matched) rule.committed?.(operations);
  }

  const storage = new Proxy(real, {
    get(target, property, receiver) {
      if (property === 'get') {
        return async (key: string) => {
          await beforeRead(key);
          return target.get(key);
        };
      }
      if (property === 'scan') {
        return (prefix: string, options?: unknown) => {
          const inner = (
            target.scan as (
              prefix: string,
              options?: unknown,
            ) => AsyncIterable<[string, Uint8Array]>
          )(prefix, options);
          return (async function* () {
            await beforeRead(prefix);
            yield* inner;
          })();
        };
      }
      if (property === 'conditionalBatch') {
        return async (conditions: ConditionalBatchCondition[], operations: BatchOperation[]) => {
          const matched = await beforeWrite(operations);
          const committed = await (
            target as Storage & {
              conditionalBatch: (
                conditions: ConditionalBatchCondition[],
                operations: BatchOperation[],
              ) => Promise<boolean>;
            }
          ).conditionalBatch(conditions, operations);
          if (committed) afterWrite(matched, operations);
          return committed;
        };
      }
      if (property === 'batch') {
        return async (operations: BatchOperation[]) => {
          const matched = await beforeWrite(operations);
          await target.batch(operations);
          afterWrite(matched, operations);
        };
      }
      if (property === 'put') {
        return async (key: string, value: Uint8Array) => {
          const operations: BatchOperation[] = [{ type: 'put', key, value }];
          const matched = await beforeWrite(operations);
          await target.put(key, value);
          afterWrite(matched, operations);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return {
    storage,
    holdRead(matches, after) {
      const reached = deferred<string>();
      const proceed = deferred();
      const rule: ReadRule = {
        matches,
        armed: after === undefined,
        apply: async (key) => {
          rule.armed = false;
          readRules.delete(rule);
          reached.resolve(key);
          await proceed.promise;
        },
      };
      readRules.add(rule);
      if (after !== undefined) {
        void after.then(() => {
          rule.armed = true;
        });
      }
      return { reached: reached.promise, release: proceed.resolve };
    },
    awaitWrite(matches) {
      const seen = deferred<BatchOperation[]>();
      const rule: WriteRule = {
        matches,
        armed: true,
        apply: (operations) => {
          rule.armed = false;
          writeRules.delete(rule);
          seen.resolve([...operations]);
        },
      };
      writeRules.add(rule);
      return seen.promise;
    },
    awaitWriteCommitted(matches) {
      const seen = deferred<BatchOperation[]>();
      const rule: WriteRule = {
        matches,
        armed: true,
        apply: () => {
          rule.armed = false;
          writeRules.delete(rule);
        },
        committed: (operations) => seen.resolve([...operations]),
      };
      writeRules.add(rule);
      return seen.promise;
    },
    holdWrite(matches) {
      const reached = deferred<BatchOperation[]>();
      const proceed = deferred();
      const rule: WriteRule = {
        matches,
        armed: true,
        apply: async (operations) => {
          rule.armed = false;
          writeRules.delete(rule);
          reached.resolve([...operations]);
          await proceed.promise;
        },
      };
      writeRules.add(rule);
      return { reached: reached.promise, release: proceed.resolve };
    },
    failReads(matches, error, after) {
      let attempts = 0;
      const rule: ReadRule = {
        matches,
        armed: after === undefined,
        apply: () => {
          attempts += 1;
          return Promise.reject(error);
        },
      };
      readRules.add(rule);
      if (after !== undefined) {
        void after.then(() => {
          rule.armed = true;
        });
      }
      return {
        stop: () => {
          rule.armed = false;
          readRules.delete(rule);
        },
        attempts: () => attempts,
      };
    },
    failWrites(matches, error) {
      let attempts = 0;
      const rule: WriteRule = {
        matches,
        armed: true,
        apply: () => {
          attempts += 1;
          throw error;
        },
      };
      writeRules.add(rule);
      return {
        stop: () => {
          rule.armed = false;
          writeRules.delete(rule);
        },
        attempts: () => attempts,
      };
    },
    countReads(matches) {
      let count = 0;
      const rule: ReadRule = {
        matches,
        armed: true,
        apply: () => {
          count += 1;
          return Promise.resolve();
        },
      };
      readRules.add(rule);
      return () => count;
    },
  };
}

/** A write that admits a session input: its mailbox command record. */
export function admitsSessionInput(operations: readonly BatchOperation[]): boolean {
  return operations.some(
    (operation) => operation.type === 'put' && operation.key.startsWith('appcmd:'),
  );
}

/** A write that cancels a session input command: its record moves to `cancelled` and joins the terminal index. */
export function cancelsSessionInput(operations: readonly BatchOperation[]): boolean {
  return (
    operations.some(
      (operation) => operation.type === 'put' && operation.key.startsWith('appterm:'),
    ) &&
    operations.some(
      (operation) =>
        operation.type === 'put' &&
        operation.key.startsWith('appcmd:') &&
        textOf(operation).includes('cancelled'),
    )
  );
}

/** A write that appends a run's `run-ended` entry to its session's steering log. */
export function logsRunEnded(operations: readonly BatchOperation[]): boolean {
  return operations.some(
    (operation) =>
      operation.type === 'put' &&
      operation.key.startsWith('steering-log:v1:') &&
      textOf(operation).includes('"run-ended"'),
  );
}

/** A write that acknowledges a session input command: its record moves to `applied` and joins the terminal index. */
export function acknowledgesSessionInput(operations: readonly BatchOperation[]): boolean {
  return (
    operations.some(
      (operation) => operation.type === 'put' && operation.key.startsWith('appterm:'),
    ) &&
    operations.some(
      (operation) =>
        operation.type === 'put' &&
        operation.key.startsWith('appcmd:') &&
        textOf(operation).includes('applied'),
    )
  );
}

/** A write that appends a run's `promoted` entry to its session's steering log. */
export function logsRunPromoted(operations: readonly BatchOperation[]): boolean {
  return operations.some(
    (operation) =>
      operation.type === 'put' &&
      operation.key.startsWith('steering-log:v1:') &&
      textOf(operation).includes('"promoted"'),
  );
}

/** A read of a session's body or summary index. */
export function readsSession(key: string): boolean {
  return key.startsWith('agent-session');
}

/** A write that saves a session with the given last run status. */
export function savesSessionAs(status: string) {
  return (operations: readonly BatchOperation[]): boolean =>
    operations.some(
      (operation) =>
        operation.type === 'put' &&
        operation.key.startsWith('agent-session') &&
        textOf(operation).includes(`"lastRunStatus":"${status}"`),
    );
}

/** A read of a session's steering log head, which every liveness read begins with. */
export function readsSteeringHead(key: string): boolean {
  return key.startsWith('steering-log:v1:') && key.endsWith(':head');
}

/** A read of a session-input mailbox: its command records or its sequence index. */
export function readsMailbox(key: string): boolean {
  return key.startsWith('appcmd:') || key.startsWith('appseq:');
}

/** A read of the durable engine's workflow records or indexes, which `engine.list` and `engine.get` make. */
export function readsWorkflows(key: string): boolean {
  return key.startsWith('wf:') || key.startsWith('wf-idx-');
}

/** A read of a review's durable decision record (COR-1579). */
export function readsDecisionRecord(key: string): boolean {
  return key.startsWith('review-decision:v1:');
}

/** A write of a review's durable decision record: its claim, release, or recorded mark. */
export function writesDecisionRecord(operations: readonly BatchOperation[]): boolean {
  return operations.some((operation) => operation.key.startsWith('review-decision:v1:'));
}

/** A write that buffers a signal for a workflow: the `sig:` payload Weft commits on delivery. */
export function buffersSignal(operations: readonly BatchOperation[]): boolean {
  return operations.some(
    (operation) => operation.type === 'put' && operation.key.startsWith('sig:'),
  );
}

/** The signals still buffered for a run, delivered and not consumed. */
export async function bufferedSignals(storage: Storage, runId: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of storage.scan(`sig:${encodeStorageKeyComponent(runId)}:`)) {
    keys.push(key);
  }
  return keys;
}

/** The `review.*` audit entries recorded for one review id. */
export async function reviewAuditEntries(
  bureau: Pick<Bureau<AgentDefinitions>, 'auditTrail'>,
  runId: string,
  reviewId: string,
): Promise<Array<{ readonly type: string; readonly principal?: string | undefined }>> {
  const records = (await bureau.auditTrail?.query({ runId })) ?? [];
  return records.filter((record) => {
    if (!record.type.startsWith('review.')) return false;
    const detail = record.detail as { review?: { id?: unknown } } | null | undefined;
    return detail?.review?.id === reviewId;
  });
}

/** One Bureau process over the SQLite file at a path, sharing nothing else with any other. */
export interface OpenedProcess {
  readonly bureau: Bureau<AgentDefinitions>;
  /** The seam over this process's own connection to the file. */
  readonly seam: StorageSeam;
  /** That connection without the seam, for reading what the processes wrote. */
  readonly real: Storage;
}

/**
 * Opens a Bureau over the SQLite file at `path` through a {@link seamStorage}, as one of several
 * processes sharing that file would: each call opens its own connection and shares nothing else.
 * `options` are spread over the defaults (no agents, an empty toolbox, durable execution, and a
 * run that stops when the model calls no tool).
 */
export async function openProcess(
  path: string,
  generate: GenerateFunction,
  options: Partial<BureauOptions<AgentDefinitions>> = {},
): Promise<OpenedProcess> {
  const real = await resolveStorage({ type: 'sqlite', path });
  const seam = seamStorage(real);
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate,
        toolbox: createToolbox([]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    durable: true,
    ...options,
    storage: seam.storage,
  });
  return { bureau, seam, real };
}
