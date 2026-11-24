import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectPages, immutableSnapshot } from './ci-run-accounting.ts';

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('invalid provider object');
  return value as JsonObject;
}

/** Persist raw provider responses outside the report, keyed by the full authenticated request. */
export function provider(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let calls = 0;
  const path = (key: string) =>
    join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  const storage = {
    read(key: string): string | undefined {
      try {
        return readFileSync(path(key), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    write(key: string, value: string): void {
      writeFileSync(path(key), value, { flag: 'wx', mode: 0o600 });
    },
  };
  return {
    calls: () => calls,
    async get(endpoint: string): Promise<JsonObject> {
      const value = await immutableSnapshot(endpoint, storage, async () => {
        calls += 1;
        try {
          return execFileSync('gh', ['api', endpoint], {
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
          });
        } catch {
          throw new Error(`provider request failed: ${endpoint}`);
        }
      });
      return object(value);
    },
    async graphql(query: string, search: string, cursor: string | null): Promise<JsonObject> {
      const args = ['graphql', '-f', `query=${query}`, '-f', `search=${search}`];
      if (cursor !== null) args.push('-f', `cursor=${cursor}`);
      const value = await immutableSnapshot(JSON.stringify(args), storage, async () => {
        calls += 1;
        try {
          return execFileSync('gh', ['api', ...args], {
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
          });
        } catch {
          throw new Error('provider GraphQL request failed');
        }
      });
      const result = object(value);
      if (result['errors'] !== undefined) throw new Error('provider GraphQL returned errors');
      return result;
    },
  };
}

/** GitHub's filtered run search has a 1,000-result ceiling; reject it instead of truncating. */
export async function providerPages(
  get: (endpoint: string) => Promise<JsonObject>,
  endpoint: string,
  field: string,
): Promise<JsonObject[]> {
  return collectPages(async (page) => {
    const result = await get(
      `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
    );
    if (typeof result['total_count'] !== 'number' || !Array.isArray(result[field]))
      throw new Error('invalid provider inventory');
    if (result['total_count'] > 1000) throw new Error('provider inventory exceeds search limit');
    return { total: result['total_count'], items: result[field].map(object) };
  });
}
