/** `/host/storage`'s size: what the storage reports, and nothing when it cannot or fails. */
import { describe, expect, test } from 'bun:test';

import { hostStorageReport } from './host-storage.ts';

describe('hostStorageReport', () => {
  test('reports the bytes the storage holds', async () => {
    const report = await hostStorageReport({ sizeBytes: async () => 2048 });
    expect(report.sizeBytes).toBe(2048);
    expect(report.bureauKeyPrefixes.length).toBeGreaterThan(0);
  });

  test('reports no size for a backend that cannot say', async () => {
    const report = await hostStorageReport({});
    expect(report.sizeBytes).toBeNull();
  });

  test('reports no size, and still answers, when asking fails', async () => {
    const report = await hostStorageReport({
      sizeBytes: async () => {
        throw new Error('the database is busy');
      },
    });
    expect(report.sizeBytes).toBeNull();
    expect(report.bureauKeyPrefixes.length).toBeGreaterThan(0);
  });
});
