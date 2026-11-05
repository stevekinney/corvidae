/**
 * The storage line under Health's heading (rows 76b, 80c): "Running on SQLite in ~/.interborough",
 * which writes a home directory as `~`, the way a person says it.
 */
import { describe, expect, test } from 'bun:test';

import { stubHostPaths, stubRemoteHostPaths } from '../../lib/bureau-stub.test-support.ts';
import { abbreviateHome, runningOnLine, storageFacts } from './storage-location.ts';

describe('abbreviateHome', () => {
  test('writes a macOS or Linux home directory as ~', () => {
    expect(abbreviateHome('/Users/steve/.interborough')).toBe('~/.interborough');
    expect(abbreviateHome('/home/me/.interborough')).toBe('~/.interborough');
    expect(abbreviateHome('/home/me')).toBe('~');
  });

  test('leaves a directory that is not under a home as it is', () => {
    expect(abbreviateHome('/var/lib/interborough')).toBe('/var/lib/interborough');
    expect(abbreviateHome('/Users')).toBe('/Users');
  });
});

describe('runningOnLine', () => {
  test('names SQLite and the directory the file is in', () => {
    expect(runningOnLine(stubHostPaths('/a', '/b'))).toBe('Running on SQLite in ~/.interborough');
  });

  test('names Postgres and S3 and the server for a remote installation', () => {
    expect(runningOnLine(stubRemoteHostPaths())).toBe(
      'Running on Postgres and S3 in db.example.test:5432/interborough',
    );
  });

  test('says only that this is the storage when the host cannot say', () => {
    expect(runningOnLine(undefined)).toBe('Running on this storage');
  });
});

describe('storageFacts', () => {
  test('names the backend and where it is, for the facts Storage details lists', () => {
    expect(storageFacts(stubHostPaths('/a', '/b'))).toEqual({
      backend: 'SQLite',
      location: '~/.interborough',
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
