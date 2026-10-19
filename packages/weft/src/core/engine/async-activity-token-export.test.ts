import { describe, expect, it } from 'bun:test';

import * as weft from '../../index.ts';

describe('deriveAsyncActivityToken is exported for clients', () => {
  it('derives the token a remote ctx.run() enqueues its task under', () => {
    // The task ledger's operation id for a remote activity is this token, so a client can read a
    // settled activity's task attempt by attempt without a pending-activity record.
    expect(weft.deriveAsyncActivityToken('wf-1', 3, 1)).toBe('async-act:v1:wf-1:3:1');
  });
});
