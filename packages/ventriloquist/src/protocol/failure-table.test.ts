import { describe, expect, test } from 'bun:test';

import { closeCodeForFailure, FAILURE_CLOSE_CODES, type FailureCode } from './failure-codes.ts';
import {
  ATTACHMENT_ERROR_CODES,
  describeFailure,
  FAILURE_TABLE,
  OPERATION_FAILURE_CODES,
} from './failure-table.ts';

/** Each row of the failure and cleanup table in `documentation/terminal/contract.md`, verbatim. */
const CONTRACT_ROWS: ReadonlyArray<readonly [FailureCode, string, string, number, string]> = [
  [
    'protocol-version-unsupported',
    'server, handshake',
    'reject; no generation issued',
    1002,
    'discard frame; close transport',
  ],
  [
    'malformed-frame',
    'either, decode',
    'reject; current generation revoked',
    1002,
    'drain bounded queue; kill owned process',
  ],
  [
    'frame-too-large',
    'either, decode',
    'reject; current generation revoked',
    1009,
    'drain bounded queue; kill owned process',
  ],
  [
    'stale-generation',
    'either, operation',
    'explicit failure; authority unchanged',
    1008,
    'leave current attachment live',
  ],
  [
    'read-only',
    'client, input/query',
    'explicit failure; authority unchanged',
    1008,
    'operation is not queued',
  ],
  [
    'fifo-full',
    'client, input/resize',
    'explicit failure; authority unchanged',
    1013,
    'preserve existing queue; no process action',
  ],
  [
    'unsupported-runtime',
    'server, startup',
    'startup failure; no attachment',
    1011,
    'close PTY/pipe handles',
  ],
  [
    'spawn-failed',
    'server, startup',
    'startup failure; generation revoked',
    1011,
    'terminate descendants; quarantine if uncertain',
  ],
  [
    'backend-failed',
    'server, submitted operation',
    'operation failure; generation revoked',
    1011,
    'cancel unsent operations; cleanup',
  ],
  [
    'transport-failed',
    'either, live session',
    'unknown delivery; generation revoked',
    1011,
    'disable input; cleanup',
  ],
  [
    'cleanup-incomplete',
    'server, disposal',
    'explicit incomplete result; slot quarantined',
    1000,
    'retain quarantine record; no replacement',
  ],
];

describe('failure table', () => {
  test.each(CONTRACT_ROWS)(
    '%s matches its row of the contract',
    (code, directionAndOperation, result, closeCode, drain) => {
      const row = describeFailure(code);
      expect(`${row.direction}, ${row.operation}`).toBe(directionAndOperation);
      expect(row.resultAndAttachment).toBe(result);
      expect(row.closeCode).toBe(closeCode);
      expect(row.drainAndCleanup).toBe(drain);
    },
  );

  test('has one row per failure code and agrees with the close-code map', () => {
    expect(Object.keys(FAILURE_TABLE).toSorted()).toEqual(
      Object.keys(FAILURE_CLOSE_CODES).toSorted(),
    );
    for (const code of Object.keys(FAILURE_TABLE) as FailureCode[]) {
      expect(describeFailure(code).closeCode).toBe(closeCodeForFailure(code));
    }
  });

  test('revokes the generation exactly where the contract says so', () => {
    const revoking = (Object.keys(FAILURE_TABLE) as FailureCode[]).filter(
      (code) => describeFailure(code).revokesGeneration,
    );
    expect(revoking.toSorted()).toEqual(
      (
        [
          'malformed-frame',
          'frame-too-large',
          'spawn-failed',
          'backend-failed',
          'transport-failed',
        ] as FailureCode[]
      ).toSorted(),
    );
    for (const code of Object.keys(FAILURE_TABLE) as FailureCode[]) {
      expect(describeFailure(code).resultAndAttachment.includes('generation revoked')).toBe(
        describeFailure(code).revokesGeneration,
      );
    }
  });

  test('quarantines the ownership slot only for an incomplete cleanup', () => {
    const quarantining = (Object.keys(FAILURE_TABLE) as FailureCode[]).filter(
      (code) => describeFailure(code).quarantinesSlot,
    );
    expect(quarantining).toEqual(['cleanup-incomplete']);
  });

  test('limits operation failures and attachment errors to the codes that apply to them', () => {
    expect([...OPERATION_FAILURE_CODES]).toEqual([
      'read-only',
      'fifo-full',
      'backend-failed',
      'transport-failed',
    ]);
    expect([...ATTACHMENT_ERROR_CODES]).toEqual([
      'unsupported-runtime',
      'spawn-failed',
      'backend-failed',
      'transport-failed',
    ]);
  });
});
