/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import type { ApprovalState } from '@lostgradient/cinder';
import { setupHappyDom } from '@lostgradient/testing';
import {
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
} from '../builders.ts';
import type { Message } from '../conversation-model.ts';
import {
  APPROVAL_DRAWER_ACTION,
  APPROVAL_DRAWER_TEXT,
  findPendingApprovalMessageId,
  focusPendingApproval,
} from './chat-approval-review.ts';

setupHappyDom();

afterEach(() => {
  document.body.replaceChildren();
});

function conversationWith(callIds: string[], paired: boolean): readonly Message[] {
  let history = appendUserMessage(createConversationHistory({ id: 'review' }), 'go');
  for (const callId of callIds) {
    if (paired) {
      history = appendToolCall(history, { id: callId, name: 'tool', arguments: {} });
    }
    history = appendToolResult(history, {
      callId,
      outcome: 'action_required',
      content: null,
      action: {
        type: 'approval',
        risk: 'low',
        operation: { kind: 'other' },
        policyVersion: 'policy',
        idempotencyKey: `key-${callId}`,
      },
    });
  }
  return history.messages;
}

describe('approval drawer words', () => {
  test('say exactly what is waiting and what the action does', () => {
    expect(APPROVAL_DRAWER_TEXT).toBe(
      'Waiting for your approval. Anything you send now queues until you decide.',
    );
    expect(APPROVAL_DRAWER_ACTION).toBe('Review approval');
    expect(APPROVAL_DRAWER_TEXT).not.toContain('·');
  });
});

describe('findPendingApprovalMessageId', () => {
  test('finds nothing when no approval waits', () => {
    expect(findPendingApprovalMessageId(conversationWith([], true), undefined)).toBeUndefined();
  });

  test('finds the call row that carries a paired approval', () => {
    const messages = conversationWith(['a'], true);
    const callRow = messages.find((message) => message.role === 'tool-call');

    expect(findPendingApprovalMessageId(messages, undefined)).toBe(callRow?.id);
  });

  test('finds the result row of an unpaired approval', () => {
    const messages = conversationWith(['a'], false);
    const resultRow = messages.find((message) => message.role === 'tool-result');

    expect(findPendingApprovalMessageId(messages, undefined)).toBe(resultRow?.id);
  });

  test('skips an approval that has a decision and finds the next that waits', () => {
    const messages = conversationWith(['a', 'b'], true);
    const callRowB = messages.find(
      (message) => message.role === 'tool-call' && message.toolCall?.id === 'b',
    );

    expect(findPendingApprovalMessageId(messages, new Map<string, ApprovalState>([['a', 'approved']]))).toBe(callRowB?.id);
    expect(
      findPendingApprovalMessageId(
        messages,
        new Map<string, ApprovalState>([
          ['a', 'approved'],
          ['b', 'denied'],
        ]),
      ),
    ).toBeUndefined();
  });

  test('keeps finding an approval whose state reads pending while its answer is on the way', () => {
    const messages = conversationWith(['a'], true);

    expect(findPendingApprovalMessageId(messages, new Map<string, ApprovalState>([['a', 'pending']]))).toBeDefined();
  });
});

describe('focusPendingApproval', () => {
  test('focuses the first card that still waits, and never one that is decided', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <article data-cinder-tool-approval data-cinder-state="approved" tabindex="-1" id="done"></article>
      <article data-cinder-tool-approval data-cinder-state="pending" tabindex="-1" id="waiting"></article>
    `;
    document.body.append(root);

    expect(focusPendingApproval(root)).toBe(true);
    expect(document.activeElement?.id).toBe('waiting');
  });

  test('says so when there is no card to focus', () => {
    const root = document.createElement('div');
    document.body.append(root);

    expect(focusPendingApproval(root)).toBe(false);
    expect(focusPendingApproval(null)).toBe(false);
  });
});
