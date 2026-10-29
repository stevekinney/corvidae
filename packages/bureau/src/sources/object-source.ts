/**
 * The S3-backed {@link DefinitionSource} that `agentObjectSource` and `workflowObjectSource` are
 * built on (COR-1762): one object per definition under a key prefix, the key's name minus the
 * extension as the identifier, loaded and polled through `polled-objects.ts`.
 *
 * `DefinitionEntry.hash` and every `expectedHash` are the SHA-256 of the bytes, as in every source.
 * An object's ETag is used for nothing but the condition on a write or delete: the source reads
 * the object, checks the hash of what it read, and sends that read's ETag as `If-Match` (or
 * `If-None-Match: *` to create), so the store, not this process, fences the change. A refusal
 * (`412`, or `404` for a key that vanished) reads the object again, and rejects with a
 * {@link SourceConflictError} carrying the hash of what is there now, or `null` when nothing is.
 *
 * @module object-source
 */

import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';

import {
  type DefinitionEntry,
  type DefinitionSource,
  type DefinitionSourceHost,
  hashDefinitionBytes,
  SourceConflictError,
} from './definition-source';
import {
  createS3ObjectOperations,
  type ObjectLocation,
  type ObjectStoreClient,
  type ObjectStoreOperations,
  type ObjectWriteCondition,
} from './object-operations';
import { OBJECT_POLL_INTERVAL_MILLISECONDS, createPolledObjects } from './polled-objects';
import { assertSafeIdentifier } from './safe-identifier';

/** The options both object-source constructors take. */
export interface ObjectSourceOptions {
  /**
   * The `Bun.S3Client` the objects are read and written through. The caller builds it, credentials
   * included; Bureau reads no environment and never sees a credential.
   */
  readonly client: ObjectStoreClient;
  /** How often the prefix is rescanned, in milliseconds. Defaults to 1000. */
  readonly pollIntervalMilliseconds?: number | undefined;
  /**
   * Poll for changes. Defaults to `true`; `false` means no timer, and a change is picked up by the
   * next `load()`.
   */
  readonly watch?: boolean | undefined;
  /** The runtime whose timers drive the poll. Defaults to the Bureau's, or the real clock. */
  readonly runtime?: RuntimeServices | undefined;
  /** Where poll failures are reported. Defaults to the Bureau's channel. */
  readonly diagnose?: ((message: string, cause: unknown) => void) | undefined;
  /** The object-store requests, behind one seam so a test can record or interleave them. */
  readonly operations?: ObjectStoreOperations | undefined;
}

export interface ObjectSourceShape {
  readonly location: ObjectLocation;
  /** What the prefix holds, for diagnostics: `agent object source`. */
  readonly label: string;
  /** The extension a key must end in exactly, such as `.md`. */
  readonly extension: string;
  /** The largest object read, in bytes. */
  readonly sizeLimit: number;
  /** The `Content-Type` written objects carry. */
  readonly contentType: string;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`"${name}" must be a string.`);
  return value;
}

/** Check the arguments at the exported boundary; the type annotations do not guard a JavaScript caller. */
function validate(
  location: ObjectLocation,
  options: ObjectSourceOptions,
): { readonly bucket: string; readonly prefix: string; readonly pollInterval: number } {
  if (typeof location !== 'object' || location === null) {
    throw new TypeError('"location" must be { bucket, prefix }.');
  }
  const bucket = requireString(location.bucket, 'location.bucket');
  const prefix = requireString(location.prefix, 'location.prefix');
  if (bucket === '') throw new TypeError('"location.bucket" must not be empty.');
  if (prefix.startsWith('/')) throw new TypeError('"location.prefix" must not start with "/".');
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('The options must include a "client".');
  }
  const { client } = options;
  if (
    typeof client !== 'object' ||
    client === null ||
    typeof client.presign !== 'function' ||
    typeof client.list !== 'function'
  ) {
    throw new TypeError('"options.client" must be a Bun.S3Client.');
  }
  const pollInterval = options.pollIntervalMilliseconds ?? OBJECT_POLL_INTERVAL_MILLISECONDS;
  if (!Number.isFinite(pollInterval) || pollInterval <= 0) {
    throw new TypeError('"options.pollIntervalMilliseconds" must be a positive number.');
  }
  return {
    bucket,
    // A prefix is a folder: `agents` and `agents/` both mean the objects directly under `agents/`.
    prefix: prefix === '' || prefix.endsWith('/') ? prefix : `${prefix}/`,
    pollInterval,
  };
}

