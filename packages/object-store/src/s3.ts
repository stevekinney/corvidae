import { SaxesParser } from 'saxes';
import {
  failure,
  guarded,
  ObjectStoreError,
  type ListedObject,
  type ListedPage,
  type S3ObjectStoreOperations,
} from './operations.ts';
import type { ObjectPresigner } from './presign.ts';

const PRESIGNED_URL_LIFETIME_SECONDS = 300;

async function drain(response: Response): Promise<number> {
  await response.arrayBuffer();
  return response.status;
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

type XmlNode = { readonly name: string; readonly children: XmlNode[]; text: string };

/** Parse the listing as XML so malformed tokens and nested extension fields cannot impersonate root fields. */
function parseXml(xml: string): XmlNode {
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  const parser = new SaxesParser();
  parser.on('opentag', (tag) => {
    const node: XmlNode = { name: tag.name, children: [], text: '' };
    if (stack.length === 0) {
      if (root !== undefined) throw new Error('MalformedListing');
      root = node;
    } else {
      stack.at(-1)?.children.push(node);
    }
    stack.push(node);
  });
  const appendText = (text: string): void => {
    const current = stack.at(-1);
    if (current !== undefined) current.text += text;
    else if (text.trim() !== '') throw new Error('MalformedListing');
  };
  parser.on('text', appendText);
  parser.on('cdata', appendText);
  parser.on('closetag', () => {
    if (stack.pop() === undefined) throw new Error('MalformedListing');
  });
  try {
    parser.write(xml).close();
  } catch {
    throw new Error('MalformedListing');
  }
  if (root === undefined || stack.length !== 0) throw new Error('MalformedListing');
  return root;
}

function direct(node: XmlNode, name: string): readonly XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

function field(node: XmlNode, name: string, required = false): string | undefined {
  const fields = direct(node, name);
  if (fields.length > 1 || (required && fields.length !== 1)) throw new Error('MalformedListing');
  const found = fields[0];
  if (found === undefined) return undefined;
  if (found.children.length !== 0) throw new Error('MalformedListing');
  return unescapeXml(found.text);
}

function parseListing(xml: string): ListedPage {
  const root = parseXml(xml);
  if (root.name !== 'ListBucketResult') throw new Error('MalformedListing');
  const truncated = field(root, 'IsTruncated', true);
  if (truncated !== 'true' && truncated !== 'false') throw new Error('MalformedListing');
  const objects: ListedObject[] = [];
  for (const contents of direct(root, 'Contents')) {
    const key = field(contents, 'Key', true);
    if (key === undefined || key === '') throw new Error('MalformedListing');
    const size = field(contents, 'Size');
    objects.push({
      key,
      etag: field(contents, 'ETag') ?? '',
      size: size !== undefined && /^\d+$/.test(size) ? Number(size) : 0,
    });
  }
  const token = field(root, 'NextContinuationToken');
  if (truncated === 'true' && (token === undefined || token === ''))
    throw new Error('MalformedListing');
  const keyCount = field(root, 'KeyCount');
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
        if (!response.ok) {
          throw failure(response.status, errorCodeFromBody(text, response.status), 'LIST', prefix);
        }
        try {
          return parseListing(text);
        } catch {
          throw new ObjectStoreError('MalformedListing', undefined, 'LIST', prefix);
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
        if (!response.ok) throw failure(await drain(response), undefined, 'GET', key);
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
        throw failure(status, undefined, 'PUT', key);
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
        throw failure(status, undefined, 'DELETE', key);
      }),
  };
}

function errorCodeFromBody(text: string, status: number): string {
  try {
    const code = field(parseXml(text), 'Code');
    return code !== undefined && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : `HTTP${status}`;
  } catch {
    return `HTTP${status}`;
  }
}
