/**
 * What `deriveMessageParts` adds to a tool-approval part: the adapter's description of the
 * approval, and the receipt of a decision made in this chat, which outlives the result that asked.
 */

import { describe, expect, it } from 'bun:test';

import type { ApprovalState } from '@lostgradient/cinder';
import type { ChatApprovalDetails } from '../adapter/chat-adapter.ts';
import type { Message, ToolCall, ToolCallPair, ToolResult } from '../conversation-model.ts';
import type { ToolApprovalAction, ToolApprovalReceiptRecord } from './types.ts';
import { deriveMessageParts } from './utilities.ts';

function message(overrides: Partial<Message> & Pick<Message, 'role'>): Message {
  return {
    id: 'm1',
    content: '',
    position: 0,
    createdAt: '2026-06-02T00:00:00.000Z',
    metadata: {},
    hidden: false,
    ...overrides,
  };
}

const toolCall: ToolCall = { id: 'call-1', name: 'issue-refund', arguments: {} };

const action: ToolApprovalAction = {
  type: 'approval',
  message: 'Refund order 4471 for $42.00?',
  risk: 'high',
  operation: { kind: 'other' },
  policyVersion: 'policy',
  idempotencyKey: 'key',
};

const asking: ToolResult = {
  callId: 'call-1',
  outcome: 'action_required',
  content: null,
  action,
};

const resumed: ToolResult = { callId: 'call-1', outcome: 'success', content: 'Refunded.' };

const held: ToolApprovalReceiptRecord = {
  toolName: 'issue-refund',
  action,
  state: 'approved',
  receipt: { decidedAt: 1_762_080_000_000, reason: 'Checked the order' },
};

const details: ChatApprovalDetails = { irreversible: true, approveLabel: 'Refund $42.00' };

function callRow(result: ToolResult): ReturnType<typeof deriveMessageParts> {
  const pair: ToolCallPair = { call: toolCall, result };
  return deriveMessageParts(message({ id: 'tc', role: 'tool-call', toolCall }), {
    toolCallPair: pair,
    approvalReceipts: new Map([['call-1', held]]),
    approvalStates: new Map<string, ApprovalState>([['call-1', 'approved']]),
  });
}

describe('tool-approval part details', () => {
  it('carries what the adapter says about the approval, with the call id and name it was asked about', () => {
    const asked: unknown[] = [];
    const parts = deriveMessageParts(
      message({ id: 'r', role: 'tool-result', toolResult: asking }),
      {
        describeApproval: (call, approval) => {
          asked.push([call, approval]);
          return details;
        },
      },
    );

    expect(asked).toEqual([[{ id: 'call-1', name: 'call-1' }, action]]);
    expect(parts).toEqual([
      expect.objectContaining({ type: 'tool-approval', toolCallId: 'call-1', details }),
    ]);
  });

  it('names the call from its pair when there is one', () => {
    const asked: unknown[] = [];
    deriveMessageParts(message({ id: 'tc', role: 'tool-call', toolCall }), {
      toolCallPair: { call: toolCall, result: asking },
      describeApproval: (call) => {
        asked.push(call);
        return undefined;
      },
    });

    expect(asked).toEqual([{ id: 'call-1', name: 'issue-refund' }]);
  });

  it('leaves the part without details when the adapter says nothing or throws', () => {
    const silent = deriveMessageParts(
      message({ id: 'r', role: 'tool-result', toolResult: asking }),
      {
        describeApproval: () => undefined,
      },
    );
    const throwing = deriveMessageParts(
      message({ id: 'r', role: 'tool-result', toolResult: asking }),
      {
        describeApproval: () => {
          throw new Error('describe failed');
        },
      },
    );

    expect(silent[0]).not.toHaveProperty('details');
    expect(throwing[0]).not.toHaveProperty('details');
  });
});

describe('tool-approval receipt part', () => {
  it('attaches the receipt to the part while the result still asks', () => {
    const parts = callRow(asking);
    const approval = parts.find((part) => part.type === 'tool-approval');

    expect(approval).toMatchObject({ state: 'approved', receipt: held.receipt });
  });

  it('keeps a receipt part, keyed as the asking part was, after the result stops asking', () => {
    const parts = callRow(resumed);
    const approval = parts.find((part) => part.type === 'tool-approval');

    expect(parts.map((part) => part.type)).toEqual(['tool-call', 'tool-approval']);
    expect(approval).toEqual({
      type: 'tool-approval',
      key: 'tc:tool-approval:call-1',
      toolCallId: 'call-1',
      toolName: 'issue-refund',
      action,
      state: 'approved',
      resolutionInFlight: false,
      receipt: held.receipt,
    });
  });

  it('keeps no receipt part for a call that was not decided here', () => {
    const parts = deriveMessageParts(message({ id: 'tc', role: 'tool-call', toolCall }), {
      toolCallPair: { call: toolCall, result: resumed },
    });

    expect(parts.map((part) => part.type)).toEqual(['tool-call']);
  });

  it('describes a receipt part the same way it describes the asking part', () => {
    const parts = deriveMessageParts(message({ id: 'tc', role: 'tool-call', toolCall }), {
      toolCallPair: { call: toolCall, result: resumed },
      approvalReceipts: new Map([['call-1', held]]),
      describeApproval: () => details,
    });

    expect(parts.find((part) => part.type === 'tool-approval')).toMatchObject({ details });
  });
});
