/**
 * The object-store requests an S3 definition source makes, behind one seam so a test can record
 * or interleave them (COR-1762). The default is a caller-supplied `Bun.S3Client`: Bureau builds no
 * client and reads no credentials or environment.
 *
 * Every object request is a presigned URL sent with `fetch`, `GET` included, so one response
 * carries a read's bytes and ETag together. `S3Client.write` ignores a conditional header and
 * overwrites (COR-1759), so a conditional write cannot go through it; a presigned URL sent with
 * `If-None-Match: *` or `If-Match: <etag>` is honored.
 *
 * @module object-operations
 */

/** Where an S3 definition source keeps its objects. */
export interface ObjectLocation {
  /** The bucket. */
  readonly bucket: string;
  /** The key prefix every definition's object sits directly under, such as `agents/`. */
  readonly prefix: string;
}

/** The part of `Bun.S3Client` an S3 definition source uses. A `Bun.S3Client` satisfies it. */
export type ObjectStoreClient = Pick<Bun.S3Client, 'presign' | 'list'>;

/** One object a listing named. */
export interface ListedObject {
  /** The object's full key in the bucket, prefix included. */
  readonly key: string;
  /** The ETag as the store returned it, quotes included. */
  readonly etag: string;
  /** The object's size in bytes, or `0` when the store did not report one. */
  readonly size: number;
}

/** One page of a listing. */
export interface ListedPage {
  /** The objects this page named, in the order the store listed them. */
  readonly objects: readonly ListedObject[];
  /** Present when the listing was truncated; pass it to the next call. */
  readonly nextContinuationToken?: string | undefined;
}

/** What a conditional write requires of the key: that it is absent, or that it has this ETag. */
export type ObjectWriteCondition =
  { readonly kind: 'absent' } | { readonly kind: 'etag'; readonly etag: string };

/** The requests an S3 definition source makes. */
export interface ObjectStoreOperations {
  /** One page of the keys under `prefix`, continued with `continuationToken`. */
  list(prefix: string, continuationToken?: string): Promise<ListedPage>;
  /** An object's bytes and ETag from one response, or `undefined` when the key is absent. */
  read(key: string): Promise<{ readonly bytes: Uint8Array; readonly etag: string } | undefined>;
  /**
   * Write `bytes` when `condition` holds. `refused` means the condition did not (a `412`) or the
   * key a `If-Match` named is gone (a `404`); nothing was written.
   */
  put(
    key: string,
    bytes: Uint8Array,
    condition: ObjectWriteCondition,
  ): Promise<{ readonly outcome: 'written' } | { readonly outcome: 'refused' }>;
  /** Delete `key` when its ETag is still `etag`. `refused` as for {@link ObjectStoreOperations.put}. */
  remove(key: string, etag: string): Promise<'removed' | 'refused'>;
}

const PRESIGNED_URL_LIFETIME_SECONDS = 300;

/** Read a response to the end so its connection is released, and return its status. */
async function drain(response: Response): Promise<number> {
  await response.arrayBuffer();
  return response.status;
}

/**
 * What every request of {@link createS3ObjectOperations} throws. It names the operation, the key,
 * and a status or an error code, and nothing else: no URL, query string, or credential, and no
 * `cause`. Bun's own errors carry the full presigned URL in `path` (the access key ID and a
 * signature valid for 300 seconds), and a diagnostics sink that prints an error's properties would
 * log a usable credential.
 */
export class ObjectStoreError extends Error {
  override readonly name = 'ObjectStoreError';
}

function failure(method: string, key: string, status: number): ObjectStoreError {
  return new ObjectStoreError(`The object store answered ${status} to ${method} ${key}.`);
}

/** The error's `code` (or `name`) when it is a short identifier, so a URL can never ride along. */
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

/**
 * Run one request, and turn anything it throws that is not already an {@link ObjectStoreError}
 * into one that keeps only the operation, the key, and the error's code.
 */
async function guarded<T>(operation: string, key: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ObjectStoreError) throw error;
    throw new ObjectStoreError(
      `The object store request ${operation} ${key} failed (${errorCode(error)}).`,
    );
  }
}

/** {@link ObjectStoreOperations} over a caller-supplied `Bun.S3Client`. */
export function createS3ObjectOperations(
  client: ObjectStoreClient,
  bucket: string,
  contentType: string,
): ObjectStoreOperations {
  function url(key: string, method: 'GET' | 'PUT' | 'DELETE'): string {
    return client.presign(key, { method, bucket, expiresIn: PRESIGNED_URL_LIFETIME_SECONDS });
  }

  return {
    async list(prefix, continuationToken) {
      const page = await guarded('LIST', prefix, () =>
        client.list(
          { prefix, ...(continuationToken === undefined ? {} : { continuationToken }) },
          { bucket },
        ),
      );
      const objects: ListedObject[] = [];
      for (const item of page.contents ?? []) {
        objects.push({ key: item.key, etag: item.eTag ?? '', size: item.size ?? 0 });
      }
      return { objects, nextContinuationToken: page.nextContinuationToken };
    },

    read: (key) =>
      guarded('GET', key, async () => {
        const response = await fetch(url(key, 'GET'));
        if (response.status === 404) {
          await drain(response);
          return undefined;
        }
        if (!response.ok) throw failure('GET', key, await drain(response));
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { bytes, etag: response.headers.get('etag') ?? '' };
      }),

    put: (key, bytes, condition) =>
      guarded('PUT', key, async () => {
        const response = await fetch(url(key, 'PUT'), {
          method: 'PUT',
          headers: {
            'content-type': contentType,
            ...(condition.kind === 'absent'
              ? { 'if-none-match': '*' }
              : { 'if-match': condition.etag }),
          },
          // A copy typed over a plain ArrayBuffer, which is what `fetch` accepts as a body.
          body: new Uint8Array(bytes),
        });
        const status = await drain(response);
        if (response.ok) return { outcome: 'written' } as const;
        if (status === 412 || (status === 404 && condition.kind === 'etag')) {
          return { outcome: 'refused' } as const;
        }
        throw failure('PUT', key, status);
      }),

    remove: (key, etag) =>
      guarded('DELETE', key, async () => {
        const response = await fetch(url(key, 'DELETE'), {
          method: 'DELETE',
          headers: { 'if-match': etag },
        });
        const status = await drain(response);
        if (response.ok) return 'removed' as const;
        if (status === 412 || status === 404) return 'refused' as const;
        throw failure('DELETE', key, status);
      }),
  };
}
