/**
 * COR-2151 — the rows `bureau.models.catalog()` returns on a fresh install (no secret saved, no
 * `OPENAI_BASE_URL`) for the three vendor plugins are the rows the catalog held before the vendors
 * owned them. `vendor-catalog-rows.snapshot.json` was written against `main` before the rows moved
 * out of Operative; this test keeps it true. A deliberate repricing or a new model changes the
 * snapshot in the same commit.
 *
 * `freshness` is the one field left out: it is the time the catalog was built, so it differs on
 * every run.
 */
import { openBungalow } from '@lostgradient/bungalow';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';
import snapshot from './vendor-catalog-rows.snapshot.json';

const VENDORS = ['anthropic', 'openai', 'gemini'];
const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** The vendor rows of a host started on a fresh home, as plain JSON, without `freshness`. */
async function freshInstallRows(): Promise<unknown[]> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-vendor-rows-'));
  directories.push(home);
  const initialized = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: home },
  });
  initialized.close();
  const environment: Record<string, string | undefined> = { INTERBOROUGH_HOME: home };
  const host = await startHost({ environment, port: 0 });
  hosts.push(host);
  return host.bureau.models
    .catalog()
    .descriptors.filter((row) => VENDORS.includes(row.provider))
    .map(({ freshness: _freshness, ...rest }) => JSON.parse(JSON.stringify(rest)));
}

describe('the vendor rows of a fresh install', () => {
  test('are the rows the catalog held before the vendors owned them', async () => {
    const rows = await freshInstallRows();
    for (const vendor of VENDORS) {
      expect(rows.some((row) => (row as { provider: string }).provider === vendor)).toBe(true);
    }
    expect(rows).toEqual(snapshot);
  });
});