/** A {@link DefinitionSource} over the objects under a key prefix. */
export function createObjectSource(
  shape: ObjectSourceShape,
  options: ObjectSourceOptions,
): DefinitionSource {
  // Everything the source reads from the caller's objects is taken now, before any await.
  const { bucket, prefix, pollInterval } = validate(shape.location, options);
  const operations =
    options.operations ?? createS3ObjectOperations(options.client, bucket, shape.contentType);
  const { extension } = shape;
  const keyOf = (id: string): string => `${prefix}${id}${extension}`;
  let host: DefinitionSourceHost | undefined;
  let fallbackRuntime: RuntimeServices | undefined;
  const diagnose = options.diagnose;
  const polled = createPolledObjects({
    operations,
    prefix,
    label: shape.label,
    extension,
    sizeLimit: shape.sizeLimit,
    pollIntervalMilliseconds: pollInterval,
    runtime: () =>
      options.runtime ?? host?.runtime ?? (fallbackRuntime ??= createDefaultRuntimeServices()),
    diagnose: (message: string, cause: unknown) => {
      const report = diagnose ?? host?.diagnose;
      if (report !== undefined) report(message, cause);
      else process.stderr.write(`[bureau] ${message} ${String(cause)}\n`);
    },
    ...(options.watch === undefined ? {} : { watch: options.watch }),
  });

  /** The conflict for a refused change: what the object is now, read again. */
  async function conflict(id: string, expectedHash: string | null): Promise<SourceConflictError> {
    const current = await operations.read(keyOf(id));
    return new SourceConflictError(
      id,
      expectedHash,
      current === undefined ? null : hashDefinitionBytes(current.bytes),
    );
  }

  let subscribers = 0;

  return {
    attach(lent) {
      host = lent;
    },

    async load(): Promise<readonly DefinitionEntry[]> {
      await polled.refresh();
      return [...polled.entries().values()];
    },

    watch(listener) {
      const unsubscribe = polled.onChange(listener);
      subscribers += 1;
      if (subscribers === 1) polled.startWatching();
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        unsubscribe();
        subscribers -= 1;
        if (subscribers === 0) polled.stopWatching();
      };
    },

    async write(id, bytes, { expectedHash }) {
      assertSafeIdentifier(id);
      // The caller owns `bytes`; the write reads them after awaits, so it works from a copy.
      const owned = bytes.slice();
      const key = keyOf(id);
      let condition: ObjectWriteCondition = { kind: 'absent' };
      if (expectedHash !== null) {
        const current = await operations.read(key);
        const actual = current === undefined ? null : hashDefinitionBytes(current.bytes);
        if (current === undefined || actual !== expectedHash) {
          throw new SourceConflictError(id, expectedHash, actual);
        }
        condition = { kind: 'etag', etag: current.etag };
      }
      const result = await operations.put(key, owned, condition);
      if (result.outcome === 'refused') throw await conflict(id, expectedHash);
      return { id, bytes: owned, hash: hashDefinitionBytes(owned) };
    },

    async delete(id, { expectedHash }) {
      assertSafeIdentifier(id);
      const key = keyOf(id);
      const current = await operations.read(key);
      const actual = current === undefined ? null : hashDefinitionBytes(current.bytes);
      if (current === undefined || actual !== expectedHash) {
        throw new SourceConflictError(id, expectedHash, actual);
      }
      if ((await operations.remove(key, current.etag)) === 'refused') {
        throw await conflict(id, expectedHash);
      }
    },
  };
}
