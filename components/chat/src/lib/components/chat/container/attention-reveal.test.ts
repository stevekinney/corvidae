import { describe, expect, test } from 'bun:test';
import { ATTENTION_INSET, findAttentionTarget, revealTopShift } from './attention-reveal.ts';

function root(html: string): HTMLElement {
  const element = document.createElement('div');
  element.innerHTML = html;
  return element;
}

describe('findAttentionTarget', () => {
  test('finds a pending approval card, and not a decided one', () => {
    const transcript = root(`
      <div class="cinder-approval-card" data-cinder-state="approved" id="decided"></div>
      <div class="cinder-approval-card" data-cinder-state="pending" id="pending"></div>
    `);
    expect(findAttentionTarget(transcript)?.id).toBe('pending');
  });

  test('returns the host block around an open question at the end, so its prompt is the top', () => {
    const transcript = root(`
      <div class="chat-trailing">
        <div class="host-question" id="block">
          <p>Which environment should the release go to?</p>
          <div><div class="chat-question" data-question-phase="open"></div></div>
        </div>
      </div>
    `);
    expect(findAttentionTarget(transcript)?.id).toBe('block');
  });

  test('skips a question that is answered, held or sent', () => {
    const transcript = root(`
      <div class="chat-question" data-question-phase="open">
        <p class="chat-question-answer"><span data-question-answer>Staging</span></p>
      </div>
      <div class="chat-question" data-question-phase="held"></div>
      <div class="chat-question" data-question-phase="sent"></div>
    `);
    expect(findAttentionTarget(transcript)).toBeNull();
  });

  test('finds nothing in a transcript with nothing waiting', () => {
    expect(findAttentionTarget(root('<article data-message-id="m1">Done.</article>'))).toBeNull();
  });
});

describe('revealTopShift', () => {
  // The phone and tablet chat: the pin showed Deny and Approve with the card's title, "Refund order
  // 4471 for $42.00?", above the transcript's top edge.
  test('lifts an item whose top is above the viewport until its top is in view', () => {
    expect(revealTopShift(200, 120, ATTENTION_INSET)).toBe(-(200 + ATTENTION_INSET - 120));
  });

  test('leaves an item whose top is already in view', () => {
    expect(revealTopShift(200, 260, ATTENTION_INSET)).toBe(0);
  });

  test('ignores half a pixel of rounding', () => {
    expect(revealTopShift(200, 200 + ATTENTION_INSET - 0.4, ATTENTION_INSET)).toBe(0);
  });
});
