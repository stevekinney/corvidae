import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { ensureDirectory, readEntry, writePrivateFile } from './entry-guard.ts';
import { sanitizeCause } from './error-code.ts';
import { BungalowError, BungalowInputError } from './errors.ts';
import { assertSecretKey } from './validation.ts';

/** Durable publication states for a prepared secret version. */
export type SecretOperationState =
  'prepared' | 'publishing' | 'published' | 'abandoned' | 'unknown';
/** Capabilities advertised by a provider. */
export type SecretProviderCapabilities = Readonly<{
  read: true;
  prepare: boolean;
  transitions: boolean;
}>;
/** Opaque, workspace-bound identity of one immutable secret version. */
export type SecretReference = Readonly<{
  readonly serialized: string;
  readonly workspaceId: string;
  readonly key: string;
  readonly version: string;
}>;
/** Redacted recovery metadata for one preparation operation. */
export type SecretOperationMetadata = Readonly<{
  readonly id: string;
  readonly workspaceId: string;
  readonly key: string;
  readonly reference: SecretReference;
  readonly expectedRevision: string | null;
  readonly state: SecretOperationState;
}>;
/** Inputs bound to one idempotent preparation operation. */
export type PrepareSecretInput = Readonly<{
  operationId: string;
  key: string;
  value: string;
  /** SHA-256 of the complete logical request, including plaintext before encoding.
   * The integrator computes this digest; matching retries may use different ciphertext.
   * Providers retain it only in private immutable payloads, never operation metadata.
   */
  requestDigest: string;
  expectedRevision: string | null;
}>;
/** Conditional transitions permitted by the publication state machine. */
export type SecretOperationTransition =
  | { readonly from: 'prepared'; readonly to: 'publishing' | 'abandoned' }
  | { readonly from: 'publishing'; readonly to: 'published' | 'abandoned' | 'unknown' }
  | { readonly from: 'unknown'; readonly to: 'published' };

/** Stable categories for provider failures. */
export type SecretProviderErrorCode =
  'rejected' | 'read-only' | 'unavailable' | 'conflict' | 'missing';
