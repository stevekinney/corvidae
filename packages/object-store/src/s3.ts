import {
  failure,
  guarded,
  ObjectStoreError,
  type ListedObject,
  type ListedPage,
  type ObjectStoreOperations,
  type ObjectWriteCondition,
  type S3ObjectStoreOperations,
} from './operations.ts';
import type { ObjectPresigner } from './presign.ts';

const PRESIGNED_URL_LIFETIME_SECONDS = 300;

async function drain(response: Response): Promise<number> {
  await response.arrayBuffer();
  return response.status;
}

function textElement(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match?.[1];
}
const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};
function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return Object.hasOwn(ENTITIES, entity) ? (ENTITIES[entity] ?? whole) : whole;
  });
}
function parseListing(xml: string): ListedPage {
  const body = xml.trim();
  const openings = (name: string) => body.match(new RegExp(`<${name}[\\s>]`, 'g'))?.length ?? 0;
  if (
    openings('ListBucketResult') !== 1 ||
    !/<ListBucketResult[\s>]/.test(body) ||
    !body.endsWith('</ListBucketResult>')
  )
    throw new Error('MalformedListing');
  const truncated = textElement(body, 'IsTruncated');
  if (truncated !== 'true' && truncated !== 'false') throw new Error('MalformedListing');
  const objects: ListedObject[] = [];
  const blocks = [...body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)];
  if (blocks.length !== openings('Contents')) throw new Error('MalformedListing');
  for (const match of blocks) {
    const body = match[1] ?? '';
    const key = textElement(body, 'Key');
    if (key === undefined || key === '') throw new Error('MalformedListing');
    const size = textElement(body, 'Size');
    objects.push({
      key: unescapeXml(key),
      etag: unescapeXml(textElement(body, 'ETag') ?? ''),
      size: size !== undefined && /^\d+$/.test(size) ? Number(size) : 0,
    });
  }
  const token = textElement(body, 'NextContinuationToken');
  if (truncated === 'true' && (token === undefined || token === ''))
    throw new Error('MalformedListing');
  const keyCount = textElement(body, 'KeyCount');
  if (keyCount !== undefined && (!/^\d+$/.test(keyCount) || Number(keyCount) !== objects.length))
    throw new Error('MalformedListing');
  return { objects, ...(token === undefined ? {} : { nextContinuationToken: unescapeXml(token) }) };
}

export type CreateS3ObjectOperationsOptions = {
  readonly presigner: ObjectPresigner;
  readonly bucket: string;
  readonly contentType: string;
  readonly fetch?: typeof globalThis.fetch;
};

/** Create conditional S3 operations. All object reads and writes use signed fetch requests. */
export function createS3ObjectOperations(
  options: CreateS3ObjectOperationsOptions,
): S3ObjectStoreOperations {
  const send = options.fetch ?? globalThis.fetch;
  const url = (key: string, method: 'GET' | 'PUT' | 'DELETE', query?: Record<string, string>) =>
    options.presigner(key, {
      method,
      bucket: options.bucket,
      expiresIn: PRESIGNED_URL_LIFETIME_SECONDS,
      ...(query === undefined ? {} : { query }),
    });
  return {
    async list(prefix, continuationToken) {
      return guarded('LIST', prefix, async () => {
        const response = await send(
          url('', 'GET', {
            'list-type': '2',
            prefix,
            ...(continuationToken === undefined ? {} : { 'continuation-token': continuationToken }),
          }),
        );
        const text = await response.text();
        if (!response.ok) throw failure(response.status, errorCodeFromBody(text, response.status));
        try {
          return parseListing(text);
        } catch {
          throw new ObjectStoreError('MalformedListing', undefined);
        }
      });
    },
    read: (key) =>
      guarded('GET', key, async () => {
        const response = await send(url(key, 'GET'));
        if (response.status === 404) {
          await drain(response);
          return undefined;
        }
        if (!response.ok) throw failure(await drain(response));
        return {
          bytes: new Uint8Array(await response.arrayBuffer()),
          etag: response.headers.get('etag') ?? '',
        };
      }),
    put: (key, bytes, condition) =>
      guarded('PUT', key, async () => {
        const response = await send(url(key, 'PUT'), {
          method: 'PUT',
          headers: {
            'content-type': options.contentType,
            ...(condition.kind === 'absent'
              ? { 'if-none-match': '*' }
              : { 'if-match': condition.etag }),
          },
          body: new Uint8Array(bytes),
        });
        const status = await drain(response);
        if (response.ok) return { outcome: 'written' } as const;
        if (status === 412 || (status === 404 && condition.kind === 'etag'))
          return { outcome: 'refused' } as const;
        throw failure(status);
      }),
    remove: (key, etag) =>
      guarded('DELETE', key, async () => {
        const response = await send(url(key, 'DELETE'), {
          method: 'DELETE',
          headers: { 'if-match': etag },
        });
        const status = await drain(response);
        if (response.ok) return 'removed' as const;
        if (status === 412 || status === 404) return 'refused' as const;
        throw failure(status);
      }),
  };
}

function errorCodeFromBody(text: string, status: number): string {
  const code = textElement(text, 'Code');
  return code !== undefined && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : `HTTP${status}`;
}

export type { ObjectStoreOperations, ObjectWriteCondition };
