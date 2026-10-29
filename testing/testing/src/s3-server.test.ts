import { describe, expect, it } from 'bun:test';

import { createS3TestServer, S3_LIST_PAGE_SIZE, type S3TestServer } from './s3-server.ts';

type Method = 'GET' | 'PUT' | 'DELETE' | 'HEAD';
type Outcome = { status: number; etag: string | null; code: string };

// The two ways a request reaches S3, and the two ways the server must accept without checking:
// `presigned` carries X-Amz-* query parameters, `header-signed` carries an Authorization header.
// `Bun.S3Client` itself is header-signed; `client.presign()` + `fetch` is the only way to send a
// condition, because `S3Client.write` ignores one (COR-1759).
type Transport = 'presigned' | 'header-signed';
const transports: readonly Transport[] = ['presigned', 'header-signed'];

async function send(
  server: S3TestServer,
  transport: Transport,
  method: Method,
  key: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Outcome> {
  const client = new Bun.S3Client(server.clientOptions());
  const url =
    transport === 'presigned'
      ? client.presign(key, { method, expiresIn: 300 })
      : `${server.endpoint}/${server.bucket}/${encodeURIComponent(key)}`;
  const response = await fetch(url, {
    method,
    headers:
      transport === 'header-signed'
        ? {
            ...headers,
            authorization:
              'AWS4-HMAC-SHA256 Credential=anything/20260101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=not-checked',
          }
        : headers,
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  return {
    status: response.status,
    etag: response.headers.get('etag'),
    code: /<Code>(.*?)<\/Code>/.exec(text)?.[1] ?? '',
  };
}

async function statusOf(url: string, init?: RequestInit): Promise<number> {
  const response = await fetch(url, init);
  await response.arrayBuffer();
  return response.status;
}

async function sendStatus(...parameters: Parameters<typeof send>): Promise<number> {
  const outcome = await send(...parameters);
  return outcome.status;
}

async function etagOf(client: Bun.S3Client, key: string): Promise<string> {
  const stat = await client.stat(key);
  return stat.etag;
}

async function storedText(server: S3TestServer, key: string) {
  const bytes = server.objects().get(key);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

describe('createS3TestServer binding and lifecycle', () => {
  it('binds 127.0.0.1 on an ephemeral port and stops on asyncDispose', async () => {
    const server = createS3TestServer();
    expect(server.hostname).toBe('127.0.0.1');
    expect(server.port).toBeGreaterThan(0);
    expect(server.endpoint).toBe(`http://127.0.0.1:${server.port}`);
    const client = new Bun.S3Client(server.clientOptions());
    expect(await client.exists('anything')).toBe(false);
    await server[Symbol.asyncDispose]();
    let reachable = true;
    try {
      await fetch(server.endpoint);
    } catch {
      reachable = false;
    }
    expect(reachable).toBe(false);
    // A second dispose is harmless.
    await server.stop();
  });

  it('works under await using', async () => {
    let endpoint = '';
    {
      await using server = createS3TestServer();
      endpoint = server.endpoint;
      expect(await statusOf(`${endpoint}/test-bucket/missing`)).toBe(404);
    }
    expect(
      await fetch(endpoint).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it('rejects a bucket name that cannot be a path segment', () => {
    expect(() => createS3TestServer({ bucket: 'a/b' })).toThrow(TypeError);
    expect(() => createS3TestServer({ bucket: '' })).toThrow(TypeError);
  });

  it('answers a request for another bucket with 404 NoSuchBucket', async () => {
    await using server = createS3TestServer({ bucket: 'mine' });
    const response = await fetch(`${server.endpoint}/other/key`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('<Code>NoSuchBucket</Code>');
  });
});

describe('objects through Bun.S3Client', () => {
  it('round-trips write, stat, exists, text, and delete with quoted ETags', async () => {
    await using server = createS3TestServer();
    const client = new Bun.S3Client(server.clientOptions());
    const file = client.file('folder/a b.txt');
    expect(await client.write('folder/a b.txt', 'hello')).toBe(5);
    expect(await file.text()).toBe('hello');
    const stat = await client.stat('folder/a b.txt');
    expect(stat.size).toBe(5);
    expect(stat.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(await client.exists('folder/a b.txt')).toBe(true);
    expect(await storedText(server, 'folder/a b.txt')).toBe('hello');
    await client.delete('folder/a b.txt');
    expect(await client.exists('folder/a b.txt')).toBe(false);
    expect(server.objects().size).toBe(0);
  });

  it('answers a missing key with NoSuchKey, exists false, and a silent delete', async () => {
    await using server = createS3TestServer();
    const client = new Bun.S3Client(server.clientOptions());
    let code = '';
    try {
      await client.file('nope').text();
    } catch (error) {
      code = (error as { code?: string }).code ?? '';
    }
    expect(code).toBe('NoSuchKey');
    expect(await client.exists('nope')).toBe(false);
    await client.delete('nope');
  });

  it('serves bytes written by put() and reports them through objects()', async () => {
    await using server = createS3TestServer();
    const client = new Bun.S3Client(server.clientOptions());
    const etag = server.put('direct', new Uint8Array([1, 2, 3]));
    expect(await etagOf(client, 'direct')).toBe(etag);
    expect(new Uint8Array(await client.file('direct').arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    // objects() is a snapshot: editing it does not edit the bucket.
    server.objects().get('direct')?.fill(9);
    server.objects().delete('direct');
    expect(server.objects().get('direct')).toEqual(new Uint8Array([1, 2, 3]));
    // put() copies its input, so a later edit by the caller does not reach the bucket.
    const mutable = new Uint8Array([4, 5]);
    server.put('copy', mutable);
    mutable.fill(0);
    expect(server.objects().get('copy')).toEqual(new Uint8Array([4, 5]));
  });
});

for (const transport of transports) {
  describe(`conditional requests, ${transport}`, () => {
    it('PUT If-None-Match: * is 200 when absent and 412 when present, keeping the original', async () => {
      await using server = createS3TestServer();
      const first = await send(server, transport, 'PUT', 'a', { 'If-None-Match': '*' }, 'v1');
      expect(first.status).toBe(200);
      expect(first.etag).toMatch(/^"[0-9a-f]{32}"$/);
      const second = await send(server, transport, 'PUT', 'a', { 'If-None-Match': '*' }, 'v2');
      expect(second).toMatchObject({ status: 412, code: 'PreconditionFailed' });
      expect(await storedText(server, 'a')).toBe('v1');
    });

    it('accepts a lowercase header name', async () => {
      await using server = createS3TestServer();
      server.put('a', 'v1');
      const outcome = await send(server, transport, 'PUT', 'a', { 'if-none-match': '*' }, 'zz');
      expect(outcome.status).toBe(412);
    });

    it('PUT If-None-Match with the current ETag is 412', async () => {
      await using server = createS3TestServer();
      const etag = server.put('a', 'v1');
      const outcome = await send(server, transport, 'PUT', 'a', { 'If-None-Match': etag }, 'zz');
      expect(outcome.status).toBe(412);
    });

    it('PUT If-Match: current ETag is 200 with a new ETag, stale is 412, absent is 404', async () => {
      await using server = createS3TestServer();
      const client = new Bun.S3Client(server.clientOptions());
      const e1 = server.put('a', 'v1');
      const current = await send(server, transport, 'PUT', 'a', { 'If-Match': e1 }, 'v2');
      expect(current.status).toBe(200);
      expect(current.etag).not.toBe(e1);
      expect(await etagOf(client, 'a')).toBe(current.etag as string);
      const stale = await send(server, transport, 'PUT', 'a', { 'If-Match': e1 }, 'v3');
      expect(stale).toMatchObject({ status: 412, code: 'PreconditionFailed' });
      expect(await storedText(server, 'a')).toBe('v2');
      const absent = await send(server, transport, 'PUT', 'absent', { 'If-Match': e1 }, 'x');
      expect(absent).toMatchObject({ status: 404, code: 'NoSuchKey' });
      expect(server.objects().has('absent')).toBe(false);
    });

    it('PUT If-Match: * on an existing key is 200', async () => {
      await using server = createS3TestServer();
      server.put('a', 'v1');
      const outcome = await send(server, transport, 'PUT', 'a', { 'If-Match': '*' }, 'v2b');
      expect(outcome.status).toBe(200);
      expect(await storedText(server, 'a')).toBe('v2b');
    });

    it('DELETE If-Match: matching is 204 and gone, stale is 412 and kept, absent is 404', async () => {
      await using server = createS3TestServer();
      const client = new Bun.S3Client(server.clientOptions());
      const etag = server.put('d', 'd1');
      const stale = await send(server, transport, 'DELETE', 'd', {
        'If-Match': '"00000000000000000000000000000000"',
      });
      expect(stale).toMatchObject({ status: 412, code: 'PreconditionFailed' });
      expect(await client.exists('d')).toBe(true);
      const matching = await send(server, transport, 'DELETE', 'd', { 'If-Match': etag });
      expect(matching.status).toBe(204);
      expect(await client.exists('d')).toBe(false);
      const absent = await send(server, transport, 'DELETE', 'absent', { 'If-Match': etag });
      expect(absent).toMatchObject({ status: 404, code: 'NoSuchKey' });
    });

    it('DELETE of an absent key without a condition is 204', async () => {
      await using server = createS3TestServer();
      expect(await sendStatus(server, transport, 'DELETE', 'nope')).toBe(204);
    });

    it('GET and HEAD of an absent key are 404, with NoSuchKey only on GET', async () => {
      await using server = createS3TestServer();
      expect(await send(server, transport, 'GET', 'nope')).toMatchObject({
        status: 404,
        code: 'NoSuchKey',
      });
      expect(await send(server, transport, 'HEAD', 'nope')).toMatchObject({
        status: 404,
        code: '',
      });
    });

    it('GET If-Match with a stale ETag is 412, and a current one is 200', async () => {
      await using server = createS3TestServer();
      const client = new Bun.S3Client(server.clientOptions());
      const etag = server.put('a', 'v1');
      server.put('a', 'v2');
      expect(await send(server, transport, 'GET', 'a', { 'If-Match': etag })).toMatchObject({
        status: 412,
        code: 'PreconditionFailed',
      });
      const current = await etagOf(client, 'a');
      expect(await sendStatus(server, transport, 'GET', 'a', { 'If-Match': current })).toBe(200);
    });

    it('GET If-None-Match with the current ETag is 304', async () => {
      await using server = createS3TestServer();
      const etag = server.put('a', 'v1');
      expect(await sendStatus(server, transport, 'GET', 'a', { 'If-None-Match': etag })).toBe(304);
    });

    it('lets exactly one of many concurrent If-None-Match: * writes win', async () => {
      await using server = createS3TestServer();
      // Multi-megabyte bodies take several event-loop turns to arrive, so every writer's headers
      // are in before the first body completes. A server that checks the condition before it has
      // read the body lets every writer see an absent key. Load only lengthens the overlap.
      const body = 'x'.repeat(2_000_000);
      const outcomes = await Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          send(server, transport, 'PUT', 'race', { 'If-None-Match': '*' }, `${index}${body}`),
        ),
      );
      expect(outcomes.filter((outcome) => outcome.status === 200)).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 412)).toHaveLength(15);
      expect(server.objects().size).toBe(1);
    });
  });
}

describe('ListObjectsV2', () => {
  it('lists a prefix in key order with ETags that equal stat()', async () => {
    await using server = createS3TestServer();
    const client = new Bun.S3Client(server.clientOptions());
    server.put('logs/b', 'bb');
    server.put('logs/a', 'a');
    server.put('other/x', 'x');
    const page = await client.list({ prefix: 'logs/' });
    expect(page.contents?.map((entry) => entry.key)).toEqual(['logs/a', 'logs/b']);
    expect(page.isTruncated).toBe(false);
    expect(page.nextContinuationToken).toBeUndefined();
    expect(page.contents?.[0]?.eTag).toBe(await etagOf(client, 'logs/a'));
    expect(page.contents?.[1]?.size).toBe(2);
  });

  it('pages 1,001 objects as 1,000 plus 1 through continuation tokens', async () => {
    await using server = createS3TestServer();
    const client = new Bun.S3Client(server.clientOptions());
    for (let index = 0; index <= S3_LIST_PAGE_SIZE; index += 1)
      server.put(`list/o${String(index).padStart(4, '0')}`, 'x');
    server.put('elsewhere', 'x');
    const first = await client.list({ prefix: 'list/' });
    expect(first.contents).toHaveLength(1000);
    expect(first.isTruncated).toBe(true);
    expect(first.nextContinuationToken).toBeTruthy();
    const keys = new Set(first.contents?.map((entry) => entry.key));
    let token = first.nextContinuationToken;
    let pages = 1;
    let everyEtag = first.contents?.every((entry) => entry.eTag) === true;
    while (token) {
      const page = await client.list({ prefix: 'list/', continuationToken: token });
      pages += 1;
      for (const entry of page.contents ?? []) {
        keys.add(entry.key);
        everyEtag &&= Boolean(entry.eTag);
      }
      token = page.nextContinuationToken;
    }
    expect(keys.size).toBe(1001);
    expect(pages).toBe(2);
    expect(everyEtag).toBe(true);
  });

  it('honors a smaller max-keys and never exceeds the page size', async () => {
    await using server = createS3TestServer();
    const client = new Bun.S3Client(server.clientOptions());
    for (let index = 0; index < 5; index += 1) server.put(`k${index}`, 'x');
    const small = await client.list({ maxKeys: 2 });
    expect(small.contents?.map((entry) => entry.key)).toEqual(['k0', 'k1']);
    expect(small.isTruncated).toBe(true);
    const response = await fetch(`${server.endpoint}/test-bucket?list-type=2&max-keys=99999`);
    expect(await response.text()).toContain(`<MaxKeys>${S3_LIST_PAGE_SIZE}</MaxKeys>`);
  });

  it('is reachable through a presigned URL and escapes XML in keys', async () => {
    await using server = createS3TestServer();
    const client = new Bun.S3Client(server.clientOptions());
    server.put('a&b<c>', 'x');
    // `presign` refuses an empty key, so borrow a presigned object URL and re-aim it at the bucket;
    // the server does not check the signature, which is the behavior under test.
    const url = new URL(client.presign('any', { method: 'GET', expiresIn: 300 }));
    url.pathname = `/${server.bucket}`;
    url.searchParams.set('list-type', '2');
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<Key>a&amp;b&lt;c&gt;</Key>');
  });

  it('accepts a header-signed list request with an Authorization header', async () => {
    await using server = createS3TestServer();
    server.put('a', 'x');
    const response = await fetch(`${server.endpoint}/test-bucket?list-type=2`, {
      headers: { authorization: 'AWS4-HMAC-SHA256 Credential=anything, Signature=not-checked' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<Key>a</Key>');
  });

  it('rejects a malformed max-keys or continuation token with 400', async () => {
    await using server = createS3TestServer();
    const base = `${server.endpoint}/test-bucket?list-type=2`;
    const maxKeys = await fetch(`${base}&max-keys=lots`);
    expect(maxKeys.status).toBe(400);
    expect(await maxKeys.text()).toContain('<Code>InvalidArgument</Code>');
    expect(await statusOf(`${base}&continuation-token=***`)).toBe(400);
  });
});

describe('request validation', () => {
  it('answers a malformed percent escape with 400, not a crash', async () => {
    await using server = createS3TestServer();
    const response = await fetch(`${server.endpoint}/test-bucket/bad%E0%A4%A`);
    expect(response.status).toBe(400);
  });

  it('refuses unsupported methods and bucket operations', async () => {
    await using server = createS3TestServer();
    expect(await statusOf(`${server.endpoint}/test-bucket/key`, { method: 'POST' })).toBe(405);
    expect(await statusOf(`${server.endpoint}/test-bucket`, { method: 'PUT' })).toBe(501);
  });
});
