/**
 * The object-store client a remote Bungalow hands out: presigned URLs and `ListObjectsV2`, over a
 * presigner and `fetch`, so it runs wherever both do. Its shape is the part of `Bun.S3Client` that
 * callers use (`presign` and `list`), so code written against that subset accepts it unchanged.
 *
 * @module object-store
 */
import type { ObjectPresigner, PresignOptions } from './presign.ts';

/** What {@link BungalowObjectStore.list} takes, as `Bun.S3Client.list` does. */
export type ObjectListInput = {
  /** Only keys that start with this. */
  readonly prefix?: string;
  /** At most this many keys on the page; the store's own limit applies when omitted. */
  readonly maxKeys?: number;
  /** The `nextContinuationToken` of the page before. */
  readonly continuationToken?: string;
  /** Only keys after this one. */
  readonly startAfter?: string;
};

/** One object a listing named. */
export type ListedObjectEntry = {
  /** The full key, prefix included. */
  key: string;
  /** The ETag as the store sent it, quotes included. */
  eTag?: string;
  /** The size in bytes. */
  size?: number;
  /** When the object was last written, as the store sent it. */
  lastModified?: string;
};

/** One page of a listing. */
export type ObjectListing = {
  /** The objects on this page, in the store's order. */
  contents?: ListedObjectEntry[];
  /** Whether more pages follow. */
  isTruncated?: boolean;
  /** Present when the listing was truncated: pass it to the next call. */
  nextContinuationToken?: string;
  /** How many keys this page holds. */
  keyCount?: number;
};

/** The object-store client of a remote home: presigned URLs, and listing. */
export type BungalowObjectStore = {
  /** A presigned URL for `key` in the home's bucket, or `options.bucket`. */
  presign(key: string, options?: PresignOptions): string;
  /** One page of `ListObjectsV2` over the home's bucket, or `options.bucket`. */
  list(
    input?: ObjectListInput | null,
    options?: { readonly bucket?: string },
  ): Promise<ObjectListing>;
};

/**
 * What a failed listing rejects with: the store's error code, or `HTTP<status>` when its answer
 * carried none, and the status. Never the URL, which carries the access key ID and a signature.
 */
export class ObjectStoreRequestError extends Error {
  /** Always `'ObjectStoreRequestError'`. */
  override readonly name = 'ObjectStoreRequestError';
  /** The store's error code, or `HTTP<status>`, or the code of a failure that produced no answer. */
  readonly code: string;
  /** The HTTP status, when the store answered. */
  readonly status: number | undefined;
  constructor(code: string, status: number | undefined) {
    super(`The object store request failed (${code}).`);
    this.code = code;
    this.status = status;
  }
}

/** How long a listing's presigned URL stays valid; it is signed just before it is sent. */
const LIST_PRESIGN_SECONDS = 60;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Undo XML escaping: the five named entities and numeric character references. */
function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return Object.hasOwn(ENTITIES, entity) ? (ENTITIES[entity] ?? whole) : whole;
  });
}

/** The decoded text of the first `<name>` element in `xml`, or `undefined`. */
function element(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match?.[1] === undefined ? undefined : decodeXml(match[1]);
}

/** Read a `ListBucketResult` document. */
export function parseListing(xml: string): ObjectListing {
  const contents: ListedObjectEntry[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1] ?? '';
    const key = element(block, 'Key');
    if (key === undefined) continue;
    const entry: ListedObjectEntry = { key };
    const eTag = element(block, 'ETag');
    if (eTag !== undefined) entry.eTag = eTag;
    const size = element(block, 'Size');
    if (size !== undefined && /^\d+$/.test(size)) entry.size = Number(size);
    const lastModified = element(block, 'LastModified');
    if (lastModified !== undefined) entry.lastModified = lastModified;
    contents.push(entry);
  }
  const listing: ObjectListing = { contents, isTruncated: element(xml, 'IsTruncated') === 'true' };
  const token = element(xml, 'NextContinuationToken');
  if (token !== undefined) listing.nextContinuationToken = token;
  const keyCount = element(xml, 'KeyCount');
  if (keyCount !== undefined && /^\d+$/.test(keyCount)) listing.keyCount = Number(keyCount);
  return listing;
}

/** The object-store client over `presign`, which signs for the home's bucket unless told another. */
export function createObjectStore(presign: ObjectPresigner): BungalowObjectStore {
  return {
    presign: (key, options) => presign(key, options),
    async list(input, options = {}) {
      const query: Record<string, string> = { 'list-type': '2' };
      if (input?.prefix !== undefined) query['prefix'] = input.prefix;
      if (input?.maxKeys !== undefined) query['max-keys'] = String(input.maxKeys);
      if (input?.continuationToken !== undefined) {
        query['continuation-token'] = input.continuationToken;
      }
      if (input?.startAfter !== undefined) query['start-after'] = input.startAfter;
      const url = presign('', {
        method: 'GET',
        expiresIn: LIST_PRESIGN_SECONDS,
        query,
        ...(options.bucket === undefined ? {} : { bucket: options.bucket }),
      });
      let response: Response;
      try {
        response = await fetch(url);
      } catch (error) {
        throw new ObjectStoreRequestError(codeOf(error), undefined);
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        throw new ObjectStoreRequestError(codeOf(error), response.status);
      }
      if (!response.ok) {
        const code = element(text, 'Code');
        throw new ObjectStoreRequestError(
          code !== undefined && /^[A-Za-z0-9_.-]{1,64}$/.test(code)
            ? code
            : `HTTP${response.status}`,
          response.status,
        );
      }
      return parseListing(text);
    },
  };
}

/** A short identifier for a thrown value, so a URL can never ride along in a message. */
function codeOf(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : 'unknown';
}
