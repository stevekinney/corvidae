/**
 * The memory client parses what the Bureau's memory operations answer and sorts the faults they
 * throw into the few the Memory page tells apart. A fault is told by its wire code and, where one
 * code carries two refusals, by `data.reason`.
 */
import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import { memoryFaultOf } from './memory-client.ts';

/** The error `callBureau` throws for a fault envelope's `error.data`. */
function wireFault(data: Record<string, unknown>, message = 'It failed.'): HttpClientError {
  const status = typeof data['httpStatus'] === 'number' ? data['httpStatus'] : 500;
  return new HttpClientError(status, message, { data });
}

describe('memoryFaultOf', () => {
  test('tells a missing scope from a missing memory', () => {
    expect(memoryFaultOf(wireFault({ weftCode: 'Forbidden', httpStatus: 403 }))).toEqual({
      kind: 'forbidden',
    });
    expect(memoryFaultOf(wireFault({ weftCode: 'NotFound', httpStatus: 404 }))).toEqual({
      kind: 'not-found',
    });
  });

  test('tells the two refusals of a correction apart by their reason', () => {
    expect(
      memoryFaultOf(
        wireFault({ weftCode: 'Conflict', httpStatus: 409, reason: 'memory-superseded' }),
      ),
    ).toEqual({ kind: 'superseded' });
    expect(
      memoryFaultOf(
        wireFault({
          weftCode: 'Unprocessable',
          httpStatus: 422,
          reason: 'memory-successor-not-admitted',
        }),
      ),
    ).toEqual({ kind: 'successor-not-admitted' });
  });

  test('treats a Conflict or an Unprocessable with another reason as an ordinary failure, in the Bureau’s words', () => {
    expect(
      memoryFaultOf(wireFault({ weftCode: 'Conflict', httpStatus: 409, reason: 'other' }, 'Busy.')),
    ).toEqual({ kind: 'other', message: 'Busy.' });
    expect(
      memoryFaultOf(
        wireFault({ weftCode: 'Unprocessable', httpStatus: 422, reason: 'other' }, 'No.'),
      ),
    ).toEqual({ kind: 'other', message: 'No.' });
    expect(
      memoryFaultOf(wireFault({ weftCode: 'EngineFailure', httpStatus: 500 }, 'Broke.')),
    ).toEqual({ kind: 'other', message: 'Broke.' });
  });

  test('says the Bureau did not answer for an error that never crossed the wire', () => {
    expect(memoryFaultOf(new Error('socket closed'))).toEqual({
      kind: 'other',
      message: 'socket closed',
    });
    expect(memoryFaultOf('nothing')).toEqual({
      kind: 'other',
      message: 'The Bureau did not answer.',
    });
  });
});
