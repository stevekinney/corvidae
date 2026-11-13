import { describe, expect, it } from 'bun:test';

import { approvalHoldsChat } from './chat-waiting.ts';

describe('approvalHoldsChat', () => {
  it('holds the chat for an approval pending a decision', () => {
    expect(approvalHoldsChat([{ state: 'needs-you' }], 'awaiting-input')).toBe(true);
  });

  it('holds the chat for an expired approval while the run is still waiting on input', () => {
    expect(approvalHoldsChat([{ state: 'expired' }], 'awaiting-input')).toBe(true);
  });

  it('does not hold the chat for an expired approval once the run is over', () => {
    expect(approvalHoldsChat([{ state: 'expired' }], 'idle')).toBe(false);
    expect(approvalHoldsChat([{ state: 'expired' }], undefined)).toBe(false);
    expect(approvalHoldsChat([{ state: 'expired' }], 'running')).toBe(false);
  });

  it('does not hold the chat for calls that need nobody', () => {
    expect(approvalHoldsChat([{ state: 'done' }, { state: 'running' }], 'awaiting-input')).toBe(
      false,
    );
  });
});
