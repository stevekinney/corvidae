import { describe, expect, test } from 'bun:test';

import { ObjectStoreError } from './operations.ts';
import { createS3ObjectOperations } from './s3.ts';

function operations(response: Response) {
  return createS3ObjectOperations({
    bucket: 'bucket',
    contentType: 'text/plain',
    presigner: () => 'https://objects.example.test/bucket?credential=secret',
    fetch: (async () => response) as unknown as typeof globalThis.fetch,
  });
}

async function rejectionOf(action: Promise<unknown>): Promise<unknown> {
  return action.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('S3 object operations', () => {
  test.each([
    '<ListBucketResult><Extension><IsTruncated>false</IsTruncated></Extension></ListBucketResult>',
    '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult><',
    '<ListBucketResult><IsTruncated>false</IsTruncated><KeyCount>1</KeyCount></ListBucketResult>',
  ])('rejects malformed listings before a caller can treat them as empty: %s', async (body) => {
    const error = await rejectionOf(operations(new Response(body)).list('definitions/'));
    expect(error).toBeInstanceOf(ObjectStoreError);
    expect((error as ObjectStoreError).code).toBe('MalformedListing');
  });

  test('retains the object prefix while redacting the signed request', async () => {
    const error = await rejectionOf(
      operations(new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })).list(
        'definitions/',
      ),
    );
    expect(error).toBeInstanceOf(ObjectStoreError);
    expect(String(error)).toContain('definitions/');
    expect(String(error)).not.toContain('objects.example.test');
    expect(String(error)).not.toContain('secret');
  });

  test('decodes XML entities once and keeps the continuation token opaque', async () => {
    const queries: Array<Record<string, string> | undefined> = [];
    const responses = [
      new Response(
        '<ListBucketResult><IsTruncated>true</IsTruncated><KeyCount>2</KeyCount><Contents><Key>research&amp;amp;dev</Key></Contents><Contents><Key>standard&amp;key</Key></Contents><NextContinuationToken>cursor&amp;amp;next</NextContinuationToken></ListBucketResult>',
      ),
      new Response(
        '<ListBucketResult><IsTruncated>false</IsTruncated><KeyCount>0</KeyCount></ListBucketResult>',
      ),
    ];
    const store = createS3ObjectOperations({
      bucket: 'bucket',
      contentType: 'text/plain',
      presigner: (_key, options) => {
        queries.push(options.query);
        return 'https://objects.example.test/bucket';
      },
      fetch: (async () =>
        responses.shift() ?? new Response('', { status: 500 })) as unknown as typeof fetch,
    });

    const first = await store.list('research/');
    expect(first.objects.map(({ key }) => key)).toEqual(['research&amp;dev', 'standard&key']);
    expect(first.nextContinuationToken).toBe('cursor&amp;next');
    await store.list('research/', first.nextContinuationToken);
    expect(queries[1]?.['continuation-token']).toBe('cursor&amp;next');
  });
});
