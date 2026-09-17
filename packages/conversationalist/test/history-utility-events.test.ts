import { describe, expect, it } from 'bun:test';

import { ConversationChangeEvent } from '../src/events';
import { Conversation as ConversationHistory } from '../src/history';
import { createConversationHistory as createConversation } from '../src/index';
import type { ConversationHistory as ConversationState, Message } from '../src/types';

const getOrderedMessages = (conversation: ConversationState): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

describe('Conversation serialization and events', () => {
  it('should support serialization and deserialization of the full history tree', () => {
    const history = new ConversationHistory(createConversation({ title: 'Root' }));
    history.appendUserMessage('V1');
    history.undo();
    history.appendUserMessage('V2');
    history.appendAssistantMessage('V2-A');

    const json = history.snapshot();
    const restored = ConversationHistory.from(json);

    expect(restored.current.title).toBe('Root');
    const restoredMessages = getOrderedMessages(restored.current);
    expect(restoredMessages).toHaveLength(2);
    expect(restoredMessages[0]!.content).toBe('V2');
    expect(restoredMessages[1]!.content).toBe('V2-A');

    restored.undo();
    restored.undo();
    expect(restored.current.ids).toHaveLength(0);

    // Check the other branch
    restored.redo(0);
    const branchMessages = getOrderedMessages(restored.current);
    expect(branchMessages).toHaveLength(1);
    expect(branchMessages[0]!.content).toBe('V1');
  });

  it('should support event listeners and dispatch events on mutations', () => {
    const history = new ConversationHistory(createConversation());
    let changeCount = 0;
    let lastType = '';
    const actionEvents: Array<{ type: string; detailType: string }> = [];

    const changeHandler = (e: any) => {
      changeCount++;
      expect(e.type).toBe('change');
      lastType = e.action;
    };
    const pushHandler = (e: any) => {
      actionEvents.push({ type: e.type, detailType: e.action });
    };
    const undoHandler = (e: any) => {
      actionEvents.push({ type: e.type, detailType: e.action });
    };
    const redoHandler = (e: any) => {
      actionEvents.push({ type: e.type, detailType: e.action });
    };
    const switchHandler = (e: any) => {
      actionEvents.push({ type: e.type, detailType: e.action });
    };
    history.addEventListener('change', changeHandler);
    history.addEventListener('push', pushHandler);
    history.addEventListener('undo', undoHandler);
    history.addEventListener('redo', redoHandler);
    history.addEventListener('switch', switchHandler);

    history.appendUserMessage('test');
    expect(changeCount).toBe(1);
    expect(lastType).toBe('messages.appended');

    history.undo();
    expect(changeCount).toBe(2);
    expect(lastType).toBe('undo');

    history.redo();
    expect(changeCount).toBe(3);
    expect(lastType).toBe('redo');

    history.undo();
    history.appendUserMessage('branch');
    history.switchToBranch(0);
    expect(changeCount).toBe(6); // push, undo, redo, undo, push, switch
    expect(lastType).toBe('switch');

    history.removeEventListener('change', changeHandler);
    history.removeEventListener('push', pushHandler);
    history.removeEventListener('undo', undoHandler);
    history.removeEventListener('redo', redoHandler);
    history.removeEventListener('switch', switchHandler);
    history.appendUserMessage('after unsubscribe');
    expect(changeCount).toBe(6); // no increase

    expect(actionEvents.map((event) => event.type)).toEqual([
      'push',
      'undo',
      'redo',
      'undo',
      'push',
      'switch',
    ]);
    expect(actionEvents.map((event) => event.detailType)).toEqual([
      'push',
      'undo',
      'redo',
      'undo',
      'push',
      'switch',
    ]);
  });

  it('should support AbortSignal in addEventListener', () => {
    const history = new ConversationHistory(createConversation());
    let count = 0;
    const controller = new AbortController();

    history.addEventListener('change', () => count++, { signal: controller.signal });

    history.appendUserMessage('msg');
    expect(count).toBe(1);

    controller.abort();
    history.appendUserMessage('msg 2');
    expect(count).toBe(1);
  });

  it('should support cleanup via Symbol.dispose', () => {
    const history = new ConversationHistory(createConversation());
    history.appendUserMessage('msg');

    // Explicit cleanup
    history[Symbol.dispose]();

    // Node references should be cleared (verified via no crash on repeated dispose)
    expect(() => history[Symbol.dispose]()).not.toThrow();
  });

  it('should support watch for state observation', () => {
    const history = new ConversationHistory(createConversation({ id: 'test' }));
    let current: ConversationState | undefined;
    const unsubscribe = history.watch((v) => {
      current = v;
    });

    expect(current?.id).toBe('test');

    history.appendUserMessage('new message');
    expect(current?.ids.length).toBe(1);

    unsubscribe();
    history.appendUserMessage('another one');
    expect(current?.ids.length).toBe(1);
  });

  it('should support getSnapshot for React useSyncExternalStore', () => {
    const conversation = createConversation();
    const history = new ConversationHistory(conversation);
    expect(history.getSnapshot()).toEqual({
      conversation,
      revision: 0,
      lifecycle: 'open',
    });
    expect(history.getSnapshot()).not.toBe(conversation);
    expect(history.getSnapshot()).toBe(history.getSnapshot());
  });

  it('should expose the environment via env getter', () => {
    const customEnv = { randomId: () => 'custom-id' };
    const history = new ConversationHistory(createConversation(), customEnv);
    expect(history.env.randomId()).toBe('custom-id');
  });

  it('removes event listeners with options', () => {
    const history = new ConversationHistory(createConversation());
    // ConversationChangeEvent imported at top of file
    let calls = 0;
    const handler = () => {
      calls += 1;
    };

    history.addEventListener('change', handler, { capture: true });
    history.removeEventListener('change', handler, { capture: true });

    history.dispatchEvent(
      new ConversationChangeEvent({
        action: 'push',
        conversation: history.current,
        previousConversation: history.current,
        revision: 0,
        sequence: 0,
        correlationId: 'test-correlation-id',
        durability: 'ephemeral',
        outcome: 'accepted',
      }),
    );

    expect(calls).toBe(0);
  });

  it('dispatches events through the internal target', () => {
    const history = new ConversationHistory(createConversation());
    let seen = false;
    history.addEventListener('change', (event: any) => {
      if (event.action === 'push') {
        seen = true;
      }
    });

    // ConversationChangeEvent imported at top of file
    history.dispatchEvent(
      new ConversationChangeEvent({
        action: 'push',
        conversation: history.current,
        previousConversation: history.current,
        revision: 0,
        sequence: 0,
        correlationId: 'test-correlation-id',
        durability: 'ephemeral',
        outcome: 'accepted',
      }),
    );

    expect(seen).toBe(true);
  });

  it('supports boolean listener options overloads', () => {
    const history = new ConversationHistory(createConversation());
    // ConversationChangeEvent imported at top of file
    let calls = 0;
    const handler = () => {
      calls += 1;
    };

    history.addEventListener('change', handler, false);
    history.dispatchEvent(
      new ConversationChangeEvent({
        action: 'push',
        conversation: history.current,
        previousConversation: history.current,
        revision: 0,
        sequence: 0,
        correlationId: 'test-correlation-id',
        durability: 'ephemeral',
        outcome: 'accepted',
      }),
    );
    expect(calls).toBe(1);

    history.removeEventListener('change', handler, false);
    history.dispatchEvent(
      new ConversationChangeEvent({
        action: 'push',
        conversation: history.current,
        previousConversation: history.current,
        revision: 0,
        sequence: 0,
        correlationId: 'test-correlation-id',
        durability: 'ephemeral',
        outcome: 'accepted',
      }),
    );
    expect(calls).toBe(1);
  });

  it('watch returns an unsubscribe function that removes the listener', () => {
    const history = new ConversationHistory(createConversation());
    let calls = 0;
    const unsubscribe = history.watch(() => {
      calls++;
    });

    expect(typeof unsubscribe).toBe('function');
    expect(calls).toBe(1); // initial call

    history.appendUserMessage('msg');
    expect(calls).toBe(2);

    unsubscribe();
    history.appendUserMessage('msg2');
    expect(calls).toBe(2); // no further calls
  });

  it('supports dispatchEvent() for typed event emission', () => {
    const history = new ConversationHistory(createConversation());
    let received = false;
    history.addEventListener('change', () => {
      received = true;
    });

    // ConversationChangeEvent imported at top of file
    history.dispatchEvent(
      new ConversationChangeEvent({
        action: 'push',
        conversation: history.current,
        previousConversation: history.current,
        revision: 0,
        sequence: 0,
        correlationId: 'test-correlation-id',
        durability: 'ephemeral',
        outcome: 'accepted',
      }),
    );

    expect(received).toBe(true);
  });
});
