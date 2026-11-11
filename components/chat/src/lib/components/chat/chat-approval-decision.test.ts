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

const DRAWER_COPY = 'Waiting for your approval. Anything you send now queues until you decide.';
const QUESTION = 'Refund order 4471 for $42.00?';

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

const refundDetails: ChatAdapter['describeApproval'] = () => ({
  irreversible: true,
  approveLabel: 'Refund $42.00',
  pauseSentence: 'The agent is paused until you decide.',
  facts: [
    { label: 'Target', value: 'order 4471' },
    { label: 'Amount', value: '$42.00' },
  ],
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

  test('says an approval waits, in the exact words, with Review approval', () => {
    const { container } = render(Chat, {
      id: 'chat-drawer-waiting',
      conversation: approvalConversation('drawer-waiting'),
    });
    const drawer = drawerOf(container);

    expect(drawer).not.toBeNull();
    expect(drawer?.querySelector('.chat-approval-drawer-text')?.textContent).toBe(DRAWER_COPY);
    expect(getByRole(drawer!, 'button', { name: 'Review approval' })).not.toBeNull();
  });

  test('sits above the composer, so the composer keeps its place', () => {
    const { container } = render(Chat, {
      id: 'chat-drawer-order',
      conversation: approvalConversation('drawer-order'),
    });
    const drawer = drawerOf(container)!;
    const composer = container.querySelector('.chat-input')!;

    expect(
      drawer.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(drawer.parentElement).toBe(composer.parentElement);
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
    expect(send.textContent?.trim()).toBe('Queue');
    expect(send.querySelector('[data-chat-queue-icon]')).not.toBeNull();
  });
});

describe('Chat approval decision surface', () => {
  test('keeps the shared row for an approval the adapter does not describe', () => {
    const { container } = render(Chat, {
      id: 'chat-decision-row',
      conversation: approvalConversation('decision-row'),
      adapter: { sendMessage: async () => undefined, resolveToolApproval: async () => undefined },
    });

    expect(
      getByRole(container, 'article', { name: QUESTION }).getAttribute('data-cinder-layout'),
    ).toBe('row');
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
      'Irreversible',
    );
    expect(card.querySelector('.cinder-approval-card__pause')?.textContent?.trim()).toBe(
      'The agent is paused until you decide.',
    );
    const labels = Array.from(card.querySelectorAll('.cinder-approval-card__fact dt'), (term) =>
      term.textContent?.trim(),
    );
    expect(labels).toEqual(['Tool', 'Target', 'Amount', 'Command']);
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

  test('draws the shared row when the adapter throws', () => {
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

    expect(
      getByRole(container, 'article', { name: QUESTION }).getAttribute('data-cinder-layout'),
    ).toBe('row');
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

    const receipt = getByRole(container, 'article', { name: QUESTION });
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

    const receipt = getByRole(view.container, 'article', { name: QUESTION });
    expect(receipt.getAttribute('data-cinder-state')).toBe('approved');
    expect(receipt.querySelector('.cinder-badge')?.textContent?.trim()).toBe('Approved');
    expect(drawerOf(view.container)).toBeNull();
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
  });
});
