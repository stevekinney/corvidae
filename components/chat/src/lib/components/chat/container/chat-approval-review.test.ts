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
import { getMessages } from '../utilities/index.ts';
import {
  APPROVAL_DRAWER_ACTION,
  APPROVAL_DRAWER_TEXT,
  approvalActionRowShift,
  approvalCardFitsViewport,
  approvalRowVisible,
  approvalVisibleBox,
  findPendingApprovalMessageId,
  focusPendingApproval,
  nextPendingApprovalDeadline,
  pendingApprovalCard,
  pendingApprovalMessageIds,
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
    // The conversation model rejects a result with no call, so an unpaired row is made by
    // dropping the call row from the finished history below.
    history = appendToolCall(history, { id: callId, name: 'tool', arguments: {} });
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
  const messages = getMessages(history);
  return paired ? messages : messages.filter((message) => message.role !== 'tool-call');
}

/** Gives every waiting approval a deadline the conversation model would refuse to store. */
function withDeadline(messages: readonly Message[], expiresAt: string): readonly Message[] {
  return messages.map((message) => {
    const action = message.toolResult?.action;
    if (message.toolResult === undefined || action === undefined) return message;
    return { ...message, toolResult: { ...message.toolResult, action: { ...action, expiresAt } } };
  });
}

describe('approval drawer words', () => {
  test('say exactly what is waiting and what the action does', () => {
    expect(APPROVAL_DRAWER_TEXT).toBe('Waiting for your approval.');
    expect(APPROVAL_DRAWER_ACTION).toBe('Review approval');
    expect(APPROVAL_DRAWER_TEXT).not.toContain(String.fromCodePoint(0xb7));
  });
});

describe('approval card viewport criterion', () => {
  test('keeps the drawer for a top-clipped tall card even when its actions fit', () => {
    expect(
      approvalCardFitsViewport(
        { top: -24, bottom: 180, left: 12, right: 308 },
        { top: 0, bottom: 200, left: 0, right: 320 },
        80,
      ),
    ).toBe(false);
  });

  test('reclaims the drawer height without weakening the full-card criterion', () => {
    expect(
      approvalCardFitsViewport(
        { top: 20, bottom: 280, left: 12, right: 308 },
        { top: 0, bottom: 220, left: 0, right: 320 },
        64,
      ),
    ).toBe(true);
  });

  test('keeps the drawer for a horizontally clipped card', () => {
    expect(
      approvalCardFitsViewport(
        { top: 20, bottom: 180, left: -8, right: 308 },
        { top: 0, bottom: 220, left: 0, right: 320 },
      ),
    ).toBe(false);
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

    expect(
      findPendingApprovalMessageId(messages, new Map<string, ApprovalState>([['a', 'approved']])),
    ).toBe(callRowB?.id);
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

  test('lists both pending card rows and drops either row once decided', () => {
    const messages = conversationWith(['a', 'b'], true);
    const calls = messages.filter((message) => message.role === 'tool-call');
    expect(pendingApprovalMessageIds(messages, undefined, 0)).toEqual(
      calls.map((message) => message.id),
    );
    expect(
      pendingApprovalMessageIds(messages, new Map<string, ApprovalState>([['b', 'denied']]), 0),
    ).toEqual(calls.slice(0, 1).map((message) => message.id));
  });

  test('keeps finding an approval whose state reads pending while its answer is on the way', () => {
    const messages = conversationWith(['a'], true);

    expect(
      findPendingApprovalMessageId(messages, new Map<string, ApprovalState>([['a', 'pending']])),
    ).toBeDefined();
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
    const odd = withDeadline(conversationWith(['a'], true), 'not a time');

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

describe('pendingApprovalCard', () => {
  test('selects the waiting card from its message and ignores other pending cards', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <article data-message-id="older">
        <div class="cinder-approval-card" data-cinder-state="pending" id="older-card"></div>
      </article>
      <article data-message-id="waiting">
        <div class="cinder-approval-card" data-cinder-state="approved" id="decided"></div>
        <div class="cinder-approval-card" data-cinder-state="pending" id="waiting-card"></div>
      </article>
    `;

    expect(pendingApprovalCard(root, 'waiting')?.id).toBe('waiting-card');
    expect(pendingApprovalCard(root, 'older')?.id).toBe('older-card');
    expect(pendingApprovalCard(root, 'missing')).toBeNull();
  });
});

describe('approval action row shift', () => {
  const viewport = { top: 0, bottom: 400 };

  test('scrolls down just far enough for a row below the transcript to clear its inset', () => {
    expect(approvalActionRowShift({ top: 380, bottom: 430 }, viewport, 8)).toBe(38);
  });

  test('leaves a row that already fits where it is', () => {
    expect(approvalActionRowShift({ top: 300, bottom: 340 }, viewport, 8)).toBe(0);
  });

  test('scrolls up for a row above the top', () => {
    expect(approvalActionRowShift({ top: -30, bottom: 10 }, viewport, 8)).toBe(-30);
  });

  test('does nothing when the row cannot fit the viewport with its inset', () => {
    expect(approvalActionRowShift({ top: 100, bottom: 500 }, viewport, 8)).toBe(0);
  });
});

describe('approval row visibility with and without the reminder', () => {
  const reminder = 48;
  // The transcript's box with the reminder off screen, and the box it has while the reminder
  // takes its room from the bottom.
  const without = { top: 0, bottom: 400, left: 0, right: 300 };
  const withReminder = { top: 0, bottom: 400 - reminder, left: 0, right: 300 };
  const row = (top: number, bottom: number) => ({ top, bottom, left: 10, right: 290 });

  /** The answer must not depend on whether the box it reads already excludes the reminder. */
  function answers(rowBox: ReturnType<typeof row>): [boolean, boolean] {
    return [
      approvalRowVisible(rowBox, without, false, reminder),
      approvalRowVisible(rowBox, withReminder, true, reminder),
    ];
  }

  test('a row wholly in view is visible either way', () => {
    expect(answers(row(200, 244))).toEqual([true, true]);
  });

  test('a row partly under the composer or the reminder is not visible either way', () => {
    expect(answers(row(330, 374))).toEqual([false, false]);
    expect(answers(row(380, 424))).toEqual([false, false]);
  });

  test('a row above the fold is not visible either way', () => {
    expect(answers(row(-20, 24))).toEqual([false, false]);
  });

  test('a row ending at the reminder strip is the edge both states agree on', () => {
    expect(answers(row(300, 352))).toEqual([true, true]);
    expect(answers(row(310, 354))).toEqual([false, false]);
  });

  test('a row clipped on the side is not visible', () => {
    expect(
      approvalRowVisible({ top: 100, bottom: 140, left: -5, right: 290 }, without, false, 0),
    ).toBe(false);
  });

  test('the visible box drops the reminder only while the box does not already exclude it', () => {
    expect(approvalVisibleBox(without, false, reminder).bottom).toBe(352);
    expect(approvalVisibleBox(withReminder, true, reminder).bottom).toBe(352);
  });

  test('the arrival scroll targets the same box, so a row it clears is a row the reminder accepts', () => {
    const rowBox = row(360, 404);
    const box = approvalVisibleBox(without, false, reminder);
    const shift = approvalActionRowShift(rowBox, box, 8);
    const moved = row(rowBox.top - shift, rowBox.bottom - shift);
    expect(answers(moved)).toEqual([true, true]);
  });
});
