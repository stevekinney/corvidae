/**
 * The storage line under Health's heading (rows 76b, 80c): the storage in plain words ("Running on
 * SQLite"), and the facts Storage details lists, where the full location lives.
 */
import { describe, expect, test } from 'bun:test';

import { stubHostPaths, stubRemoteHostPaths } from '../../lib/bureau-stub.test-support.ts';
import { runningOnLine, storageFacts } from './storage-location.ts';

// Owner, 2026-11-19: the header read "Running on SQLite in /var/folders/.../interborough-desktop-…"
// with the Storage details button laid over the cut-off path. A header shows no path.
describe('runningOnLine', () => {
  test('names SQLite in plain words and no path', () => {
    expect(runningOnLine(stubHostPaths('/a', '/b'))).toBe('Running on SQLite');
  });

  test('names Postgres and S3 and no server for a remote installation', () => {
    expect(runningOnLine(stubRemoteHostPaths())).toBe('Running on Postgres and S3');
  });

  test('says only that this is the storage when the host cannot say', () => {
    expect(runningOnLine(undefined)).toBe('Running on this storage');
  });
});

describe('storageFacts', () => {
  test('names the backend and the full location, for the facts Storage details lists', () => {
    expect(storageFacts(stubHostPaths('/a', '/b'))).toEqual({
      backend: 'SQLite',
      location: '/home/me/.interborough',
    });
    expect(storageFacts(stubRemoteHostPaths())).toEqual({
      backend: 'Postgres and S3',
      location: 'db.example.test:5432/interborough',
    });
  });

  test('names no location when the host cannot say', () => {
    expect(storageFacts(undefined)).toEqual({ backend: 'Storage', location: undefined });
  });
});
