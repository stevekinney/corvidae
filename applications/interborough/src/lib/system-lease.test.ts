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
    expect(() => parseSystemLease(null)).toThrow('malformed lease response');
  });

  test('rejects lease instants outside the ECMAScript Date range instead of throwing a RangeError', () => {
    for (const field of ['heldSince', 'expiresAt', 'lastRenewedAt'] as const) {
      for (const outOfRange of [1e20, -1e20, 8.64e15 + 1]) {
        expect(
          () => parseSystemLease({ ...CONTESTED, [field]: outOfRange }),
          `${field}: ${outOfRange}`,
        ).toThrow(MalformedSystemLeaseError);
      }
      // The range bounds themselves are representable dates.
      const atBound = parseSystemLease({ ...CONTESTED, [field]: -8.64e15 });
      expect(new Date(atBound[field] as number).toISOString()).toBe('-271821-04-20T00:00:00.000Z');
    }
  });

  test("accepts each of EngineLeaseHealth's coherent shapes", () => {
    const { lossReason: _lossReason, ...holder } = CONTESTED;
    const coherent: unknown[] = [
      { mode: 'none', status: 'disabled', holdsLease: false },
      { mode: 'lease', status: 'no-lease', holdsLease: false },
      { ...holder, status: 'healthy', holdsLease: true },
      holder,
      CONTESTED,
      { mode: 'lease', status: 'contested', holdsLease: false, lossReason: 'deposed' },
    ];
    for (const lease of coherent) expect(parseSystemLease(lease) as unknown).toEqual(lease);
  });

  test('rejects a status that is not one of the four, however the rest of the payload reads', () => {
    // The status is checked once, by the coherence rule for each status: a name no rule matches is
    // refused, including a name every object inherits and a value that is not a string at all.
    const unknownStatuses: unknown[] = [
      'unknown',
      'constructor',
      'toString',
      '__proto__',
      '',
      7,
      null,
      undefined,
    ];
    for (const status of unknownStatuses) {
      for (const lease of [
        { mode: 'lease', status, holdsLease: false },
        { mode: 'none', status, holdsLease: false },
      ]) {
        expect(() => parseSystemLease(lease), JSON.stringify(lease)).toThrow(
          MalformedSystemLeaseError,
        );
      }
    }
  });

  test('rejects incoherent status, mode, holder, and loss-reason combinations', () => {
    const { lossReason: _lossReason, ...holder } = CONTESTED;
    const incoherent: unknown[] = [
      // `healthy` must hold the lease and report its holder and instants.
      { ...holder, status: 'healthy', holdsLease: false },
      { mode: 'lease', status: 'healthy', holdsLease: true },
      { ...holder, status: 'healthy', holdsLease: true, fencingEpoch: undefined },
      // `disabled` pairs only with `mode: 'none'`, and only `disabled` does.
      { mode: 'lease', status: 'disabled', holdsLease: false },
      { mode: 'none', status: 'no-lease', holdsLease: false },
      { ...holder, mode: 'none', status: 'healthy', holdsLease: true },
      { mode: 'none', status: 'disabled', holdsLease: true },
      // No other status is held, and holder evidence only belongs to a held or lost lease.
      { mode: 'lease', status: 'no-lease', holdsLease: true },
      { ...holder, status: 'no-lease' },
      { ...CONTESTED, holdsLease: true },
      // A loss reason belongs only to `contested`; without holder evidence it must be `deposed`.
      { ...holder, status: 'healthy', holdsLease: true, lossReason: 'deposed' },
      { mode: 'lease', status: 'contested', holdsLease: false },
      {
        mode: 'lease',
        status: 'contested',
        holdsLease: false,
        lossReason: 'renewal-unconfirmable',
      },
    ];
    for (const lease of incoherent) {
      expect(() => parseSystemLease(lease), JSON.stringify(lease)).toThrow(
        MalformedSystemLeaseError,
      );
    }
  });

  test('presents every status in words, with the loss reason when one is reported', () => {
    expect(leaseStatusPresentation(parseSystemLease(CONTESTED))).toEqual({
      label: 'Contested',
      variant: 'danger',
      description: 'This server lost the ownership lease: another holder deposed this server.',
    });
    expect(
      leaseStatusPresentation(
        parseSystemLease({ ...CONTESTED, lossReason: 'renewal-unconfirmable' }),
      ).description,
    ).toContain('storage failures outlasted');
    const { lossReason: _lossReason, ...withoutReason } = CONTESTED;
    expect(leaseStatusPresentation(parseSystemLease(withoutReason)).description).toBe(
      'This server lost the ownership lease.',
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
