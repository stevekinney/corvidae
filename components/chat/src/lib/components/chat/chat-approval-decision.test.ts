/**
 * The explicit approval decision as Chat wires it: the composer drawer that says an approval
 * waits (with Review approval and Queue on a draft's Send), the decision surface an adapter's
 * `describeApproval` turns on, an irreversible press that arms first, and the receipt a decision
 * leaves in the transcript, even after the run resumes.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import type { ChatAdapter } from './adapter/chat-adapter.ts';
import {
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
} from './builders.ts';
import type { ConversationHistory } from './conversation-model.ts';

setupHappyDom();

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const originalResizeObserver = globalThis.ResizeObserver;
globalThis.ResizeObserver = TestResizeObserver;

class TestIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
const originalIntersectionObserver = globalThis.IntersectionObserver;
globalThis.IntersectionObserver =
  TestIntersectionObserver as unknown as typeof IntersectionObserver;
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
HTMLElement.prototype.scrollIntoView = () => undefined;
afterAll(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.IntersectionObserver = originalIntersectionObserver;
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

const { render, fireEvent, cleanup, getByRole, queryByRole } =
  await import('@testing-library/svelte');
const { default: Chat } = await import('./chat.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const QUESTION = 'Refund order 4471 for $42.00?';
/** A decided card is named for what was decided, not for the question it asked. */
const APPROVED_REFUND = 'Approved: Refund $42.00, order 4471';

function approvalConversation(id: string): ConversationHistory {
  return appendToolResult(
    appendToolCall(appendUserMessage(createConversationHistory({ id }), 'refund it'), {
      id: 'call',
      name: 'issue-refund',
      arguments: { orderId: '4471' },
    }),
    {
      callId: 'call',
      outcome: 'action_required',
      content: null,
      action: {
        type: 'approval',
        message: QUESTION,
        risk: 'high',
        operation: { kind: 'command', command: 'refund --order 4471 --amount 42.00' },
        policyVersion: 'test-policy',
        idempotencyKey: 'test-approval',
      },
    },
  );
}

/** The same conversation once the run resumed: the call's result is its own output now. */
function resumedConversation(id: string): ConversationHistory {
  return appendToolResult(
    appendToolCall(appendUserMessage(createConversationHistory({ id }), 'refund it'), {
      id: 'call',
      name: 'issue-refund',
      arguments: { orderId: '4471' },
    }),
    { callId: 'call', outcome: 'success', content: 'Refunded $42.00.' },
  );
}

function composerOf(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>('textarea.chat-input-editor')!;
}

function drawerOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-chat-approval-drawer]');
}

function sendButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('button[data-chat-send]')!;
}

function measuredBox(top: number, bottom: number, left = 0, right = 320): DOMRect {
  return new DOMRect(left, top, right - left, bottom - top);
}

const ACTION_ROW = '.cinder-approval-card__row-actions, .cinder-approval-card__action-row';
const resolvingAdapter: ChatAdapter = {
  sendMessage: async () => undefined,
  resolveToolApproval: async () => undefined,
};

const refundDetails: ChatAdapter['describeApproval'] = () => ({
  irreversible: true,
  approveLabel: 'Refund $42.00',
  pauseSentence: 'The agent is paused until you decide.',
  facts: [
    { label: 'Target', value: 'order 4471' },
    { label: 'Amount', value: '$42.00' },
  ],
});

describe('Chat step summary beside an approval card', () => {
  test('the step row leaves the waiting words to the card that owns the state', () => {
    const { container } = render(Chat, {
      id: 'chat-summary-owned',
      conversation: approvalConversation('summary-owned'),
      adapter: resolvingAdapter,
    });
    const timeline = container.querySelector<HTMLElement>('.chat-tool-call-timeline');
    expect(timeline).not.toBeNull();
    expect(container.textContent).toContain(QUESTION);
    expect(timeline!.querySelector('.chat-tool-call-summary-count')).not.toBeNull();
    expect(timeline!.querySelector('[data-problem]')).toBeNull();
  });
});

