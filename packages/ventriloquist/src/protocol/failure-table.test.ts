import { describe, expect, test } from 'bun:test';

import { connect } from './endpoint-pair.test-support.ts';
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
      'stale-generation',
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

describe('the exported failure data is immutable', () => {
  test('is frozen, rows and code lists included', () => {
    expect(Object.isFrozen(FAILURE_TABLE)).toBe(true);
    for (const row of Object.values(FAILURE_TABLE)) expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(OPERATION_FAILURE_CODES)).toBe(true);
    expect(Object.isFrozen(ATTACHMENT_ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(FAILURE_CLOSE_CODES)).toBe(true);
  });

  test('cannot be mutated to change what an endpoint does with a malformed frame', () => {
    const attempts: Array<() => void> = [
      () => {
        (FAILURE_TABLE['malformed-frame'] as { revokesGeneration: boolean }).revokesGeneration =
          false;
      },
      () => {
        (FAILURE_TABLE as Record<string, unknown>)['malformed-frame'] = {
          ...FAILURE_TABLE['malformed-frame'],
          revokesGeneration: false,
        };
      },
      () => {
        delete (FAILURE_TABLE as Record<string, unknown>)['malformed-frame'];
      },
      () => {
        (OPERATION_FAILURE_CODES as unknown as string[]).push('malformed-frame');
      },
      () => {
        (FAILURE_CLOSE_CODES as Record<string, number>)['malformed-frame'] = 1000;
      },
    ];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
      }
    }
    expect(describeFailure('malformed-frame').revokesGeneration).toBe(true);
    const { host, client } = connect();
    expect(host.receive('not json').ok).toBe(false);
    expect(host.authorityRevoked).toBe(true);
    expect(host.receive(JSON.stringify({})).ok).toBe(false);
    expect(client.receive('not json').ok).toBe(false);
    expect(client.phase).toBe('closed');
    expect(client.authorityRevoked).toBe(true);
  });
});
