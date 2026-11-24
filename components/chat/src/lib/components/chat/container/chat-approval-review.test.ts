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
  APPROVAL_BOTTOM_CLEARANCE,
  APPROVAL_DRAWER_ACTION,
  APPROVAL_DRAWER_TEXT,
  approvalActionRowShift,
  approvalArrivalBox,
  approvalArrivalRestShift,
  approvalArrivalShift,
  approvalCardFitsViewport,
  approvalPlacementShift,
  approvalReviewBox,
  approvalRowVisible,
  approvalTallerThanTranscript,
  approvalUnitBox,
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
    // Short enough to sit on one line beside Review on a 320px phone (COR-2327).
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
  });

  test('falls back to the first pending card when the waiting message draws none of its own (COR-2327 B1)', () => {
    // A host that folds a step's calls into the step's reply draws the card under that reply, not
    // under the call's own message, which has no article.
    const root = document.createElement('div');
    root.innerHTML = `
      <article data-message-id="reply">
        <div class="cinder-approval-card" data-cinder-state="approved" id="decided"></div>
        <article class="cinder-approval-card" data-cinder-state="pending" id="host-card"></article>
      </article>
    `;

    expect(pendingApprovalCard(root, 'call-row')?.id).toBe('host-card');
    expect(pendingApprovalCard(document.createElement('div'), 'call-row')).toBeNull();
    expect(pendingApprovalCard(null, 'call-row')).toBeNull();
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

describe('the box an arriving approval is placed against (COR-2327)', () => {
  /** A rectangle that reads as `top` to `bottom`, whatever the DOM implementation measures. */
  function stubBox(element: Element, top: number, bottom: number): void {
    element.getBoundingClientRect = () =>
      ({
        top,
        bottom,
        left: 0,
        right: 320,
        x: 0,
        y: top,
        width: 320,
        height: bottom - top,
      }) as DOMRect;
  }

  test('is the transcript without the reminder, so the reminder cannot move the card it is about', () => {
    const container = document.createElement('div');
    container.className = 'chat-container';
    const transcript = document.createElement('div');
    container.append(transcript);
    document.body.append(container);
    stubBox(transcript, 160, 380);

    // No reminder drawn: the transcript's own box.
    expect(approvalArrivalBox(transcript)).toMatchObject({ top: 160, bottom: 380 });

    // A reminder 46px tall with 4px and 12px margins takes 62px from the transcript; the box the
    // card is placed against is the same one either way.
    const reminder = document.createElement('div');
    reminder.setAttribute('data-chat-approval-drawer', '');
    reminder.style.marginTop = '4px';
    reminder.style.marginBottom = '12px';
    container.append(reminder);
    stubBox(reminder, 322, 368);
    stubBox(transcript, 160, 318);
    expect(approvalArrivalBox(transcript)).toMatchObject({ top: 160, bottom: 380 });
    container.remove();
  });

  test('starts under a header the host lays over the transcript, so a card is not placed beneath it', () => {
    const container = document.createElement('div');
    container.className = 'chat-container';
    const transcript = document.createElement('div');
    container.append(transcript);
    document.body.append(container);
    stubBox(transcript, 160, 380);
    transcript.style.setProperty('--cinder-chat-overlay-inset-start', '96px');
    // The transcript's top padding is the overlay plus the timeline's padding (12px at 320).
    transcript.style.paddingTop = '108px';

    // The box starts where the first row of a short chat starts, 12px under the header.
    expect(approvalArrivalBox(transcript)).toMatchObject({ top: 268, bottom: 380 });
    container.remove();
  });

  test('a unit too tall for the room under the header is placed with its top on the header line, never above it (320 by 640)', () => {
    // The 320 by 640 phone: the transcript starts at 52, the header overlay reaches 167, and the
    // timeline's 12px padding puts the box's top at 179; the composer dock starts at 487. The unit
    // is the rail row (52px) and the card 5px under it (245px): 302px, and with the 12px
    // clearance 314px, 6px more than the 308px of room.
    const container = document.createElement('div');
    container.className = 'chat-container';
    const transcript = document.createElement('div');
    const message = document.createElement('article');
    message.setAttribute('data-message-id', 'm1');
    const label = document.createElement('button');
    label.className = 'cinder-tool-call-rail__row';
    const card = document.createElement('div');
    message.append(label, card);
    transcript.append(message);
    container.append(transcript);
    document.body.append(container);
    stubBox(transcript, 52, 487);
    transcript.style.setProperty('--cinder-chat-overlay-inset-start', '115px');
    transcript.style.paddingTop = '127px';
    Object.defineProperty(transcript, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(transcript, 'clientHeight', { value: 800, configurable: true });
    stubBox(label, 300, 352);
    stubBox(card, 357, 602);

    const shift = approvalPlacementShift(transcript, card);
    // The decision row wins: the card's bottom (602) rests 32px above the transcript's end (487),
    // the end fade and its margin, so the shift is 602 - 455 = 147. The label row (300) then stands
    // at 153, 26px above the 179 line, under the header and its top fade, and the card (357 - 147 =
    // 210) stays clear of the header. Before the decision row ranked first the shift was 121.
    expect(shift).toBe(147);
    expect(602 - shift!).toBeLessThanOrEqual(487 - 32);
    expect(357 - shift!).toBeGreaterThanOrEqual(179);
    container.remove();
  });

  test('at 320 by 640 the decision row rests whole above the end fade and the reminder is not shown, in the page’s real markup', () => {
    // Interborough's shape: a rail item holding the row and, in `nested`, the card, no article.
    // The transcript ends at 476, the header's bottom is 167 and the padding 12 (line 179); the unit
    // is 300px (row 52, card 243 under a 5px gap), too tall for the 297px between the line and the end.
    const timeline = document.createElement('div');
    const rail = document.createElement('div');
    rail.className = 'cinder-tool-call-rail';
    const item = document.createElement('div');
    item.className = 'cinder-tool-call-rail__item';
    const label = document.createElement('button');
    label.className = 'cinder-tool-call-rail__row';
    const nested = document.createElement('div');
    nested.className = 'cinder-tool-call-rail__nested';
    const card = document.createElement('div');
    const actionRow = document.createElement('div');
    actionRow.className = 'cinder-approval-card__action-row';
    card.append(actionRow);
    nested.append(card);
    item.append(label, nested);
    rail.append(item);
    timeline.append(rail);
    document.body.append(timeline);
    stubBox(timeline, 52, 476);
    timeline.style.setProperty('--cinder-chat-overlay-inset-start', '115px');
    timeline.style.paddingTop = '127px';
    Object.defineProperty(timeline, 'scrollHeight', { value: 800, configurable: true });
    Object.defineProperty(timeline, 'clientHeight', { value: 424, configurable: true });
    // Placed before arrival at the bottom of the room: label 300, card 357 to 600.
    stubBox(label, 300, 352);
    stubBox(card, 357, 600);
    stubBox(actionRow, 540, 600);

    const shift = approvalPlacementShift(timeline, card);
    // The card's bottom lands on 476 - 32 = 444: the shift is 600 - 444 = 156.
    expect(shift).toBe(156);
    const cardBottom = 600 - shift!;
    expect(cardBottom).toBeLessThanOrEqual(476 - 24);
    expect(357 - shift!).toBeGreaterThanOrEqual(179);
    // The reminder shows only while the action row is not wholly inside the transcript's box; at the
    // placed position the row (bottom 444) is whole with 32px to spare, in light and dark alike.
    const row = { top: 540 - shift!, bottom: cardBottom, left: 0, right: 320 };
    expect(approvalRowVisible(row, { top: 52, bottom: 476, left: 0, right: 320 }, false, 0)).toBe(
      true,
    );
    timeline.remove();
  });

  test('a trailing deck trigger does not leave the tool row under the header after a phone resize', () => {
    const timeline = document.createElement('div');
    const item = document.createElement('div');
    item.className = 'cinder-tool-call-rail__item';
    const label = document.createElement('button');
    label.className = 'cinder-tool-call-rail__row';
    const card = document.createElement('div');
    const actions = document.createElement('div');
    actions.className = 'cinder-approval-card__row-actions';
    const deck = document.createElement('div');
    card.append(actions, deck);
    item.append(label, card);
    timeline.append(item);
    document.body.append(timeline);
    stubBox(timeline, 52, 473.5);
    timeline.style.setProperty('--cinder-chat-overlay-inset-start', '71px');
    timeline.style.paddingTop = '83px';
    Object.defineProperty(timeline, 'scrollHeight', { value: 893, configurable: true });
    Object.defineProperty(timeline, 'clientHeight', { value: 422, configurable: true });
    Object.defineProperty(timeline, 'scrollTop', { value: 454, configurable: true });
    stubBox(label, 103, 147);
    stubBox(card, 151, 441.5);
    stubBox(actions, 360.5, 388.5);
    stubBox(deck, 400.5, 428.5);

    // The 32px shift starts the label at the protected 135px line and leaves the deck trigger
    // at 432.5–460.5, before the 473.5px transcript end.
    expect(approvalPlacementShift(timeline, card)).toBe(-32);
    timeline.remove();
  });

  test('a trailing deck trigger keeps the full labeled unit at the transcript end when it fits', () => {
    const timeline = document.createElement('div');
    const item = document.createElement('div');
    item.className = 'cinder-tool-call-rail__item';
    const label = document.createElement('button');
    label.className = 'cinder-tool-call-rail__row';
    const card = document.createElement('div');
    const actions = document.createElement('div');
    actions.className = 'cinder-approval-card__row-actions';
    const deck = document.createElement('div');
    card.append(actions, deck);
    item.append(label, card);
    timeline.append(item);
    document.body.append(timeline);
    stubBox(timeline, 52, 473.5);
    timeline.style.setProperty('--cinder-chat-overlay-inset-start', '71px');
    timeline.style.paddingTop = '83px';
    Object.defineProperty(timeline, 'scrollHeight', { value: 893, configurable: true });
    Object.defineProperty(timeline, 'clientHeight', { value: 422, configurable: true });
    Object.defineProperty(timeline, 'scrollTop', { value: 454, configurable: true });
    stubBox(label, 170, 214);
    stubBox(card, 218, 430);
    stubBox(actions, 330, 358);
    stubBox(deck, 370, 398);

    // The 260px labeled unit plus the 32px overlay fade fits the 338.5px arrival box, so the
    // established 17px end-rest remains instead of using the shorter action-row fallback.
    expect(approvalPlacementShift(timeline, card)).toBe(17);
    timeline.remove();
  });

  test('the labelling row is found in the real Interborough shape: a rail item holding the row and the card, with no message article', () => {
    // Interborough draws its messages through its own `row` snippet: a ToolCallRail whose item holds
    // the call's row and, in `.cinder-tool-call-rail__nested`, the approval card. There is no
    // `article[data-message-id]` around them.
    const timeline = document.createElement('div');
    timeline.className = 'chat-timeline';
    const wrapper = document.createElement('div');
    const rail = document.createElement('div');
    rail.className = 'cinder-tool-call-rail';
    const earlierItem = document.createElement('div');
    earlierItem.className = 'cinder-tool-call-rail__item';
    const earlier = document.createElement('button');
    earlier.className = 'cinder-tool-call-rail__row';
    earlierItem.append(earlier);
    const item = document.createElement('div');
    item.className = 'cinder-tool-call-rail__item';
    const label = document.createElement('button');
    label.className = 'cinder-tool-call-rail__row';
    const nested = document.createElement('div');
    nested.className = 'cinder-tool-call-rail__nested';
    const card = document.createElement('div');
    nested.append(card);
    item.append(label, nested);
    rail.append(earlierItem, item);
    wrapper.append(rail);
    timeline.append(wrapper);
    document.body.append(timeline);
    stubBox(earlier, 60, 100);
    stubBox(label, 123, 175);
    stubBox(card, 180, 425);

    expect(card.closest('article[data-message-id]')).toBeNull();
    // The row of the card's own item leads the unit, not the earlier call's row.
    expect(approvalUnitBox(card)).toEqual({ top: 123, bottom: 425 });
    timeline.remove();
  });

  test('the card and the row that labels it are one unit to keep clear', () => {
    const message = document.createElement('article');
    message.setAttribute('data-message-id', 'm1');
    const earlier = document.createElement('div');
    earlier.className = 'cinder-tool-call-rail__row';
    const label = document.createElement('button');
    label.className = 'cinder-tool-call-rail__row';
    const card = document.createElement('div');
    message.append(earlier, label, card);
    document.body.append(message);
    stubBox(earlier, 100, 140);
    stubBox(label, 159, 211);
    stubBox(card, 215, 400);

    // The nearest row before the card labels it, so its top, not the card's, leads the unit.
    expect(approvalUnitBox(card)).toEqual({ top: 159, bottom: 400 });
    message.remove();
  });
});

describe('where a waiting approval lands when it opens (COR-2327)', () => {
  // A transcript 286px tall, as on a 320 by 640 phone, and the 12px clearance under a card.
  const viewport = { top: 100, bottom: 386 };

  test('a card that fits is shown whole: scrolled down until its bottom and the clearance show', () => {
    const card = { top: 300, bottom: 540 };
    expect(approvalTallerThanTranscript(card, viewport)).toBe(false);
    expect(approvalArrivalShift(card, viewport)).toBe(540 + APPROVAL_BOTTOM_CLEARANCE - 386);
  });

  test('a card that fits with its top above the transcript scrolls up to its top', () => {
    expect(approvalArrivalShift({ top: 40, bottom: 200 }, viewport)).toBe(-60);
  });

  test('a card that fits and is in view stays where it is', () => {
    expect(approvalArrivalShift({ top: 120, bottom: 360 }, viewport)).toBe(0);
  });

  test('a card taller than the transcript has its actions aligned to the bottom, its top off', () => {
    const below = { top: 200, bottom: 585 };
    expect(approvalTallerThanTranscript(below, viewport)).toBe(true);
    expect(approvalArrivalShift(below, viewport)).toBe(585 + APPROVAL_BOTTOM_CLEARANCE - 386);
    // Shown from its top (as a lift would), it scrolls down until the bottom is at the bottom.
    const fromTop = { top: 108, bottom: 493 };
    expect(approvalArrivalShift(fromTop, viewport)).toBe(493 + APPROVAL_BOTTOM_CLEARANCE - 386);
    // Already aligned, it stays.
    expect(approvalArrivalShift({ top: -11, bottom: 374 }, viewport)).toBe(0);
  });

  test('a card that fits rests at the end the transcript pins to, reached from above or from the end', () => {
    // The transcript ends 15px under the card: its end padding, more than the clearance.
    const atEnd = { top: 131, bottom: 371 };
    // From above, 169px short of the end: it scrolls to the end, not 3px short of it.
    const fromAbove = { top: 300, bottom: 540 };
    expect(approvalArrivalShift(fromAbove, viewport)).toBe(166);
    expect(approvalArrivalRestShift(fromAbove, viewport, 169)).toBe(169);
    // Already at the end, where the transcript's pin put it, it stays: one resting place.
    expect(approvalArrivalRestShift(atEnd, viewport, 0)).toBe(0);
    // Whole in view but short of the end, it goes on to the end while the end keeps it whole.
    expect(approvalArrivalRestShift({ top: 151, bottom: 359 }, viewport, 20)).toBe(20);
  });

  test('a card rests short of the end when the end would scroll its top off', () => {
    const card = { top: 120, bottom: 360 };
    expect(approvalArrivalRestShift(card, viewport, 40)).toBe(0);
    expect(approvalArrivalRestShift({ top: 300, bottom: 540 }, viewport, 400)).toBe(166);
  });

  test('a card with its labelling row above it rests at the end only while the whole unit clears the overlay', () => {
    // `viewport` here starts below the header overlay. The labelling row (top 159) leads the unit.
    const unit = { top: 159, bottom: 340 };
    // The end moves the unit up 20px: its top lands at 139, still below the box's top (100).
    expect(approvalArrivalRestShift(unit, viewport, 20)).toBe(20);
    // The end would move it up 80px, its top to 79: under the header, so it stays where it is.
    expect(approvalArrivalRestShift(unit, viewport, 80)).toBe(0);
  });

  test('under a header, the place a unit is put is a place it rests: a second pass moves nothing', () => {
    // 320 by 640: the box runs from 179, under the header, to 476. A unit of 300px does not fit
    // above the end fade, and one of 200px does; each starts below, above and astride its rest.
    const box = { top: 179, bottom: 476 };
    for (const blockSize of [300, 200]) {
      for (const top of [-200, 60, 144, 179, 240, 520]) {
        const unit = { top, bottom: top + blockSize };
        const shift = approvalArrivalRestShift(unit, box, 1000, APPROVAL_BOTTOM_CLEARANCE, true);
        const placed = { top: unit.top - shift, bottom: unit.bottom - shift };
        const again = approvalArrivalRestShift(
          placed,
          box,
          1000 - shift,
          APPROVAL_BOTTOM_CLEARANCE,
          true,
        );
        expect(again, `${blockSize}px unit from ${top}`).toBe(0);
        // The decision row, the unit's bottom, is whole above the end fade either way.
        expect(placed.bottom, `${blockSize}px unit from ${top}`).toBeLessThanOrEqual(476 - 24);
        if (blockSize === 200) expect(placed.top).toBeGreaterThanOrEqual(179);
        // The unit that does not fit keeps its decision row in the box's lower half: on the fade
        // line when it had to move, and where it was when it was already there.
        else expect(placed.bottom).toBeGreaterThanOrEqual((179 + 476) / 2);
      }
    }
  });

  test('a unit that does not fit and already shows its decision row is never scrolled up off the end', () => {
    // 320 by 640 at the transcript's end: the label row is at 123, under the header that ends at
    // 167, and the card's bottom is at 428, above the fade line (444). It rests there.
    const box = { top: 179, bottom: 476 };
    expect(
      approvalArrivalRestShift({ top: 123, bottom: 428 }, box, 0, APPROVAL_BOTTOM_CLEARANCE, true),
    ).toBe(0);
    // Jump to latest's band, were it to show, shrinks the box: still no shift, so nothing feeds.
    for (const bottom of [476, 440, 430]) {
      expect(
        approvalArrivalRestShift(
          { top: 123, bottom: 428 },
          { top: 179, bottom },
          0,
          APPROVAL_BOTTOM_CLEARANCE,
          true,
        ),
      ).toBe(0);
    }
  });

  test('a card above the transcript, or taller than it, keeps the shift that places it', () => {
    expect(approvalArrivalRestShift({ top: 40, bottom: 200 }, viewport, 100)).toBe(-60);
    const taller = { top: 200, bottom: 585 };
    expect(approvalArrivalRestShift(taller, viewport, 300)).toBe(
      585 + APPROVAL_BOTTOM_CLEARANCE - 386,
    );
  });

  test('the clearance counts: a card exactly the transcript tall is taller with it', () => {
    expect(approvalTallerThanTranscript({ top: 100, bottom: 386 }, viewport)).toBe(true);
    expect(approvalTallerThanTranscript({ top: 100, bottom: 374 }, viewport)).toBe(false);
  });
});

describe('approval review box', () => {
  const row = { top: 330, bottom: 370, left: 10, right: 290 };
  const viewport = { top: 0, bottom: 400, left: 0, right: 300 };

  test('reaches the card bottom plus the clearance when the card fits', () => {
    const box = approvalReviewBox(row, { top: 100, bottom: 380 }, 400);
    expect(box).toEqual({ ...row, bottom: 380 + APPROVAL_BOTTOM_CLEARANCE });
  });

  test('a row flush against the transcript bottom is not visible, so the reminder shows', () => {
    const flush = { top: 340, bottom: 380, left: 10, right: 290 };
    const box = approvalReviewBox(flush, { top: 100, bottom: 392 }, 400);
    expect(approvalRowVisible(box, viewport, false, 0)).toBe(false);
  });

  test('scrolls until the clearance sits below the card', () => {
    const flush = { top: 360, bottom: 400, left: 10, right: 290 };
    const box = approvalReviewBox(flush, { top: 100, bottom: 412 }, 400);
    expect(approvalActionRowShift(box, viewport, 0)).toBe(24);
  });

  test('falls back to the row when the card with its clearance is taller than the box', () => {
    expect(approvalReviewBox(row, { top: 0, bottom: 395 }, 70)).toBe(row);
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

  test('a row partly under the composer is not visible either way', () => {
    expect(answers(row(380, 424))).toEqual([false, false]);
  });

  test('a row above the fold is not visible either way', () => {
    expect(answers(row(-20, 24))).toEqual([false, false]);
  });

  test('a row ending at or above the tall box bottom is visible in both reminder states', () => {
    expect(answers(row(330, 374))).toEqual([true, true]);
    expect(answers(row(356, 400))).toEqual([true, true]);
    expect(answers(row(358, 402))).toEqual([false, false]);
  });

  test('a row clipped on the side is not visible', () => {
    expect(
      approvalRowVisible({ top: 100, bottom: 140, left: -5, right: 290 }, without, false, 0),
    ).toBe(false);
  });

  test('the visible box is the reminder-absent box in both states', () => {
    expect(approvalVisibleBox(without, false, reminder).bottom).toBe(400);
    expect(approvalVisibleBox(withReminder, true, reminder).bottom).toBe(400);
  });

  test('the arrival scroll targets the same box, so a row it clears is a row the reminder accepts', () => {
    const rowBox = row(380, 424);
    const box = approvalVisibleBox(withReminder, true, reminder);
    const shift = approvalActionRowShift(rowBox, box, 8);
    const moved = row(rowBox.top - shift, rowBox.bottom - shift);
    expect(answers(moved)).toEqual([true, true]);
  });
});
