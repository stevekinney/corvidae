/**
 * A child process that opens a remote Bungalow with the environment given as JSON in the first
 * argument and prints one JSON line about the outcome. Bun reads `AWS_SESSION_TOKEN` and
 * `S3_SESSION_TOKEN` once, at process start, so a test of the ambient session token has to start
 * a process whose own environment carries it (COR-1793).
 *
 * With `bun-presigner` as the second argument the open injects a presigner over `Bun.S3Client`,
 * which falls back to that ambient token; otherwise it uses the default, which reads no
 * environment.
 */
import { openBungalow, type PresignerFactory } from './bungalow.ts';
import { TEST_NAME } from './fixtures.test-support.ts';
import { createSigV4Presigner } from './presign.ts';

const environment: Record<string, string | undefined> = JSON.parse(process.argv[2] ?? '{}');

const bunPresigner: PresignerFactory = (descriptor) => {
  const client = new Bun.S3Client({
    endpoint: descriptor.endpoint,
    region: descriptor.region,
    accessKeyId: descriptor.accessKeyId,
    secretAccessKey: descriptor.secretAccessKey,
    ...(descriptor.sessionToken === undefined ? {} : { sessionToken: descriptor.sessionToken }),
    bucket: descriptor.bucket,
    virtualHostedStyle: false,
  });
  // `Bun.S3Client.presign` refuses an empty key and drops `query`, so it cannot sign a listing;
  // a presigner must, and this one hands listings to the default.
  const listing = createSigV4Presigner(descriptor);
  return (key, options) => (key === '' ? listing(key, options) : client.presign(key, options));
};

try {
  using bungalow = await openBungalow({
    name: TEST_NAME,
    environment,
    databaseWorkspaceClaim: async () => {},
    ...(process.argv[3] === 'bun-presigner' ? { presigner: bunPresigner } : {}),
  });
  const url = new URL(bungalow.objectStore()?.presign('probe') ?? 'http://invalid');
  process.stdout.write(
    `${JSON.stringify({
      outcome: 'opened',
      deploymentId: bungalow.deploymentId,
      sessionToken: url.searchParams.get('X-Amz-Security-Token'),
    })}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      outcome: 'failed',
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : '',
    })}\n`,
  );
}
