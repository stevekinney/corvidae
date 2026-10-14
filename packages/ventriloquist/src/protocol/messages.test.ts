import { describe, expect, test } from 'bun:test';

import type { AttachmentErrorMessage, OperationFailureMessage } from './messages.ts';

test('the message types are erased at runtime and the module still loads', async () => {
  expect(Object.keys(await import('./messages.ts'))).toEqual([]);
});

describe('failure codes in the message types', () => {
  test('narrow to the codes each message may carry', () => {
    const header = { sessionId: 'id', attachmentGeneration: 1, sequence: 1 } as const;
    const failure: OperationFailureMessage = {
      ...header,
      kind: 'operation-failure',
      operationSequence: 1,
      code: 'read-only',
      message: 'm',
    };
    const error: AttachmentErrorMessage = {
      ...header,
      kind: 'attachment-error',
      code: 'spawn-failed',
      message: 'm',
    };
    // @ts-expect-error a startup code is not an operation failure code
    const wrongFailure: OperationFailureMessage = { ...failure, code: 'spawn-failed' };
    // @ts-expect-error an operation code is not an attachment error code
    const wrongError: AttachmentErrorMessage = { ...error, code: 'read-only' };
    expect([failure.code, error.code, wrongFailure.code, wrongError.code]).toHaveLength(4);
  });
});