/** Typed provider failure with a redacted message and stable category. */
export class SecretProviderError extends BungalowError {
  /** Failure category safe for management projections. */
  readonly code: SecretProviderErrorCode;
  constructor(code: SecretProviderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** Workspace-bound asynchronous secret provider contract. */
export type SecretProvider = Readonly<{
  readonly workspaceId: string;
  readonly capabilities: SecretProviderCapabilities;
  readLegacy(key: string): Promise<string | undefined>;
  readVersion(reference: SecretReference | string): Promise<string>;
  prepare(input: PrepareSecretInput): Promise<SecretOperationMetadata>;
  getOperation(id: string): Promise<SecretOperationMetadata | undefined>;
  listOperations(): Promise<readonly SecretOperationMetadata[]>;
  transitionOperation(
    id: string,
    transition: SecretOperationTransition,
  ): Promise<SecretOperationMetadata>;
  reclaim(reference: SecretReference | string): Promise<void>;
}>;

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const VERSION_PATTERN = /^[A-Za-z0-9_-]{1,163}$/;
const PREFIX = 'bungalow-secret-v1.';
const STATES = new Set<SecretOperationState>([
  'prepared',
  'publishing',
  'published',
  'abandoned',
  'unknown',
]);

/** Validate a workspace identity before either provider accesses values. */
export function assertWorkspace(workspaceId: string): void {
  if (typeof workspaceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workspaceId)) {
    throw new BungalowInputError('A workspace identity is required.');
  }
}
function assertOperationId(id: string): void {
  if (typeof id !== 'string' || !ID_PATTERN.test(id))
    throw new BungalowInputError('An operation identifier is invalid.');
}
function assertInput(input: PrepareSecretInput): void {
  assertOperationId(input.operationId);
  assertSecretKey(input.key);
  if (
    typeof input.value !== 'string' ||
    typeof input.requestDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.requestDigest) ||
    (input.expectedRevision !== null &&
      (typeof input.expectedRevision !== 'string' || input.expectedRevision.length === 0))
  ) {
    throw new BungalowInputError('A secret value and expected revision are required.');
  }
}
function encode(reference: Omit<SecretReference, 'serialized'>): SecretReference {
  const payload = JSON.stringify([reference.workspaceId, reference.key, reference.version]);
  return { ...reference, serialized: PREFIX + Buffer.from(payload).toString('base64url') };
}
/** Validate and decode an opaque reference without accessing a backend. */
export function parseSecretReference(
  value: SecretReference | string,
  workspaceId: string,
): SecretReference {
  const serialized =
    typeof value === 'string'
      ? value
      : value !== null && typeof value === 'object'
        ? value.serialized
        : undefined;
  if (typeof serialized !== 'string' || !serialized.startsWith(PREFIX))
    throw new SecretProviderError('rejected', 'The secret reference is invalid.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(serialized.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new SecretProviderError('rejected', 'The secret reference is invalid.');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    parsed.some((part) => typeof part !== 'string') ||
    parsed[0] !== workspaceId ||
    !KEY_PATTERN.test(parsed[1]) ||
    !VERSION_PATTERN.test(parsed[2])
  ) {
    throw new SecretProviderError('rejected', 'The secret reference is invalid.');
  }
  const reference = encode({ workspaceId: parsed[0], key: parsed[1], version: parsed[2] });
  if (reference.serialized !== serialized)
    throw new SecretProviderError('rejected', 'The secret reference is invalid.');
  if (
    typeof value !== 'string' &&
    (value.workspaceId !== reference.workspaceId ||
      value.key !== reference.key ||
      value.version !== reference.version)
  )
    throw new SecretProviderError('rejected', 'The secret reference is invalid.');
  return reference;
}
function metadata(value: unknown): SecretOperationMetadata {
  if (typeof value !== 'object' || value === null)
    throw new SecretProviderError('unavailable', 'The operation record is invalid.');
  const operationRecord = value as Record<string, unknown>;
  if (
    typeof operationRecord['id'] !== 'string' ||
    typeof operationRecord['workspaceId'] !== 'string' ||
    typeof operationRecord['key'] !== 'string' ||
    (operationRecord['expectedRevision'] !== null &&
      typeof operationRecord['expectedRevision'] !== 'string') ||
    typeof operationRecord['state'] !== 'string' ||
    !STATES.has(operationRecord['state'] as SecretOperationState)
  )
    throw new SecretProviderError('unavailable', 'The operation record is invalid.');
  const reference = parseSecretReference(
    String(operationRecord['reference']),
    operationRecord['workspaceId'],
  );
  return {
    id: operationRecord['id'],
    workspaceId: operationRecord['workspaceId'],
    key: operationRecord['key'],
    reference,
    expectedRevision: operationRecord['expectedRevision'],
    state: operationRecord['state'] as SecretOperationState,
  };
}
function record(operation: SecretOperationMetadata): string {
  return (
    JSON.stringify({
      id: operation.id,
      workspaceId: operation.workspaceId,
      key: operation.key,
      reference: operation.reference.serialized,
      expectedRevision: operation.expectedRevision,
      state: operation.state,
    }) + '\n'
  );
}
function isValidTransition(transition: SecretOperationTransition): boolean {
  return (
    (transition.from === 'prepared' &&
      (transition.to === 'publishing' || transition.to === 'abandoned')) ||
    (transition.from === 'publishing' &&
      (transition.to === 'published' ||
        transition.to === 'abandoned' ||
        transition.to === 'unknown')) ||
    (transition.from === 'unknown' && transition.to === 'published')
  );
}
function fsError(description: string, error: unknown): never {
  if (error instanceof SecretProviderError) throw error;
  throw new SecretProviderError('unavailable', `Could not ${description}.`, {
    cause: sanitizeCause(error),
  });
}

