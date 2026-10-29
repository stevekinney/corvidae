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
  readonly key: string;
  /** The ETag as the store returned it, quotes included. */
  readonly etag: string;
  readonly size: number;
}

/** One page of a listing. */
export interface ListedPage {
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

function failure(method: string, key: string, status: number): Error {
  return new Error(`The object store answered ${status} to ${method} ${key}.`);
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
      const page = await client.list(
        { prefix, ...(continuationToken === undefined ? {} : { continuationToken }) },
        { bucket },
      );
      const objects: ListedObject[] = [];
      for (const item of page.contents ?? []) {
        objects.push({ key: item.key, etag: item.eTag ?? '', size: item.size ?? 0 });
      }
      return { objects, nextContinuationToken: page.nextContinuationToken };
    },

    async read(key) {
      const response = await fetch(url(key, 'GET'));
      if (response.status === 404) {
        await drain(response);
        return undefined;
      }
      if (!response.ok) throw failure('GET', key, await drain(response));
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { bytes, etag: response.headers.get('etag') ?? '' };
    },

    async put(key, bytes, condition) {
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
      if (response.ok) return { outcome: 'written' };
      if (status === 412 || (status === 404 && condition.kind === 'etag')) {
        return { outcome: 'refused' };
      }
      throw failure('PUT', key, status);
    },

    async remove(key, etag) {
      const response = await fetch(url(key, 'DELETE'), {
        method: 'DELETE',
        headers: { 'if-match': etag },
      });
      const status = await drain(response);
      if (response.ok) return 'removed';
      if (status === 412 || status === 404) return 'refused';
      throw failure('DELETE', key, status);
    },
  };
}
