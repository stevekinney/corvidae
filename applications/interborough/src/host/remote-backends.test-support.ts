import {
  requireOpenedPostgresTestDatabase,
  type PostgresTestDatabase,
} from '@lostgradient/testing/postgres-server';
import type { S3TestServer } from '@lostgradient/testing/s3-server';

/** The secret that signs approvals, for the remote hosts a test starts; every host must share it. */
export const TEST_APPROVAL_SECRET = 'remote-test-approval-secret-0123456789abcdef';

/**
 * A database no earlier run touched, on the server `database` names: a supplied server is shared
 * between runs, so a suite makes its own. `password` is put in the returned URL, which a trusting
 * test server ignores, so a test can check that no credential reaches what a host reports.
 */
export async function createFreshDatabaseUrl(
  database: PostgresTestDatabase | null,
  password = '',
): Promise<string> {
  const base = requireOpenedPostgresTestDatabase(database);
  const name = `interborough_${crypto.randomUUID().replaceAll('-', '')}`;
  const administrator = new Bun.SQL(base.url);
  try {
    await administrator.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await administrator.close();
  }
  const url = new URL(base.url);
  url.pathname = `/${name}`;
  if (password !== '') url.password = password;
  return url.toString();
}

/** The environment of a remote host: the database, the bucket under `prefix`, and the approval secret. */
export function remoteEnvironment(
  databaseUrl: string,
  server: S3TestServer,
  prefix: string,
): Record<string, string> {
  const client = server.clientOptions();
  return {
    INTERBOROUGH_DATABASE_URL: databaseUrl,
    INTERBOROUGH_BUCKET: client.bucket,
    INTERBOROUGH_BUCKET_PREFIX: prefix,
    S3_ENDPOINT: client.endpoint,
    S3_REGION: client.region,
    S3_ACCESS_KEY_ID: client.accessKeyId,
    S3_SECRET_ACCESS_KEY: client.secretAccessKey,
    INTERBOROUGH_SECRET_APPROVAL_SECRET: TEST_APPROVAL_SECRET,
  };
}
