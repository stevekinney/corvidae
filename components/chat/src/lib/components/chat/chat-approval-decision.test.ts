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
import { waitUntil } from '@lostgradient/testing/wait-until';
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

/**
 * Lets the arrival placement run: it runs on the next animation frame, and the reminder is drawn
 * only from a settled placement (COR-2327), so a test reads the reminder after it.
 */
async function arrivalFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await tick();
}

/** The reminder, once the arrival placement has settled and drawn it. */
async function settledDrawer(container: HTMLElement): Promise<HTMLElement> {
  await waitUntil(() => drawerOf(container) !== null, { message: 'the approval reminder' });
  return drawerOf(container)!;
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

  test('explains the paused composer compactly without repeating the transcript card', async () => {
    const { container } = render(Chat, {
      id: 'chat-drawer-waiting',
      conversation: approvalConversation('drawer-waiting'),
    });
    const drawer = await settledDrawer(container);

    expect(drawer).not.toBeNull();
    expect(drawer?.querySelector('.chat-approval-drawer-text')?.textContent?.trim()).toBe(
      'Waiting for your approval.',
    );
    expect(getByRole(drawer, 'button', { name: 'Review approval' })).not.toBeNull();
  });

  test('is the neutral notice, its action kept beside the words while both fit, reading Review in a narrow column and keeping its name (COR-2327 B1)', async () => {
    const { container } = render(Chat, {
      id: 'chat-drawer-one-row',
      conversation: approvalConversation('drawer-one-row'),
    });
    const drawer = await settledDrawer(container);

    // Cinder's notice recipe, with the fit layout: on a phone the action stays beside the words
    // while both fit, rather than dropping to a line of its own as the inline layout does.
    expect(drawer.classList.contains('cinder-callout')).toBe(true);
    expect(drawer.getAttribute('data-cinder-variant')).toBe('neutral');
    expect(drawer.classList.contains('cinder-callout--fit-action')).toBe(true);
    const review = getByRole(drawer, 'button', { name: 'Review approval' });
    expect(review.classList.contains('button-size-small')).toBe(true);
    expect(review.querySelector('.chat-approval-drawer-action-short')?.textContent).toBe('Review');

    // The short words show only in a narrow column: the Callout is its own inline-size container,
    // so the question is the notice's width, not the screen's.
    const source = await Bun.file(
      new URL('./container/chat-approval-drawer.svelte', import.meta.url),
    ).text();
    const narrow = /@container \(inline-size < 30rem\) \{([\s\S]*?)\n {2}\}\n/u.exec(source)?.[1];
    expect(narrow).toMatch(/\.chat-approval-drawer-action-full \{\s*display: none;/u);
    expect(narrow).toMatch(/\.chat-approval-drawer-action-short \{\s*display: inline;/u);
  });

  test('says the short Review in a host’s own words', async () => {
    const { container } = render(Chat, {
      id: 'chat-drawer-short-label',
      conversation: approvalConversation('drawer-short-label'),
      labels: { reviewApproval: 'Genehmigung prüfen', reviewApprovalShort: 'Prüfen' },
    });
    const review = getByRole(await settledDrawer(container), 'button', {
      name: 'Genehmigung prüfen',
    });
    expect(review.querySelector('.chat-approval-drawer-action-short')?.textContent).toBe('Prüfen');
  });

  test('draws no reminder while the card top is clipped but its action row is in view', async () => {
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
      await arrivalFrame();

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

  test('renders host-provided approval drawer labels and accessible names', async () => {
    const { container } = render(Chat, {
      id: 'chat-drawer-labels',
      conversation: approvalConversation('drawer-labels'),
      labels: {
        approvalWaiting: 'Genehmigung wartet',
        approvalWaitingText: 'Bitte zuerst die Genehmigung prüfen.',
        reviewApproval: 'Genehmigung öffnen',
      },
    });
    const drawer = await settledDrawer(container);
    expect(drawer.getAttribute('aria-label')).toBe('Genehmigung wartet');
    expect(drawer.querySelector('.chat-approval-drawer-text')?.textContent?.trim()).toBe(
      'Bitte zuerst die Genehmigung prüfen.',
    );
    expect(getByRole(drawer, 'button', { name: 'Genehmigung öffnen' })).not.toBeNull();
  });

  test('sits above the composer, so the composer keeps its place', async () => {
    const { container } = render(Chat, {
      id: 'chat-drawer-order',
      conversation: approvalConversation('drawer-order'),
    });
    const drawer = await settledDrawer(container);
    const shell = container.querySelector('.chat-input-shell')!;

    expect(drawer.compareDocumentPosition(shell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const drawers = drawer.closest('[data-chat-composer-drawers]');
    expect(drawers !== null && drawers.parentElement === shell.parentElement).toBe(true);
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
    const drawer = await settledDrawer(container);
    composerOf(container).focus();

    await fireEvent.click(getByRole(drawer, 'button', { name: 'Review approval' }));
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

  // COR-2438: after a decision refused because the run had stopped, the host drew the card as no
  // longer waiting, but the result still asked, so the reminder appeared over the composer and
  // pushed it 70px up.
  test('says nothing for an approval the host says no run waits on, and Send stays Send', async () => {
    const { container } = render(Chat, {
      id: 'chat-drawer-lapsed',
      conversation: approvalConversation('drawer-lapsed'),
      adapter: { sendMessage: async () => undefined, sendRunInput: async () => undefined },
      lapsedApprovals: new Set(['call']),
    });
    await arrivalFrame();
    await arrivalFrame();

    expect(drawerOf(container)).toBeNull();
    await fireEvent.input(composerOf(container), { target: { value: 'one more thing' } });
    await tick();
    expect(sendButton(container).getAttribute('aria-label')).toBe('Send message');
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
    const note = 'Anything you send now queues until you decide.';
    const { container } = render(Chat, {
      id: 'chat-drawer-queue-note',
      conversation: approvalConversation('drawer-queue-note'),
      adapter: { sendMessage: async () => undefined, sendRunInput: async () => undefined },
    });
    const reminder = () =>
      drawerOf(container)?.querySelector('.chat-approval-drawer-text')?.textContent?.trim();
    await settledDrawer(container);

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

    await fireEvent.click(getByRole(card, 'button', { name: 'Add note' }));
    await fireEvent.input(card.querySelector('textarea')!, {
      target: { value: 'Checked the order' },
    });
    await fireEvent.click(getByRole(card, 'button', { name: 'Refund' }));
    await tick();

    const receipt = getByRole(container, 'article', { name: 'Approved: Refund' });
    expect(
      receipt.querySelector('.cinder-approval-card__settled-note')?.textContent?.trim(),
    ).toMatch(/^Approved by you, \d{1,2}:\d{2} [AP]M$/);
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
    expect(
      receipt.querySelector('.cinder-approval-card__settled-note')?.textContent?.trim(),
    ).toMatch(/^Approved by you, \d{1,2}:\d{2} [AP]M$/);
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
    expect(
      receipt.querySelector('.cinder-approval-card__settled-note')?.textContent?.trim(),
    ).toMatch(/^Approved by you, \d{1,2}:\d{2} [AP]M$/);
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
    await arrivalFrame();
    await scrollTo(scroller, 150);
    // The row is in view with the reminder off: nothing to point to.
    expect(drawerOf(container)).toBeNull();

    // Scrolled away: the row is above the fold, so the reminder shows.
    await scrollTo(scroller, -200);
    expect(drawerOf(container)).not.toBeNull();

    // The row ends inside the strip the reminder takes, but within the box the transcript has
    // without the reminder: it is visible in both states, so the reminder goes and stays gone.
    await scrollTo(scroller, 328);
    expect(drawerOf(container)).toBeNull();
    await scrollTo(scroller, 328);
    expect(drawerOf(container)).toBeNull();

    // The row is judged alone (COR-2327 B1): with the row in view and the card's bottom past the
    // box, the reminder stays gone, since Deny and Approve are where the person can reach them.
    await scrollTo(scroller, 340);
    expect(drawerOf(container)).toBeNull();

    // A row ending below the tall box brings the reminder back.
    await scrollTo(scroller, 380);
    expect(drawerOf(container)).not.toBeNull();
    await scrollTo(scroller, 380);
    expect(drawerOf(container)).not.toBeNull();

    // Back in view, it goes.
    await scrollTo(scroller, 200);
    expect(drawerOf(container)).toBeNull();
  });

  test('on a 320 by 640 phone, a card nearly as tall as the transcript with its decision row in view draws no reminder (COR-2327 B1)', async () => {
    // CI run 43655239414, from its trace: the transcript shows 205 to 448 without the reminder,
    // Deny and Approve sit at 383 to 411, and the focused card ends at 425. Its bottom and the
    // 12px clearance under it reach 437, inside the box; a slightly taller card (Linux fonts) ends
    // 4px lower and its clearance passes the box, which kept the reminder over Deny and Approve.
    // Here the row sits 200 to 244 in a 400 tall transcript and the card ends at 392, 4 short of
    // the bottom: the clearance passes the box, the row does not.
    rowTop = 200;
    const { container } = render(Chat, {
      id: 'chat-reminder-phone',
      conversation: approvalConversation('reminder-phone'),
      adapter: resolvingAdapter,
    });
    const originalCard = HTMLElement.prototype.getBoundingClientRect;
    const scroller = layOut(container);
    const laidOut = HTMLElement.prototype.getBoundingClientRect;
    // The card starts 170 above the row and ends at 392.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
      if (this.matches('.cinder-approval-card')) {
        return new DOMRect(0, rowTop - 170, 300, 392 - (rowTop - 170));
      }
      return laidOut.call(this);
    };
    try {
      await arrivalFrame();
      await scrollTo(scroller, 200);
      expect(drawerOf(container)).toBeNull();
      await scrollTo(scroller, 200);
      expect(drawerOf(container)).toBeNull();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalCard;
    }
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
    await arrivalFrame();
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
    const drawer = await settledDrawer(container);
    await fireEvent.click(getByRole(drawer, 'button', { name: 'Review approval' }));
    await tick();
    expect(document.activeElement).toBe(card);
  });
});
