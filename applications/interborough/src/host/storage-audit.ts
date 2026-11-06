/**
 * The audit record of a storage key being deleted (the audit log's "Deleted a storage key", COR-2018).
 * A person deletes a key on Health › Storage, which calls the engine's storage routes through the
 * host's relay: `DELETE /v1/storage/<key>`, or a conditional batch holding delete operations. The
 * relay reads which keys a request would delete before it forwards it, and records a
 * `storage.key.deleted` entry for each only when the engine says the deletion happened.
 *
 * The record names the key as its resource (`storage:<key>`, whole, however long) and never its
 * value.
 */

/** The path the engine serves storage under. */
const STORAGE_PATH = '/v1/storage';

/** The path of the conditional batch, which holds puts and deletes. */
const CONDITIONAL_BATCH_PATH = `${STORAGE_PATH}/-/conditional-batch`;

/** What a request would delete if the engine accepts it. */
export interface StorageDeletion {
  /** The keys it would delete, whole. */
  readonly keys: readonly string[];
  /** Whether the engine answers `{ applied }` and a `false` means nothing was deleted. */
  readonly conditional: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The keys `request` would delete, or `undefined` for a request that deletes none. The request is
 * only read through a clone, so the relay can still forward its body.
 */
export async function storageDeletionOf(request: Request): Promise<StorageDeletion | undefined> {
  const { pathname } = new URL(request.url);
  if (request.method === 'DELETE' && pathname.startsWith(`${STORAGE_PATH}/`)) {
    const encoded = pathname.slice(STORAGE_PATH.length + 1);
    try {
      return { keys: [decodeURIComponent(encoded)], conditional: false };
    } catch {
      return undefined;
    }
  }
  if (request.method === 'POST' && pathname === CONDITIONAL_BATCH_PATH) {
    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      return undefined;
    }
    const operations = isRecord(body) ? body['operations'] : undefined;
    if (!Array.isArray(operations)) return undefined;
    const keys = operations.flatMap((operation) =>
      isRecord(operation) && operation['type'] === 'delete' && typeof operation['key'] === 'string'
        ? [operation['key']]
        : [],
    );
    return keys.length === 0 ? undefined : { keys, conditional: true };
  }
  return undefined;
}

/** Whether the engine deleted what the request asked: it answered well, and a batch says it applied. */
export async function storageDeletionApplied(
  deletion: StorageDeletion,
  response: Response,
): Promise<boolean> {
  if (!response.ok) return false;
  if (!deletion.conditional) return true;
  try {
    const body: unknown = await response.clone().json();
    return isRecord(body) && body['applied'] === true;
  } catch {
    return false;
  }
}

/** The resource a `storage.key.deleted` record is about. */
export function storageResourceOf(key: string): string {
  return `storage:${key}`;
}
