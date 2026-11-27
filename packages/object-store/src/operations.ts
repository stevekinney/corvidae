/** The portable object-store contract. */

export type ListedObject = {
  readonly key: string;
  readonly etag: string;
  readonly size: number;
};

export type ListedPage = {
  readonly objects: readonly ListedObject[];
  readonly nextContinuationToken?: string | undefined;
};

export type ObjectWriteCondition =
  { readonly kind: 'absent' } | { readonly kind: 'etag'; readonly etag: string };

/** Operations available on both S3-compatible stores and Cloudflare R2 bindings. */
export interface ObjectStoreOperations {
  list(prefix: string, continuationToken?: string): Promise<ListedPage>;
  read(key: string): Promise<{ readonly bytes: Uint8Array; readonly etag: string } | undefined>;
  put(
    key: string,
    bytes: Uint8Array,
    condition: ObjectWriteCondition,
  ): Promise<{ readonly outcome: 'written' } | { readonly outcome: 'refused' }>;
}

/** The S3-specific extension. Cloudflare R2 deliberately does not implement conditional delete. */
export interface S3ObjectStoreOperations extends ObjectStoreOperations {
  remove(key: string, etag: string): Promise<'removed' | 'refused'>;
}

/** A redacted error from an object-store request. It contains no request URL or credentials. */
export class ObjectStoreError extends Error {
  override readonly name = 'ObjectStoreError';
  readonly code: string;
  readonly status: number | undefined;
  constructor(code: string, status: number | undefined, operation?: string, key?: string) {
    const subject =
      operation === undefined || key === undefined
        ? 'request'
        : `${operation} ${safeObjectKey(key)}`;
    super(`The object store ${subject} failed (${code}).`);
    this.code = code;
    this.status = status;
  }
}

export function failure(
  status: number,
  code = `HTTP${status}`,
  operation?: string,
  key?: string,
): ObjectStoreError {
  return new ObjectStoreError(code, status, operation, key);
}

function safeObjectKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._/-]/g, '_');
}

function errorCode(error: unknown): string {
  const candidates: unknown[] =
    typeof error === 'object' && error !== null
      ? [(error as { code?: unknown }).code, (error as { name?: unknown }).name]
      : [];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(candidate)) return candidate;
  }
  return 'unknown';
}

export async function guarded<T>(
  operation: string,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ObjectStoreError) throw error;
    throw new ObjectStoreError(errorCode(error), undefined, operation, key);
  }
}
