import { createSigV4Presigner } from '@lostgradient/object-store';
import { openBungalow, type PresignerFactory } from '../src/bungalow.ts';
import { TEST_NAME } from '../src/fixtures.test-support.ts';

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
  process.stdout.write(`${JSON.stringify({ outcome: 'opened', deploymentId: bungalow.deploymentId, sessionToken: null })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ outcome: 'failed', name: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message : '' })}\n`);
}
