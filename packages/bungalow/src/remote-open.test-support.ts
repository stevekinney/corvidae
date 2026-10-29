/**
 * A child process that opens a remote Bungalow with the environment given as JSON in the first
 * argument and prints one JSON line about the outcome. Bun reads `AWS_SESSION_TOKEN` and
 * `S3_SESSION_TOKEN` once, at process start, so a test of the ambient session token has to start
 * a process whose own environment carries it (COR-1793).
 */
import { openBungalow } from './bungalow.ts';
import { TEST_NAME } from './fixtures.test-support.ts';

const environment: Record<string, string | undefined> = JSON.parse(process.argv[2] ?? '{}');

try {
  using bungalow = await openBungalow({ name: TEST_NAME, environment });
  const url = new URL(bungalow.s3Client()?.presign('probe') ?? 'http://invalid');
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