/** Construction inputs for the durable local provider. */
export type LocalSecretProviderOptions = Readonly<{
  root: string;
  workspaceId: string;
  assertOpen?: () => void;
}>;
/** Create a provider backed by guarded local version and operation files. */
export function createLocalSecretProvider(options: LocalSecretProviderOptions): SecretProvider {
  const workspaceId = options.workspaceId;
  assertWorkspace(workspaceId);
  const assertOpen = options.assertOpen ?? (() => undefined);
  const versions = join(options.root, '.managed-secrets', 'versions');
  const operations = join(options.root, '.managed-secrets', 'operations');
  const workspacePath = join(options.root, '.managed-secrets', 'workspace-id');
  try {
    ensureDirectory(join(options.root, '.managed-secrets'), 'managed secret directory', {
      privateMode: true,
    });
    ensureDirectory(versions, 'secret versions directory', { privateMode: true });
    ensureDirectory(operations, 'secret operations directory', { privateMode: true });
    const existingWorkspace = readEntry(workspacePath, 'secret workspace identity');
    if (existingWorkspace !== undefined && existingWorkspace.trim() !== workspaceId)
      throw new SecretProviderError(
        'rejected',
        'The local secret store belongs to another workspace.',
      );
    if (existingWorkspace === undefined) writePrivateFile(workspacePath, `${workspaceId}\n`);
  } catch (error) {
    fsError('prepare secret storage', error);
  }
  const operationPath = (id: string) => join(operations, `${id}.json`);
  const versionPath = (version: string) => join(versions, version);
  const readVersionPayload = (version: string) => {
    try {
      const text = readEntry(versionPath(version), 'secret version', 0o600);
      if (text === undefined) return undefined;
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid version');
      const value = parsed as Record<string, unknown>;
      if (
        value['workspaceId'] !== workspaceId ||
        typeof value['key'] !== 'string' ||
        !KEY_PATTERN.test(value['key']) ||
        typeof value['operationId'] !== 'string' ||
        !ID_PATTERN.test(value['operationId']) ||
        version !== `op-${value['operationId']}` ||
        (value['expectedRevision'] !== null && typeof value['expectedRevision'] !== 'string') ||
        (value['requestDigest'] !== undefined &&
          (typeof value['requestDigest'] !== 'string' ||
            !/^[a-f0-9]{64}$/.test(value['requestDigest']))) ||
        typeof value['value'] !== 'string'
      )
        throw new Error('Invalid version');
      return value as {
        workspaceId: string;
        key: string;
        operationId: string;
        expectedRevision: string | null;
        value: string;
        requestDigest?: string;
      };
    } catch (error) {
      return fsError('read secret version', error);
    }
  };
  const readOperation = (id: string) => {
    try {
      const text = readEntry(operationPath(id), 'secret operation');
      if (text !== undefined) {
        const operation = metadata(JSON.parse(text));
        if (
          operation.id !== id ||
          operation.workspaceId !== workspaceId ||
          operation.reference.key !== operation.key
        ) {
          throw new SecretProviderError('unavailable', 'The operation record is invalid.');
        }
        return operation;
      }
      const payload = readVersionPayload(`op-${id}`);
      if (payload === undefined) return undefined;
      const recovered: SecretOperationMetadata = {
        id,
        workspaceId,
        key: payload.key,
        reference: encode({ workspaceId, key: payload.key, version: `op-${id}` }),
        expectedRevision: payload.expectedRevision,
        state: 'prepared',
      };
      writeOperation(recovered);
      return recovered;
    } catch (error) {
      return fsError('read secret operation', error);
    }
  };
  const writeOperation = (operation: SecretOperationMetadata) => {
    try {
      writePrivateFile(operationPath(operation.id), record(operation));
    } catch (error) {
      fsError('write secret operation', error);
    }
  };
  return {
    workspaceId: workspaceId,
    capabilities: { read: true, prepare: true, transitions: true },
    async readLegacy(key) {
      assertOpen();
      assertSecretKey(key);
      try {
        return readEntry(join(options.root, 'secrets', key), 'secret file', 0o600);
      } catch (error) {
        return fsError('read secret', error);
      }
    },
    async readVersion(input) {
      assertOpen();
      const reference = parseSecretReference(input, workspaceId);
      try {
        const payload = readVersionPayload(reference.version);
        if (payload === undefined)
          throw new SecretProviderError('missing', 'The secret version is unavailable.');
        if (payload.key !== reference.key)
          throw new SecretProviderError('rejected', 'The secret reference is invalid.');
        return payload.value;
      } catch (error) {
        return fsError('read secret version', error);
      }
    },
    async prepare(input) {
      assertOpen();
      const snapshot = { ...input };
      assertInput(snapshot);
      const existing = readOperation(snapshot.operationId);
      if (existing !== undefined) {
        const payload = readVersionPayload(existing.reference.version);
        if (
          existing.key !== snapshot.key ||
          existing.expectedRevision !== snapshot.expectedRevision ||
          payload?.requestDigest !== snapshot.requestDigest
        )
          throw new SecretProviderError(
            'conflict',
            'The operation identifier is already bound to different input.',
          );
        return existing;
      }
      const reference = encode({
        workspaceId: workspaceId,
        key: snapshot.key,
        version: `op-${snapshot.operationId}`,
      });
      try {
        const payload = {
          workspaceId: workspaceId,
          key: snapshot.key,
          operationId: snapshot.operationId,
          expectedRevision: snapshot.expectedRevision,
          value: snapshot.value,
          requestDigest: snapshot.requestDigest,
        };
        const existingPayload = readVersionPayload(reference.version);
        if (
          existingPayload !== undefined &&
          (existingPayload.key !== snapshot.key ||
            existingPayload.expectedRevision !== snapshot.expectedRevision ||
            existingPayload.requestDigest !== snapshot.requestDigest)
        ) {
          throw new SecretProviderError(
            'conflict',
            'The operation identifier is already bound to different input.',
          );
        }
        // One atomic private-file replacement binds the value and all idempotency inputs.
        // The separate operation journal remains redacted and can be recovered from this payload.
        if (existingPayload === undefined)
          writePrivateFile(versionPath(reference.version), `${JSON.stringify(payload)}\n`);
      } catch (error) {
        fsError('write secret version', error);
      }
      const operation: SecretOperationMetadata = {
        id: snapshot.operationId,
        workspaceId: workspaceId,
        key: snapshot.key,
        reference,
        expectedRevision: snapshot.expectedRevision,
        state: 'prepared',
      };
      writeOperation(operation);
      return operation;
    },
    async getOperation(id) {
      assertOpen();
      assertOperationId(id);
      return readOperation(id);
    },
    async listOperations() {
      assertOpen();
      const versionIds = regularFileNames(versions)
        .filter((name) => name.startsWith('op-'))
        .map((name) => name.slice(3))
        .filter((id) => ID_PATTERN.test(id));
      return [...new Set([...readdirSafe(operations), ...versionIds])]
        .map((id) => readOperation(id))
        .filter((value): value is SecretOperationMetadata => value !== undefined);
    },
    async transitionOperation(id, transition) {
      assertOpen();
      assertOperationId(id);
      if (!isValidTransition(transition))
        throw new SecretProviderError('rejected', 'The secret operation transition is invalid.');
      const existing = readOperation(id);
      if (existing === undefined)
        throw new SecretProviderError('missing', 'The secret operation is unavailable.');
      if (existing.state !== transition.from)
        throw new SecretProviderError('conflict', 'The secret operation has already transitioned.');
      const next = { ...existing, state: transition.to };
      writeOperation(next);
      return next;
    },
    async reclaim(input) {
      assertOpen();
      const reference = parseSecretReference(input, workspaceId);
      const storedOperations = await this.listOperations();
      const operation = storedOperations.find(
        (item) => item.reference.serialized === reference.serialized,
      );
      if (operation === undefined || operation.state !== 'abandoned')
        throw new SecretProviderError('conflict', 'The secret version cannot be reclaimed.');
      try {
        rmSync(versionPath(reference.version), { force: true });
      } catch (error) {
        fsError('reclaim secret version', error);
      }
    },
  };
}

/**
 * The names of the regular files directly in `directory`, as a `*` glob matches them: no
 * subdirectory, no symbolic link (which is not followed), and no name starting with `.`.
 */
function regularFileNames(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
}

function readdirSafe(directory: string): string[] {
  try {
    return regularFileNames(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5));
  } catch (error) {
    return fsError('list secret operations', error);
  }
}
