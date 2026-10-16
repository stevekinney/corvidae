import { describe, expect, test } from 'bun:test';

import { HttpClient } from '@lostgradient/weft';

import {
  leaseStatusPresentation,
  loadSystemLease,
  MalformedSystemLeaseError,
  parseSystemLease,
} from './system-lease.ts';

const CONTESTED = {
  mode: 'lease',
  status: 'contested',
  holdsLease: false,
  holderId: 'engine-a',
  heldSince: 1,
  expiresAt: 3,
  lastRenewedAt: 2,
  fencingEpoch: 4,
  lossReason: 'deposed',
} as const;

function leaseClient(result: unknown): { client: HttpClient; calls: unknown[] } {
  const calls: unknown[] = [];
  const client = new HttpClient({ baseUrl: 'http://weft.test/api' });
  Object.defineProperty(client, 'operations', {
    value: {
      'weft.system.lease': (input: unknown) => {
        calls.push(input);
        return Promise.resolve(result);
      },
    },
  });
  return { client, calls };
}

describe('weft.system.lease', () => {
  test('loads and validates the serving engine lease through the operation client', async () => {
    const { client, calls } = leaseClient(CONTESTED);
    expect(await loadSystemLease(client)).toEqual(CONTESTED);
    expect(calls).toEqual([{}]);
  });

  test('rejects payloads that drift from the published shape', () => {
    expect(() => parseSystemLease({ ...CONTESTED, status: 'unknown' })).toThrow(
      MalformedSystemLeaseError,
    );
    expect(() => parseSystemLease({ ...CONTESTED, mode: 'cluster' })).toThrow(
      MalformedSystemLeaseError,
    );
    expect(() => parseSystemLease({ ...CONTESTED, holdsLease: 'no' })).toThrow(
      MalformedSystemLeaseError,
    );
    expect(() => parseSystemLease({ ...CONTESTED, holderId: 7 })).toThrow(
      MalformedSystemLeaseError,
    );
    expect(() => parseSystemLease({ ...CONTESTED, lossReason: 'stolen' })).toThrow(
      MalformedSystemLeaseError,
    );
    expect(() => parseSystemLease({ ...CONTESTED, fencingEpoch: '4' })).toThrow(
      MalformedSystemLeaseError,
    );
    expect(() => parseSystemLease(null)).toThrow('malformed engine lease response');
  });

  test('rejects status, mode, and holdsLease combinations the published union never produces', () => {
    const HEALTHY = { ...CONTESTED, status: 'healthy', holdsLease: true } as const;
    expect(parseSystemLease(HEALTHY).status).toBe('healthy');
    expect(() => parseSystemLease({ ...HEALTHY, holdsLease: false })).toThrow(
      MalformedSystemLeaseError,
    );
    expect(() => parseSystemLease({ mode: 'lease', status: 'healthy', holdsLease: true })).toThrow(
      MalformedSystemLeaseError,
    );
    expect(() => parseSystemLease({ ...CONTESTED, holdsLease: true })).toThrow(
      MalformedSystemLeaseError,
    );
    expect(() =>
      parseSystemLease({ mode: 'lease', status: 'disabled', holdsLease: false }),
    ).toThrow(MalformedSystemLeaseError);
    expect(() => parseSystemLease({ mode: 'none', status: 'no-lease', holdsLease: false })).toThrow(
      MalformedSystemLeaseError,
    );
    expect(
      parseSystemLease({
        mode: 'lease',
        status: 'contested',
        holdsLease: false,
        lossReason: 'deposed',
      }).status,
    ).toBe('contested');
  });

  test('presents every status in words, with the loss reason when one is reported', () => {
    expect(leaseStatusPresentation(parseSystemLease(CONTESTED))).toEqual({
      label: 'Contested',
      variant: 'danger',
      description: 'This engine lost the ownership lease: another holder deposed this engine.',
    });
    expect(
      leaseStatusPresentation(
        parseSystemLease({ ...CONTESTED, lossReason: 'renewal-unconfirmable' }),
      ).description,
    ).toContain('storage failures outlasted');
    const { lossReason: _lossReason, ...withoutReason } = CONTESTED;
    expect(leaseStatusPresentation(parseSystemLease(withoutReason)).description).toBe(
      'This engine lost the ownership lease.',
    );
    expect(
      leaseStatusPresentation({ mode: 'lease', status: 'healthy', holdsLease: true }).label,
    ).toBe('Healthy');
    expect(
      leaseStatusPresentation({ mode: 'lease', status: 'no-lease', holdsLease: false }).label,
    ).toBe('No lease held');
    expect(
      leaseStatusPresentation({ mode: 'none', status: 'disabled', holdsLease: false }).label,
    ).toBe('Disabled');
  });
});
