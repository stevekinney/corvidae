/** COR-1913 — which tool result of a run needed an approval the run could not get. */
import { describe, expect, it } from 'bun:test';

import { toolNeedingApproval } from '../src/tool-needing-approval';

describe('toolNeedingApproval', () => {
  it('names the tool of the first result that ended action_required', () => {
    expect(
      toolNeedingApproval([
        { outcome: 'success', toolName: 'read' },
        { outcome: 'action_required', toolName: 'refund' },
        { outcome: 'action_required', toolName: 'later' },
      ]),
    ).toBe('refund');
  });

  it('names the tool whose approval Armorer could not issue for want of a requester', () => {
    const message =
      'Approval authorization requires request principal, tenant, audience, agentId, and runId.';
    expect(toolNeedingApproval([{ outcome: 'error', toolName: 'a', error: { message } }])).toBe(
      'a',
    );
    expect(toolNeedingApproval([{ outcome: 'error', toolName: 'b', errorMessage: message }])).toBe(
      'b',
    );
  });

  it('answers nothing for success and for errors that are not about an approval', () => {
    expect(
      toolNeedingApproval([
        { outcome: 'success', toolName: 'read' },
        { outcome: 'error', toolName: 'read', error: { message: 'not found' } },
        { outcome: 'error', toolName: 'refund', error: { message: 'Tool "refund" is denied.' } },
      ]),
    ).toBeUndefined();
    expect(toolNeedingApproval([])).toBeUndefined();
  });

  it('answers an empty string for a result that names no tool', () => {
    expect(toolNeedingApproval([{ outcome: 'action_required' }])).toBe('');
  });
});
