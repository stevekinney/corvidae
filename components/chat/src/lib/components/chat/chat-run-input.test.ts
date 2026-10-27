/**
 * Follow-ups during an active run (`ChatAdapter.sendRunInput`).
 *
 * Asserts:
 *   1. An adapter that provides `sendRunInput` keeps the composer live during a
 *      run, with Send and Stop side by side, and Enter submits a follow-up
 *      through it rather than through `sendMessage`.
 *   2. Without `sendRunInput`, the composer is disabled during a run, as before.
 *   3. A follow-up is also routed to `sendRunInput` while a tool approval is
 *      pending, and does not resolve the approval.
 *   4. Wired to the session controller, a follow-up renders pending until the
 *      transport acknowledges it, and a rejection marks it failed with a retry
 *      that resends it.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import { createChatSessionController } from '../../session/session-controller.ts';
import type { ChatStreamEvent } from '../../session/stream-event-codec.ts';
import type { ChatAdapter } from './adapter/chat-adapter.ts';
import {
  appendAssistantMessage,
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
afterAll(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.IntersectionObserver = originalIntersectionObserver;
});

const { render, fireEvent, cleanup } = await import('@testing-library/svelte');
const { default: Chat } = await import('./chat.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function composerOf(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>('textarea.chat-input-editor')!;
}

async function submit(container: HTMLElement, text: string): Promise<void> {
  const composer = composerOf(container);
  await fireEvent.input(composer, { target: { value: text } });
  await fireEvent.keyDown(composer, { key: 'Enter' });
  await tick();
}

function approvalConversation(id: string): ConversationHistory {
  return appendToolResult(
    appendToolCall(appendUserMessage(createConversationHistory({ id }), 'write it'), {
      id: 'call',
      name: 'write',
      arguments: {},
    }),
    {
      callId: 'call',
      outcome: 'action_required',
      content: null,
      action: {
        type: 'approval',
        message: 'Approve this tool call',
        risk: 'high',
        operation: { kind: 'command', command: 'echo approval', argsPreview: {} },
        policyVersion: 'test-policy',
        idempotencyKey: 'test-approval',
      },
    },
  );
}

describe('Chat follow-ups during a run', () => {
  test('keeps the composer live with Send and Stop side by side and submits through sendRunInput', async () => {
    const runInput: Array<{ id: string; content: unknown }> = [];
    const sent: unknown[] = [];
    let stops = 0;
    const adapter: ChatAdapter = {
      sendMessage: async (message) => {
        sent.push(message);
      },
      sendRunInput: async (conversationId, message) => {
        runInput.push({ id: conversationId, content: message.content });
      },
      stopGenerating: async () => {
        stops += 1;
      },
    };
    const conversation = appendAssistantMessage(
      appendUserMessage(createConversationHistory({ id: 'live' }), 'hello'),
      'working on it',
    );
    const { container } = render(Chat, {
      id: 'chat-live',
      conversation,
      streaming: true,
      adapter,
    });

    expect(composerOf(container).disabled).toBe(false);
    expect(container.querySelector('button[aria-label="Send message"]')).not.toBeNull();
    const stop = container.querySelector<HTMLButtonElement>('button[aria-label="Stop generating"]');
    expect(stop).not.toBeNull();

    await submit(container, 'one more thing');

    expect(runInput).toEqual([{ id: 'live', content: 'one more thing' }]);
    expect(sent).toEqual([]);

    await fireEvent.click(stop!);
    expect(stops).toBe(1);
  });

  test('keeps the composer disabled during a run when the adapter has no sendRunInput', () => {
    const adapter: ChatAdapter = { sendMessage: async () => undefined };
    const { container } = render(Chat, {
      id: 'chat-closed',
      conversation: createConversationHistory({ id: 'closed' }),
      streaming: true,
      adapter,
    });

    expect(composerOf(container).disabled).toBe(true);
    expect(container.querySelector('button[aria-label="Send message"]')).toBeNull();
    // Stop replaces Send here rather than sitting beside it.
    expect(container.querySelectorAll('button[aria-label="Stop generating"]')).toHaveLength(1);
  });

  test('routes a submission to sendRunInput while an approval is pending, leaving it unresolved', async () => {
    const runInput: unknown[] = [];
    const sent: unknown[] = [];
    const resolved: string[] = [];
    const adapter: ChatAdapter = {
      sendMessage: async (message) => {
        sent.push(message);
      },
      sendRunInput: async (_id, message) => {
        runInput.push(message.content);
      },
      resolveToolApproval: async (toolCallId) => {
        resolved.push(toolCallId);
      },
    };
    const { container } = render(Chat, {
      id: 'chat-approval',
      conversation: approvalConversation('approval'),
      adapter,
    });

    await submit(container, 'actually, hold on');

    expect(runInput).toEqual(['actually, hold on']);
    expect(sent).toEqual([]);
    expect(resolved).toEqual([]);
  });

  test('hands follow-ups to a raw adapter one at a time, in the order sent', async () => {
    const seen: string[] = [];
    const releases: Array<() => void> = [];
    const adapter: ChatAdapter = {
      sendMessage: async () => undefined,
      sendRunInput: (_id, message) => {
        seen.push(typeof message.content === 'string' ? message.content : '');
        return new Promise<void>((resolve) => releases.push(resolve));
      },
    };
    const { container } = render(Chat, {
      id: 'chat-serial',
      conversation: createConversationHistory({ id: 'serial' }),
      streaming: true,
      adapter,
    });

    await submit(container, 'first');
    await submit(container, 'second');
    await tick();

    // The first acknowledgement is slow, so the second has not been handed over.
    expect(seen).toEqual(['first']);
    releases[0]!();
    // load-proof: Svelte effects, event handlers and promise continuations settle in the microtask queue, so this turn only drains them and awaits no timer or IO
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(['first', 'second']);
    releases[1]!();
  });

  test('follow-ups queued for one conversation do not hold up the next', async () => {
    const seen: string[] = [];
    const adapter: ChatAdapter = {
      sendMessage: async () => undefined,
      // The first acknowledgement never arrives.
      sendRunInput: (_id, message) => {
        seen.push(typeof message.content === 'string' ? message.content : '');
        return new Promise<void>(() => undefined);
      },
    };
    const rendered = render(Chat, {
      id: 'chat-switch',
      conversation: createConversationHistory({ id: 'before' }),
      streaming: true,
      adapter,
    });
    await submit(rendered.container, 'stuck');
    await submit(rendered.container, 'behind it');
    expect(seen).toEqual(['stuck']);

    await rendered.rerender({ conversation: createConversationHistory({ id: 'after' }) });
    await tick();
    await submit(rendered.container, 'fresh');
    // load-proof: Svelte effects, event handlers and promise continuations settle in the microtask queue, so this turn only drains them and awaits no timer or IO
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(seen).toEqual(['stuck', 'fresh']);
  });

  test('sends an ordinary message through sendMessage when no run is active', async () => {
    const runInput: unknown[] = [];
    const sent: unknown[] = [];
    const adapter: ChatAdapter = {
      sendMessage: async (message) => {
        sent.push(message.content);
      },
      sendRunInput: async (_id, message) => {
        runInput.push(message.content);
      },
    };
    const { container } = render(Chat, {
      id: 'chat-idle',
      conversation: createConversationHistory({ id: 'idle' }),
      adapter,
    });

    await submit(container, 'plain message');

    expect(sent).toEqual(['plain message']);
    expect(runInput).toEqual([]);
  });
});

describe('Chat follow-ups wired to the session controller', () => {
  function createWiredChat(sendRunInput: (attempt: number) => Promise<void>) {
    let conversation = createConversationHistory({ id: 'wired' });
    let streaming = false;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempt = 0;
    const adaptersErrors: unknown[] = [];
    // eslint-disable-next-line prefer-const -- assigned after the controller captures the closures
    let rendered: ReturnType<typeof render<typeof Chat>>;
    const controller = createChatSessionController({
      // Follow-ups are offered for server-owned runs.
      executionOwner: 'server',
      getConversation: () => conversation,
      setConversation: (next) => {
        conversation = next;
        void rendered.rerender({ conversation: next });
      },
      transport: async () =>
        (async function* (): AsyncGenerator<ChatStreamEvent> {
          yield { type: 'text', text: 'working' };
          await held;
        })(),
      sendRunInput: async () => {
        attempt += 1;
        await sendRunInput(attempt);
      },
      hooks: {
        onStreamingChange: (value) => {
          streaming = value;
          void rendered.rerender({ streaming });
        },
      },
    });
    rendered = render(Chat, {
      id: 'chat-wired',
      conversation,
      adapter: controller.adapter,
      onAdapterError: (event) => adaptersErrors.push(event),
    });
    return { controller, rendered, release, adaptersErrors };
  }

  async function settle(): Promise<void> {
    // load-proof: Svelte effects, event handlers and promise continuations settle in the microtask queue, so this turn only drains them and awaits no timer or IO
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await tick();
  }

  test('shows the follow-up as pending until the transport acknowledges it', async () => {
    let acknowledge: () => void = () => undefined;
    const { controller, rendered, release } = createWiredChat(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const run = controller.adapter.sendMessage({ role: 'user', content: 'start' }, []);
    await settle();
    expect(composerOf(rendered.container).disabled).toBe(false);

    await submit(rendered.container, 'a follow-up');
    await settle();

    expect(rendered.container.textContent).toContain('a follow-up');
    const pendingLabel = rendered.container.querySelector('.chat-message-pending-label');
    expect(pendingLabel?.textContent).toBe('Sending…');
    // The transcript's log region announces the addition; the row adds no live region.
    expect(pendingLabel?.hasAttribute('role')).toBe(false);
    expect(rendered.container.querySelector('[data-pending]')).not.toBeNull();

    acknowledge();
    await settle();
    expect(rendered.container.querySelector('.chat-message-pending-label')).toBeNull();
    expect(rendered.container.querySelector('[data-pending]')).toBeNull();

    release();
    await run;
  });

  test('a second follow-up shows in the transcript at once, behind a slow first acknowledgement', async () => {
    let releaseFirst: () => void = () => undefined;
    const firstAcknowledgement = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let handedOver = 0;
    const { controller, rendered, release } = createWiredChat(async (attempt) => {
      handedOver = attempt;
      if (attempt === 1) await firstAcknowledgement;
    });
    const run = controller.adapter.sendMessage({ role: 'user', content: 'start' }, []);
    await settle();

    expect(controller.adapter.ordersRunInput).toBe(true);
    await submit(rendered.container, 'first');
    await submit(rendered.container, 'second');
    await settle();

    // The controller orders its own input, so Chat does not hold the second
    // follow-up back: it is in the transcript while the first is still pending.
    const userRows = [...rendered.container.querySelectorAll('[data-message-role="user"]')].map(
      (row) => row.textContent ?? '',
    );
    expect(userRows.some((text) => text.includes('second'))).toBe(true);
    expect(handedOver).toBe(1);

    releaseFirst();
    await settle();
    await settle();
    expect(handedOver).toBe(2);
    release();
    await run;
  });

  test('marks a rejected follow-up failed with a retry that resends it', async () => {
    const { controller, rendered, release, adaptersErrors } = createWiredChat(async (attempt) => {
      if (attempt === 1) throw new Error('refused');
    });
    const run = controller.adapter.sendMessage({ role: 'user', content: 'start' }, []);
    await settle();

    await submit(rendered.container, 'try this');
    await settle();

    expect(adaptersErrors).toHaveLength(1);
    expect(rendered.container.querySelector('[data-failed]')?.textContent).toContain('try this');
    const retry = rendered.container.querySelector<HTMLButtonElement>('.chat-message-retry')!;
    expect(retry).not.toBeNull();
    // The run keeps streaming: Stop is still offered and the composer is still live.
    expect(rendered.container.querySelector('button[aria-label="Stop generating"]')).not.toBeNull();
    expect(composerOf(rendered.container).disabled).toBe(false);

    await fireEvent.click(retry);
    await settle();

    expect(rendered.container.querySelector('[data-failed]')).toBeNull();
    expect(rendered.container.querySelector('[data-pending]')).toBeNull();
    release();
    await run;
  });
});
