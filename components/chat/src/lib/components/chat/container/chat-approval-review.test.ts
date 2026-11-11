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
  nextPendingApprovalDeadline,
} from './chat-approval-review.ts';

setupHappyDom();

afterEach(() => {
  document.body.replaceChildren();
});

function conversationWith(
  callIds: string[],
  paired: boolean,
  expiresAt?: string,
): readonly Message[] {
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
        ...(expiresAt === undefined ? {} : { expiresAt }),
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
    expect(APPROVAL_DRAWER_TEXT).not.toContain(String.fromCodePoint(0xb7));
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

describe('an approval with a deadline', () => {
  const deadline = Date.parse('2026-11-02T10:00:00.000Z');
  const messages = conversationWith(['a'], true, '2026-11-02T10:00:00.000Z');

  test('waits until its deadline, and stops waiting from the deadline on', () => {
    expect(findPendingApprovalMessageId(messages, undefined, deadline - 1)).toBeDefined();
    expect(findPendingApprovalMessageId(messages, undefined, deadline)).toBeUndefined();
    expect(findPendingApprovalMessageId(messages, undefined, deadline + 1)).toBeUndefined();
  });

  test('names the next deadline ahead, and none once it passed or was decided', () => {
    expect(nextPendingApprovalDeadline(messages, undefined, deadline - 5)).toBe(deadline);
    expect(nextPendingApprovalDeadline(messages, undefined, deadline)).toBeUndefined();
    expect(
      nextPendingApprovalDeadline(
        messages,
        new Map<string, ApprovalState>([['a', 'approved']]),
        deadline - 5,
      ),
    ).toBeUndefined();
  });

  test('names the earliest of several deadlines', () => {
    const later = conversationWith(['a', 'b'], true, '2026-11-02T10:00:00.000Z');

    expect(nextPendingApprovalDeadline(later, undefined, deadline - 5)).toBe(deadline);
  });

  test('reads an unparseable deadline as none', () => {
    const odd = conversationWith(['a'], true, 'not a time');

    expect(nextPendingApprovalDeadline(odd, undefined, deadline)).toBeUndefined();
    expect(findPendingApprovalMessageId(odd, undefined, deadline)).toBeDefined();
  });
});

describe('focusPendingApproval', () => {
  test('focuses the first card that still waits and can be focused by script, and never one that is decided', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <article class="cinder-approval-card" data-cinder-state="approved" tabindex="-1" id="done"></article>
      <article class="cinder-approval-card" data-cinder-state="pending" id="static"></article>
      <article class="cinder-approval-card" data-cinder-state="pending" tabindex="-1" id="waiting"></article>
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
