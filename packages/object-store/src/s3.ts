import {
  failure,
  guarded,
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
function unescapeXml(text: string): string {
  return text
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
function parseListing(xml: string): ListedPage {
  const truncated = textElement(xml, 'IsTruncated');
  if (truncated !== 'true' && truncated !== 'false') throw new Error('MalformedListing');
  const objects: ListedObject[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
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
  const token = textElement(xml, 'NextContinuationToken');
  if (truncated === 'true' && (token === undefined || token === ''))
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
        if (!response.ok) throw failure('LIST', prefix, response.status);
        try {
          return parseListing(text);
        } catch {
          throw failure('LIST', prefix, 502);
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
        if (!response.ok) throw failure('GET', key, await drain(response));
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
        throw failure('PUT', key, status);
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
        throw failure('DELETE', key, status);
      }),
  };
}

export type { ObjectStoreOperations, ObjectWriteCondition };
