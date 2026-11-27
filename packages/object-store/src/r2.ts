import { failure, guarded, type ListedPage, type ObjectStoreOperations } from './operations.ts';

/** The structural subset of an R2 binding used by this package. No Cloudflare runtime package is required. */
export interface R2Bucket {
  list(options?: { readonly prefix?: string; readonly cursor?: string }): Promise<{
    readonly objects: readonly {
      readonly key: string;
      readonly size: number;
      readonly httpEtag: string;
    }[];
    readonly truncated: boolean;
    readonly cursor?: string | undefined;
  }>;
  get(key: string): Promise<{
    readonly httpEtag: string;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
  put(
    key: string,
    value: Uint8Array,
    options: { readonly onlyIf: Headers },
  ): Promise<{ readonly httpEtag: string } | null>;
}

/** Create operations over an R2 binding. R2 exposes no conditional delete operation here. */
export function createR2ObjectOperations(bucket: R2Bucket): ObjectStoreOperations {
  return {
    list: (prefix, continuationToken) =>
      guarded('LIST', prefix, async (): Promise<ListedPage> => {
        const page = await bucket.list({
          prefix,
          ...(continuationToken === undefined ? {} : { cursor: continuationToken }),
        });
        if (page.truncated && (page.cursor === undefined || page.cursor === '')) {
          throw failure(502, undefined, 'LIST', prefix);
        }
        return {
          objects: page.objects.map(({ key, size, httpEtag }) => ({ key, size, etag: httpEtag })),
          ...(page.cursor === undefined ? {} : { nextContinuationToken: page.cursor }),
        };
      }),
    read: (key) =>
      guarded('GET', key, async () => {
        const object = await bucket.get(key);
        if (object === null) return undefined;
        return { bytes: new Uint8Array(await object.arrayBuffer()), etag: object.httpEtag };
      }),
    put: (key, bytes, condition) =>
      guarded('PUT', key, async () => {
        const result = await bucket.put(key, new Uint8Array(bytes), {
          onlyIf: new Headers(
            condition.kind === 'absent' ? { 'if-none-match': '*' } : { 'if-match': condition.etag },
          ),
        });
        return result === null ? { outcome: 'refused' } : { outcome: 'written' };
      }),
  };
}