describe('Chat composer drawer for a waiting approval', () => {
  test('shows no drawer while nothing waits', () => {
    const { container } = render(Chat, {
      id: 'chat-drawer-idle',
      conversation: appendUserMessage(createConversationHistory({ id: 'idle' }), 'hi'),
    });

    expect(drawerOf(container)).toBeNull();
    expect(sendButton(container).getAttribute('aria-label')).toBe('Send message');
  });

  test('does not draw an unnecessary drawer when the measured card fits the transcript viewport', () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.matches('.chat-timeline')) return measuredBox(0, 600);
      if (this.matches('.cinder-approval-card')) return measuredBox(120, 420, 16, 304);
      return originalGetBoundingClientRect.call(this);
    };
    try {
      const { container } = render(Chat, {
        id: 'chat-drawer-fitting-card',
        conversation: approvalConversation('drawer-fitting-card'),
      });

      expect(drawerOf(container)).toBeNull();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  test('explains the paused composer compactly without repeating the transcript card', () => {
    const { container } = render(Chat, {
      id: 'chat-drawer-waiting',
      conversation: approvalConversation('drawer-waiting'),
    });
    const drawer = drawerOf(container);

    expect(drawer).not.toBeNull();
    expect(drawer?.querySelector('.chat-approval-drawer-text')?.textContent?.trim()).toBe(
      'Waiting for your approval.',
    );
    expect(getByRole(drawer!, 'button', { name: 'Review approval' })).not.toBeNull();
  });

  test('draws no reminder while the card top is clipped but its action row is in view', () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.matches('.chat-timeline')) return measuredBox(0, 600);
      if (this.matches('.cinder-approval-card')) return measuredBox(-60, 420, 16, 304);
      if (this.matches(ACTION_ROW)) {
        return measuredBox(370, 410, 16, 304);
      }
      return originalGetBoundingClientRect.call(this);
    };
    try {
      const { container } = render(Chat, {
        id: 'chat-drawer-clipped-top',
        conversation: approvalConversation('drawer-clipped-top'),
        adapter: resolvingAdapter,
      });

      expect(container.querySelector(ACTION_ROW)).not.toBeNull();
      expect(drawerOf(container)).toBeNull();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  test('scrolls the transcript when the approval arrives so the action row clears the bottom', async () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    let scrolled = 0;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.matches('.chat-timeline')) return measuredBox(0, 600);
      if (this.matches('.cinder-approval-card')) return measuredBox(330, 700, 16, 304);
      if (this.matches(ACTION_ROW)) {
        return measuredBox(650 - scrolled, 690 - scrolled, 16, 304);
      }
      return originalGetBoundingClientRect.call(this);
    };
    try {
      const { container } = render(Chat, {
        id: 'chat-drawer-arrival-scroll',
        conversation: approvalConversation('drawer-arrival-scroll'),
        adapter: resolvingAdapter,
      });
      const timeline = container.querySelector<HTMLElement>('.chat-timeline')!;
      const before = timeline.scrollTop;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      scrolled = timeline.scrollTop - before;
      expect(scrolled).toBeGreaterThan(0);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  test('arrives with the block that owns the approval at the top of the transcript when it fits whole', async () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    let timeline: HTMLElement | undefined;
    const lift = (): number => timeline?.scrollTop ?? 0;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.matches('.chat-timeline')) return measuredBox(0, 600);
      // The step row and the card sit 240 down the transcript, a card of 250 below it.
      if (this.matches('.chat-tool-call-group')) return measuredBox(240 - lift(), 560 - lift());
      if (this.matches('.cinder-approval-card')) {
        return measuredBox(310 - lift(), 560 - lift(), 16, 304);
      }
      if (this.matches(ACTION_ROW)) {
        return measuredBox(500 - lift(), 540 - lift(), 16, 304);
      }
      return originalGetBoundingClientRect.call(this);
    };
    try {
      const { container } = render(Chat, {
        id: 'chat-arrival-block-top',
        conversation: approvalConversation('arrival-block-top'),
        adapter: resolvingAdapter,
      });
      timeline = container.querySelector<HTMLElement>('.chat-timeline')!;
      // The card holds focus, as a host leaves it on opening; that does not keep it where it was.
      container.querySelector<HTMLElement>('.cinder-approval-card')?.focus();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      // The block's top is the transcript's top, and a further pass moves it no more.
      expect(timeline.scrollTop).toBe(240);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  test('renders host-provided approval drawer labels and accessible names', () => {
    const { container } = render(Chat, {
      id: 'chat-drawer-labels',
      conversation: approvalConversation('drawer-labels'),
      labels: {
        approvalWaiting: 'Genehmigung wartet',
        approvalWaitingText: 'Bitte zuerst die Genehmigung prüfen.',
        reviewApproval: 'Genehmigung öffnen',
      },
    });
    const drawer = drawerOf(container)!;
    expect(drawer.getAttribute('aria-label')).toBe('Genehmigung wartet');
    expect(drawer.querySelector('.chat-approval-drawer-text')?.textContent?.trim()).toBe(
      'Bitte zuerst die Genehmigung prüfen.',
    );
    expect(getByRole(drawer, 'button', { name: 'Genehmigung öffnen' })).not.toBeNull();
  });

  test('sits above the composer, so the composer keeps its place', () => {
    const { container } = render(Chat, {
      id: 'chat-drawer-order',
      conversation: approvalConversation('drawer-order'),
    });
    const drawer = drawerOf(container)!;
    const shell = container.querySelector('.chat-input-shell')!;

    expect(drawer.compareDocumentPosition(shell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(drawer.parentElement).toBe(shell.parentElement);
  });

  test('Review approval scrolls to the card and focuses it without answering it', async () => {
    const resolutions: unknown[] = [];
    const adapter: ChatAdapter = {
      sendMessage: async () => undefined,
      resolveToolApproval: async (toolCallId, resolution) => {
        resolutions.push([toolCallId, resolution]);
      },
    };
    const { container } = render(Chat, {
      id: 'chat-drawer-review',
      conversation: approvalConversation('drawer-review'),
      adapter,
    });
    const card = getByRole(container, 'article', { name: QUESTION });
    composerOf(container).focus();

    await fireEvent.click(getByRole(drawerOf(container)!, 'button', { name: 'Review approval' }));
    await tick();

    expect(document.activeElement).toBe(card);
    expect(resolutions).toEqual([]);
  });

  test('says nothing once the approval has expired', () => {
    const expired = appendToolResult(
      appendToolCall(appendUserMessage(createConversationHistory({ id: 'drawer-expired' }), 'go'), {
        id: 'call',
        name: 'issue-refund',
        arguments: {},
      }),
      {
        callId: 'call',
        outcome: 'action_required',
        content: null,
        action: {
          type: 'approval',
          message: QUESTION,
          risk: 'high',
          operation: { kind: 'other' },
          policyVersion: 'test-policy',
          idempotencyKey: 'test-approval',
          expiresAt: '2000-01-01T00:00:00.000Z',
        },
      },
    );
    const { container } = render(Chat, { id: 'chat-drawer-expired', conversation: expired });

    expect(drawerOf(container)).toBeNull();
  });

  test('leaves the blocked composer to say why on its own row', () => {
    const { container } = render(Chat, {
      id: 'chat-drawer-blocked',
      conversation: approvalConversation('drawer-blocked'),
      composerStatus: { kind: 'blocked', reason: 'Connect a model provider to chat' },
    });

    expect(drawerOf(container)).toBeNull();
    expect(container.querySelector('.chat-input-blocked-reason')?.textContent).toBe(
      'Connect a model provider to chat',
    );
  });

  test('the drawer goes away once the approval is decided', async () => {
    const adapter: ChatAdapter = {
      sendMessage: async () => undefined,
      resolveToolApproval: async () => undefined,
    };
    const { container } = render(Chat, {
      id: 'chat-drawer-decided',
      conversation: approvalConversation('drawer-decided'),
      adapter,
    });
    const card = getByRole(container, 'article', { name: QUESTION });

    await fireEvent.click(getByRole(card, 'button', { name: 'Approve' }));
    await tick();

    expect(drawerOf(container)).toBeNull();
  });

  test('a draft makes Send read Queue with the queue icon, and an empty box leaves it Send', async () => {
    const { container } = render(Chat, {
      id: 'chat-drawer-queue',
      conversation: approvalConversation('drawer-queue'),
      adapter: { sendMessage: async () => undefined, sendRunInput: async () => undefined },
    });

    expect(sendButton(container).getAttribute('aria-label')).toBe('Send message');
    expect(container.querySelector('[data-chat-queue-icon]')).toBeNull();

    await fireEvent.input(composerOf(container), { target: { value: 'one more thing' } });
    await tick();

    const send = sendButton(container);
    expect(send.getAttribute('aria-label')).toBe('Queue message');
    expect(send.querySelector('[data-chat-queue-icon]')).not.toBeNull();
  });

  test('a draft makes the reminder and the Queue description say what a send does now', async () => {
    const note = 'Messages you send now wait until you decide.';
    const { container } = render(Chat, {
      id: 'chat-drawer-queue-note',
      conversation: approvalConversation('drawer-queue-note'),
      adapter: { sendMessage: async () => undefined, sendRunInput: async () => undefined },
    });
    const reminder = () =>
      drawerOf(container)?.querySelector('.chat-approval-drawer-text')?.textContent?.trim();

    // An empty composer keeps the short form, and Queue's note does not exist yet.
    expect(reminder()).toBe('Waiting for your approval.');
    expect(container.querySelector('#chat-drawer-queue-note-input-queue-note')).toBeNull();

    await fireEvent.input(composerOf(container), { target: { value: 'one more thing' } });
    await tick();

    expect(reminder()).toBe(`Waiting for your approval. ${note}`);
    const describedBy = sendButton(container).getAttribute('aria-describedby') ?? '';
    const noteElement = describedBy
      .split(' ')
      .map((described) => container.ownerDocument.getElementById(described))
      .find((element) => element?.textContent === note);
    expect(noteElement).not.toBeUndefined();
  });
});

describe('Chat approval decision surface', () => {
  test('draws the decision for an approval the adapter does not describe, without the extras', () => {
    const { container } = render(Chat, {
      id: 'chat-decision-plain',
      conversation: approvalConversation('decision-plain'),
      adapter: { sendMessage: async () => undefined, resolveToolApproval: async () => undefined },
    });
    const card = getByRole(container, 'article', { name: QUESTION });

    expect(card.getAttribute('data-cinder-layout')).toBe('decision');
    expect(card.querySelector('.cinder-approval-card__irreversible')).toBeNull();
    expect(getByRole(card, 'button', { name: 'Approve' })).not.toBeNull();
  });

  test('draws the decision for an approval the adapter describes, with the badge, the facts and the command', () => {
    const { container } = render(Chat, {
      id: 'chat-decision-draw',
      conversation: approvalConversation('decision-draw'),
      adapter: {
        sendMessage: async () => undefined,
        resolveToolApproval: async () => undefined,
        describeApproval: refundDetails,
      },
    });
    const card = getByRole(container, 'article', { name: QUESTION });

    expect(card.getAttribute('data-cinder-layout')).toBe('decision');
    expect(card.querySelector('.cinder-approval-card__irreversible')?.textContent?.trim()).toBe(
      "Can't be undone",
    );
    expect(card.querySelector('.cinder-approval-card__pause')?.textContent?.trim()).not.toBe(
      'The agent is paused until you decide.',
    );
    const labels = Array.from(card.querySelectorAll('.cinder-approval-card__fact dt'), (term) =>
      term.textContent?.trim(),
    );
    expect(labels).toEqual(['Target', 'Amount', 'Command']);
    expect(card.querySelector('.cinder-approval-card__fact dt')?.textContent?.trim()).not.toBe(
      'Tool',
    );
    expect(
      Array.from(card.querySelectorAll('.cinder-approval-card__fact dd')).some((value) =>
        value.textContent?.includes('refund --order 4471'),
      ),
    ).toBe(true);
    expect(getByRole(card, 'button', { name: 'Refund $42.00' })).not.toBeNull();
  });

  test('hands the adapter the call id, its name and the action', () => {
    const seen: unknown[] = [];
    render(Chat, {
      id: 'chat-decision-args',
      conversation: approvalConversation('decision-args'),
      adapter: {
        sendMessage: async () => undefined,
        describeApproval: (toolCall, action) => {
          seen.push([toolCall, action.type, action.idempotencyKey]);
          return undefined;
        },
      },
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toEqual([{ id: 'call', name: 'issue-refund' }, 'approval', 'test-approval']);
  });

  test('draws the decision without the extras when the adapter throws', () => {
    const { container } = render(Chat, {
      id: 'chat-decision-throws',
      conversation: approvalConversation('decision-throws'),
      adapter: {
        sendMessage: async () => undefined,
        describeApproval: () => {
          throw new Error('describe failed');
        },
      },
    });

    const card = getByRole(container, 'article', { name: QUESTION });
    expect(card.getAttribute('data-cinder-layout')).toBe('decision');
    expect(card.querySelector('.cinder-approval-card__irreversible')).toBeNull();
  });

  test('an irreversible approval arms on the first press and resolves on the second', async () => {
    const resolutions: unknown[] = [];
    const { container } = render(Chat, {
      id: 'chat-decision-arm',
      conversation: approvalConversation('decision-arm'),
      adapter: {
        sendMessage: async () => undefined,
        describeApproval: refundDetails,
        resolveToolApproval: async (toolCallId, resolution) => {
          resolutions.push([toolCallId, resolution]);
        },
      },
    });
    const card = getByRole(container, 'article', { name: QUESTION });

    await fireEvent.click(getByRole(card, 'button', { name: 'Refund $42.00' }));
    await tick();
    expect(resolutions).toEqual([]);

    await fireEvent.click(getByRole(card, 'button', { name: 'Press again to refund $42.00' }));
    await tick();
    expect(resolutions).toEqual([['call', { decision: 'approve', remember: false }]]);
  });

  test('Escape on an armed press reverts the arm and leaves the approval open; the next Escape cancels it', async () => {
    const resolutions: unknown[] = [];
    const { container } = render(Chat, {
      id: 'chat-decision-escape',
      conversation: approvalConversation('decision-escape'),
      adapter: {
        sendMessage: async () => undefined,
        describeApproval: refundDetails,
        resolveToolApproval: async (toolCallId, resolution) => {
          resolutions.push([toolCallId, resolution]);
        },
      },
    });
    const card = getByRole(container, 'article', { name: QUESTION });

    await fireEvent.click(getByRole(card, 'button', { name: 'Refund $42.00' }));
    await tick();
    card.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await tick();

    expect(queryByRole(card, 'button', { name: 'Press again to refund $42.00' })).toBeNull();
    expect(resolutions).toEqual([]);

    card.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await tick();
    expect(resolutions).toEqual([['call', { decision: 'cancel', remember: false }]]);
  });
});

describe('Chat approval receipt', () => {
  test('an approval decided here reads as a receipt, with who and the note', async () => {
    const { container } = render(Chat, {
      id: 'chat-receipt-now',
      conversation: approvalConversation('receipt-now'),
      adapter: {
        sendMessage: async () => undefined,
        describeApproval: () => ({ irreversible: false, approveLabel: 'Refund' }),
        resolveToolApproval: async () => undefined,
      },
    });
    const card = getByRole(container, 'article', { name: QUESTION });

    await fireEvent.click(getByRole(card, 'button', { name: 'Add a note' }));
    await fireEvent.input(card.querySelector('textarea')!, {
      target: { value: 'Checked the order' },
    });
    await fireEvent.click(getByRole(card, 'button', { name: 'Refund' }));
    await tick();

    const receipt = getByRole(container, 'article', { name: 'Approved: Refund' });
    expect(receipt.querySelector('.cinder-badge')?.textContent?.trim()).toBe('Approved');
    expect(receipt.querySelector('.cinder-approval-card__receipt-by')?.textContent?.trim()).toMatch(
      /^by you, \d{1,2}:\d{2} [AP]M$/,
    );
    expect(queryByRole(receipt, 'button', { name: 'Refund' })).toBeNull();
  });

  test('the receipt stays in the transcript after the run resumes and the result stops asking', async () => {
    const adapter: ChatAdapter = {
      sendMessage: async () => undefined,
      describeApproval: refundDetails,
      resolveToolApproval: async () => undefined,
    };
    const view = render(Chat, {
      id: 'chat-receipt-kept',
      conversation: approvalConversation('receipt-kept'),
      adapter,
    });

    await fireEvent.click(getByRole(view.container, 'button', { name: 'Refund $42.00' }));
    await fireEvent.click(
      getByRole(view.container, 'button', { name: 'Press again to refund $42.00' }),
    );
    await tick();
    await view.rerender({ conversation: resumedConversation('receipt-kept') });
    await tick();

    const receipt = getByRole(view.container, 'article', { name: APPROVED_REFUND });
    expect(receipt.getAttribute('data-cinder-state')).toBe('approved');
    expect(receipt.querySelector('.cinder-badge')?.textContent?.trim()).toBe('Approved');
    expect(drawerOf(view.container)).toBeNull();
  });

  test('the receipt stays when the run resumes and the result stops asking before the adapter acknowledges', async () => {
    // The session controller replaces the result and resumes the run, and only then returns.
    let resumeRun: () => Promise<void> = async () => undefined;
    const adapter: ChatAdapter = {
      sendMessage: async () => undefined,
      describeApproval: refundDetails,
      resolveToolApproval: async () => {
        await resumeRun();
      },
    };
    const view = render(Chat, {
      id: 'chat-receipt-resumed-first',
      conversation: approvalConversation('receipt-resumed-first'),
      adapter,
    });
    resumeRun = () => view.rerender({ conversation: resumedConversation('receipt-resumed-first') });

    await fireEvent.click(getByRole(view.container, 'button', { name: 'Refund $42.00' }));
    await fireEvent.click(
      getByRole(view.container, 'button', { name: 'Press again to refund $42.00' }),
    );
    await tick();
    await tick();

    const receipt = getByRole(view.container, 'article', { name: APPROVED_REFUND });
    expect(receipt.getAttribute('data-cinder-state')).toBe('approved');
    expect(receipt.querySelector('.cinder-badge')?.textContent?.trim()).toBe('Approved');
  });

  test('a decided call keeps its own row beside a neighbouring completed call, so the receipt is not folded into a group', async () => {
    const withNeighbour = (id: string, asking: boolean): ConversationHistory => {
      const first = appendToolCall(appendUserMessage(createConversationHistory({ id }), 'go'), {
        id: 'call',
        name: 'issue-refund',
        arguments: { orderId: '4471' },
      });
      const decided = appendToolResult(
        first,
        asking
          ? {
              callId: 'call',
              outcome: 'action_required',
              content: null,
              action: {
                type: 'approval',
                message: QUESTION,
                risk: 'high',
                operation: { kind: 'other' },
                policyVersion: 'test-policy',
                idempotencyKey: 'test-approval',
              },
            }
          : { callId: 'call', outcome: 'success', content: 'Refunded $42.00.' },
      );
      return appendToolResult(
        appendToolCall(decided, { id: 'other', name: 'lookup-order', arguments: {} }),
        { callId: 'other', outcome: 'success', content: 'Order 4471' },
      );
    };
    const view = render(Chat, {
      id: 'chat-receipt-neighbour',
      conversation: withNeighbour('receipt-neighbour', true),
      adapter: {
        sendMessage: async () => undefined,
        describeApproval: refundDetails,
        resolveToolApproval: async () => undefined,
      },
    });

    await fireEvent.click(getByRole(view.container, 'button', { name: 'Refund $42.00' }));
    await fireEvent.click(
      getByRole(view.container, 'button', { name: 'Press again to refund $42.00' }),
    );
    await tick();
    await view.rerender({ conversation: withNeighbour('receipt-neighbour', false) });
    await tick();

    const receipt = getByRole(view.container, 'article', { name: APPROVED_REFUND });
    expect(receipt.getAttribute('data-cinder-state')).toBe('approved');
  });

  test('a call that was never decided here leaves no receipt once its result stops asking', async () => {
    const view = render(Chat, {
      id: 'chat-receipt-none',
      conversation: approvalConversation('receipt-none'),
      adapter: { sendMessage: async () => undefined, describeApproval: refundDetails },
    });

    await view.rerender({ conversation: resumedConversation('receipt-none') });
    await tick();

    expect(queryByRole(view.container, 'article', { name: QUESTION })).toBeNull();
    expect(view.container.querySelector('[data-cinder-tool-approval]')).toBeNull();
  });
});

describe('the reminder follows the decision row, not its own presence', () => {
  const REMINDER_HEIGHT = 48;
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  let rowTop = 0;

  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  });

  /** Lays the page out by hand: the transcript loses the reminder's room while the reminder shows. */
  function layOut(container: HTMLElement): HTMLElement {
    const box = (top: number, bottom: number): DOMRect => ({
      top,
      bottom,
      left: 0,
      right: 300,
      width: 300,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    });
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
      if (this.matches('[data-chat-approval-drawer]')) return box(0, REMINDER_HEIGHT);
      if (this.classList.contains('chat-timeline')) {
        const shown = container.querySelector('[data-chat-approval-drawer]') !== null;
        return box(0, 400 - (shown ? REMINDER_HEIGHT : 0));
      }
      if (this.matches('.cinder-approval-card__row-actions, .cinder-approval-card__action-row')) {
        return box(rowTop, rowTop + 44);
      }
      if (this.matches('.cinder-approval-card')) return box(rowTop - 80, rowTop + 60);
      return originalRect.call(this);
    };
    return container.querySelector<HTMLElement>('.chat-timeline')!;
  }

  async function scrollTo(scroller: HTMLElement, top: number): Promise<void> {
    rowTop = top;
    scroller.dispatchEvent(new Event('scroll'));
    await tick();
    await tick();
  }

  test('arrival, scrolling away, scrolling back and Review keep one answer per row position', async () => {
    rowTop = 150;
    const { container } = render(Chat, {
      id: 'chat-reminder-geometry',
      conversation: approvalConversation('reminder-geometry'),
      adapter: resolvingAdapter,
    });
    const scroller = layOut(container);
    await scrollTo(scroller, 150);
    // The row is in view with the reminder off: nothing to point to.
    expect(drawerOf(container)).toBeNull();

    // Scrolled away: the row is above the fold, so the reminder shows.
    await scrollTo(scroller, -200);
    expect(drawerOf(container)).not.toBeNull();

    // The row ends inside the strip the reminder takes, but within the box the transcript has
    // without the reminder: it is visible in both states, so the reminder goes and stays gone.
    // The card's bottom, 16 below the row, plus the 12 of clearance must also be inside that box.
    await scrollTo(scroller, 328);
    expect(drawerOf(container)).toBeNull();
    await scrollTo(scroller, 328);
    expect(drawerOf(container)).toBeNull();

    // A row whose card clears the box by less than the clearance keeps the reminder.
    await scrollTo(scroller, 340);
    expect(drawerOf(container)).not.toBeNull();

    // A row ending below the tall box brings the reminder back.
    await scrollTo(scroller, 380);
    expect(drawerOf(container)).not.toBeNull();
    await scrollTo(scroller, 380);
    expect(drawerOf(container)).not.toBeNull();

    // Back in view, it goes.
    await scrollTo(scroller, 200);
    expect(drawerOf(container)).toBeNull();
  });

  test('at maximum scroll the arrival scroll hides the reminder and a clamp does not bring it back', async () => {
    // Content is 700 tall and the row sits at 600 to 644 in it, near the end. The reminder starts
    // shown (a 352 tall transcript, maximum scroll 348), so the row at maximum scroll is at 252 to
    // 296. It is inside the tall box, so the reminder hides; the transcript then grows to 400, its
    // maximum scroll falls to 300 and `scrollTop` clamps, which moves the row to 300 to 344 (its
    // card, with the clearance, ends at 372). That is still inside the tall box, so the reminder
    // stays hidden instead of coming back and flapping.
    const rowDocumentTop = 600;
    rowTop = rowDocumentTop - 348;
    const { container } = render(Chat, {
      id: 'chat-reminder-clamp',
      conversation: approvalConversation('reminder-clamp'),
      adapter: resolvingAdapter,
    });
    const scroller = layOut(container);
    await scrollTo(scroller, rowDocumentTop - 348);
    expect(drawerOf(container)).toBeNull();
    await scrollTo(scroller, rowDocumentTop - 300);
    expect(drawerOf(container)).toBeNull();
    await scrollTo(scroller, rowDocumentTop - 300);
    expect(drawerOf(container)).toBeNull();
  });

  test('Review approval focuses the card and does not answer it', async () => {
    rowTop = -200;
    const { container } = render(Chat, {
      id: 'chat-reminder-review',
      conversation: approvalConversation('reminder-review'),
      adapter: resolvingAdapter,
    });
    const scroller = layOut(container);
    await scrollTo(scroller, -200);
    const card = getByRole(container, 'article', { name: QUESTION });
    await fireEvent.click(getByRole(drawerOf(container)!, 'button', { name: 'Review approval' }));
    await tick();
    expect(document.activeElement).toBe(card);
  });
});
