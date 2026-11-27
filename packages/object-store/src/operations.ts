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
}

export function failure(operation: string, key: string, status: number): ObjectStoreError {
  return new ObjectStoreError(`The object store answered ${status} to ${operation} ${key}.`);
}

export function errorCode(error: unknown): string {
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
    throw new ObjectStoreError(
      `The object store request ${operation} ${key} failed (${errorCode(error)}).`,
    );
  }
}
