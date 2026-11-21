/**
 * The `data` of a JSON-RPC error a transport answers itself carries the same envelope keys a fault
 * does, `retryable` included, and no transport writes those keys by hand.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FAULT_CODE_RETRYABLE, FAULT_CODES } from './fault-code.ts';
import { faultErrorData, faultToJsonRpcError } from './fault-to-json-rpc.ts';
import { FAULT_CODE_TO_HTTP_STATUS } from './operation-fault.ts';

describe('faultErrorData', () => {
  it('writes weftCode, httpStatus and retryable for every fault code', () => {
    for (const code of FAULT_CODES) {
      expect(faultErrorData(code)).toEqual({
        weftCode: code,
        httpStatus: FAULT_CODE_TO_HTTP_STATUS[code],
        retryable: FAULT_CODE_RETRYABLE[code],
      });
    }
  });

  it('is the data a fault of that code is projected with, plus the payload it is given', () => {
    const projected = faultToJsonRpcError({
      code: 'NotFound',
      message: 'subscription not found',
      data: { resource: 'subscription', identifier: 'sub-1' },
    });
    expect(faultErrorData('NotFound', { resource: 'subscription', identifier: 'sub-1' })).toEqual(
      projected.data,
    );
  });

  it('keeps the envelope keys over a payload field of the same name', () => {
    expect(
      faultErrorData('Unauthorized', { weftCode: 'x', httpStatus: 1, retryable: true }),
    ).toEqual({ weftCode: 'Unauthorized', httpStatus: 401, retryable: false });
  });
});

describe('the transports of Backchannel', () => {
  it('write no `httpStatus` of their own: an error they answer builds its data with faultErrorData', () => {
    const sources = readdirSync(import.meta.dir).filter(
      (name) => name.endsWith('.ts') && !name.includes('.test') && name !== 'fault-to-json-rpc.ts',
    );
    const handBuilt = sources.filter((name) =>
      /\bhttpStatus:\s*\d{3}\b/.test(readFileSync(join(import.meta.dir, name), 'utf8')),
    );
    expect(handBuilt).toEqual([]);
  });
});
