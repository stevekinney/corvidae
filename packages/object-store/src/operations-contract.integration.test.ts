import { createS3TestServer } from '@lostgradient/testing/s3-server';
import { withWorker } from '@lostgradient/workerd-testing';
import { describe, expect, test } from 'bun:test';

import { ObjectStoreError } from './operations.ts';
import { createSigV4Presigner } from './presign.ts';
import type { R2Bucket } from './r2.ts';
import { createR2ObjectOperations } from './r2.ts';
import { createS3ObjectOperations } from './s3.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('object-store operations contract', () => {
  test('S3 paginates, reads, conditionally writes and conditionally removes', async () => {
    await using server = createS3TestServer();
    server.put('a', 'a');
    server.put('b', 'b');
    const operations = createS3ObjectOperations({
      bucket: server.bucket,
      contentType: 'text/plain',
      presigner: createSigV4Presigner(server.clientOptions()),
    });
    const page = await operations.list('');
    expect(page.objects.map(({ key }) => key)).toEqual(['a', 'b']);
    for (let index = 0; index < 1_001; index += 1) {
      server.put(`page/${String(index).padStart(4, '0')}`, String(index));
    }
    const firstPage = await operations.list('page/');
    expect(firstPage.objects).toHaveLength(1_000);
    const nextPage = await operations.list('page/', firstPage.nextContinuationToken);
    expect(nextPage.objects).toHaveLength(1);
    const first = await operations.read('a');
    expect(decoder.decode(first?.bytes)).toBe('a');
    expect(await operations.put('new', encoder.encode('first'), { kind: 'absent' })).toEqual({
      outcome: 'written',
    });
    expect(await operations.put('new', encoder.encode('second'), { kind: 'absent' })).toEqual({
      outcome: 'refused',
    });
    expect(
      await operations.put('new', encoder.encode('stale'), { kind: 'etag', etag: '"stale"' }),
    ).toEqual({ outcome: 'refused' });
    const current = await operations.read('new');
    expect(
      await operations.put('new', encoder.encode('current'), {
        kind: 'etag',
        etag: current?.etag ?? '',
      }),
    ).toEqual({ outcome: 'written' });
    expect(await operations.remove('new', '"stale"')).toBe('refused');
    const currentForRemove = await operations.read('new');
    expect(await operations.remove('new', currentForRemove?.etag ?? '')).toBe('removed');
  });

  test('R2 conditionally writes and exposes no delete operation', async () => {
    await withWorker(
      { entry: new URL('./r2-fixture.ts', import.meta.url).pathname, r2Buckets: ['BUCKET'] },
      async ({ getR2Bucket }) => {
        const operations = createR2ObjectOperations(
          (await getR2Bucket('BUCKET')) as unknown as R2Bucket,
        );
        expect('remove' in operations).toBe(false);
        expect(await operations.put('key', encoder.encode('first'), { kind: 'absent' })).toEqual({
          outcome: 'written',
        });
        expect(await operations.put('key', encoder.encode('second'), { kind: 'absent' })).toEqual({
          outcome: 'refused',
        });
        const first = await operations.read('key');
        expect(
          await operations.put('key', encoder.encode('stale'), { kind: 'etag', etag: '"stale"' }),
        ).toEqual({ outcome: 'refused' });
        expect(
          await operations.put('key', encoder.encode('current'), {
            kind: 'etag',
            etag: first?.etag ?? '',
          }),
        ).toEqual({ outcome: 'written' });
        const current = await operations.read('key');
        expect(decoder.decode(current?.bytes)).toBe('current');
      },
    );
  });

  test('redacts failing request URLs and credentials', async () => {
    const operations = createS3ObjectOperations({
      bucket: 'bucket',
      contentType: 'text/plain',
      presigner: createSigV4Presigner({
        endpoint: 'http://127.0.0.1:1',
        region: 'us-east-1',
        accessKeyId: 'credential',
        secretAccessKey: 'secret',
        bucket: 'bucket',
      }),
    });
    const error = await operations.read('key').then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ObjectStoreError);
    expect(String(error)).not.toContain('credential');
    expect(String(error)).not.toContain('127.0.0.1');
    expect(String(error)).not.toContain('?');
  });
});
