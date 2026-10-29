/**
 * COR-1762 — a failed object-store request throws an error that carries no URL, query string, or
 * credential. Bun's raw fetch error holds the full presigned URL in `path`, which includes the
 * access key ID and a signature valid for 300 seconds.
 */
import { describe, expect, it } from 'bun:test';

import { createS3ObjectOperations, type ObjectStoreOperations } from './object-operations';

const ACCESS_KEY_ID = 'AKIACORVIDAEEXAMPLE';
const SECRET_ACCESS_KEY = 'secret-access-key-for-the-test-only';

/** Every own property of `value`, recursively and including `cause`, plus its string and stack. */
function serialize(value: unknown, seen = new Set<unknown>()): string {
  if (typeof value !== 'object' || value === null) return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const parts: string[] = [];
  if (value instanceof Error) parts.push(value.toString(), value.stack ?? '');
  for (const name of Object.getOwnPropertyNames(value)) {
    parts.push(name, serialize((value as Record<string, unknown>)[name], seen));
  }
  return parts.join('\n');
}

async function closedPort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error('The probe server has no port.');
  return port;
}

const requests: Array<[string, (operations: ObjectStoreOperations) => Promise<unknown>]> = [
  ['list', (operations) => operations.list('definitions/')],
  ['read', (operations) => operations.read('definitions/helper.md')],
  [
    'put',
    (operations) =>
      operations.put('definitions/helper.md', new Uint8Array([1]), { kind: 'absent' }),
  ],
  ['remove', (operations) => operations.remove('definitions/helper.md', '"etag"')],
];

describe('a failed object-store request', () => {
  it.each(requests)(
    '%s throws an error with no URL, query string, or credential',
    async (_name, request) => {
      const endpoint = `http://127.0.0.1:${await closedPort()}`;
      const client = new Bun.S3Client({
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
        bucket: 'bucket',
        endpoint,
      });
      const thrown = await request(createS3ObjectOperations(client, 'bucket', 'text/plain')).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(thrown).toBeInstanceOf(Error);
      const text = serialize(thrown);
      for (const secret of ['X-Amz-', ACCESS_KEY_ID, SECRET_ACCESS_KEY, '?', endpoint]) {
        expect(text.includes(secret), `leaks ${secret}`).toBe(false);
      }
      expect(text).toContain('definitions/');
      expect((thrown as Error).cause).toBeUndefined();
    },
  );
});
