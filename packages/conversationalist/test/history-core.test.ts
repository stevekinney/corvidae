import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { describe, expect, it } from 'bun:test';

import { estimateConversationTokens } from '../src/context';
import type { TruncateOptions } from '../src/context-truncation';
import { truncateToTokenLimit } from '../src/context-truncation';
import { defineMessagePlugin } from '../src/environment';
import { Conversation as ConversationHistory } from '../src/history';
import { HistoryTransaction } from '../src/history-transaction';
import {
  appendUserMessage,
  createConversationHistory as createConversation,
  getStatistics,
} from '../src/index';
import type {
  ConversationHistory as ConversationState,
  Message,
  TokenEstimator,
} from '../src/types';

const getOrderedMessages = (conversation: ConversationState): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

const customEstimator = () => 100;

describe('Conversation core', () => {
  it('should have event methods without extending EventTarget', () => {
    const history = new ConversationHistory(createConversation());
    expect(typeof history.addEventListener).toBe('function');
    expect(typeof history.removeEventListener).toBe('function');
    expect(typeof history.dispatchEvent).toBe('function');
    expect(typeof history.on).toBe('function');
    expect(typeof history.once).toBe('function');
    expect(typeof history.subscribe).toBe('function');
  });

  it('should initialize with a conversation', () => {
    const conversation = createConversation({ title: 'Test' });
    const history = new ConversationHistory(conversation);
    expect(history.current).toEqual(conversation);
    expect(history.current).not.toBe(conversation);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });

  it('should initialize with an empty conversation by default', () => {
    const history = new ConversationHistory();
    expect(history.current.ids).toHaveLength(0);
    expect(history.current.status).toBe('active');
    expect(history.canUndo).toBe(false);
  });

  it('mints the default conversation through a supplied runtime, not the real globals (AB-321)', () => {
    const runtime = createManualRuntimeServices({ origin: '2030-03-01T00:00:00.000Z' });

    // No `initial` argument at all — the exact shape every operative call
    // site (`new Conversation()`) uses. Before AB-321 the constructor's
    // default parameter minted the initial history with a bare, unseeded
    // environment, so a caller-supplied `environment` was silently ignored
    // for the id and timestamps.
    const history = new ConversationHistory(undefined, { runtime });

    expect(history.current.id).toBe(`${runtime.identifierPrefix}-conversation-1`);
    expect(history.current.createdAt).toBe('2030-03-01T00:00:00.000Z');
  });

  it('produces byte-identical default conversation ids from two independently constructed runtimes with the same seeds (AB-321)', () => {
    const runtimeA = createManualRuntimeServices({
      origin: '2030-03-01T00:00:00.000Z',
      identifierSeed: 'shared-seed',
    });
    const runtimeB = createManualRuntimeServices({
      origin: '2030-03-01T00:00:00.000Z',
      identifierSeed: 'shared-seed',
    });

    const historyA = new ConversationHistory(undefined, { runtime: runtimeA });
    const historyB = new ConversationHistory(undefined, { runtime: runtimeB });

    expect(historyA.current.id).toBe(historyB.current.id);
    expect(historyA.current.createdAt).toBe(historyB.current.createdAt);
  });

  it('should support undo and redo', () => {
    const v1 = createConversation({ title: 'V1' });
    const history = new ConversationHistory(v1);

    const v2 = appendUserMessage(v1, 'Hello');
    history.push(v2);

    expect(history.current).toEqual(v2);
    expect(history.canUndo).toBe(true);

    const undone = history.undo();
    expect(undone).toEqual(v1);
    expect(history.current).toEqual(v1);
    expect(history.canRedo).toBe(true);

    const redone = history.redo();
    expect(redone).toEqual(v2);
    expect(history.current).toEqual(v2);
  });

  it('should support branching and switching between branches', () => {
    const v1 = createConversation({ title: 'V1' });
    const history = new ConversationHistory(v1);

    const v2 = appendUserMessage(v1, 'Message 2');
    history.push(v2);

    history.undo(); // back to v1

    const v3 = appendUserMessage(v1, 'Message 3');
    history.push(v3); // Creates a second branch from v1

    expect(history.current).toEqual(v3);
    expect(history.branchCount).toBe(2);
    expect(history.branchIndex).toBe(1);

    history.switchToBranch(0);
    expect(history.current).toEqual(v2);
    expect(history.branchIndex).toBe(0);

    history.undo();
    expect(history.current).toEqual(v1);
    expect(history.redo(1)).toEqual(v3);
  });

  it('should return path to current state', () => {
    const v1 = createConversation({ title: 'V1' });
    const history = new ConversationHistory(v1);
    const v2 = appendUserMessage(v1, 'V2');
    history.push(v2);
    const v3 = appendUserMessage(v2, 'V3');
    history.push(v3);

    const path = history.getPath();
    expect(path).toEqual([v1, v2, v3]);
  });

  it('should add a new branch instead of truncating history', () => {
    const history = new ConversationHistory(createConversation({ title: 'V1' }));
    const v1 = history.current;
    const v2 = appendUserMessage(v1, 'V2');
    history.push(v2);
    history.undo();

    const v3 = appendUserMessage(v1, 'V3');
    history.push(v3);

    expect(history.current).toEqual(v3);
    expect(history.branchCount).toBe(2);

    history.undo();
    expect(history.canRedo).toBe(true);
    expect(history.redo(0)).toEqual(v2);
  });

  it('should bind functions and automatically push updates', () => {
    const history = new ConversationHistory(createConversation());
    const boundAppend = history.bind(appendUserMessage);

    boundAppend('Hello');
    const afterFirst = getOrderedMessages(history.current);
    expect(afterFirst.length).toBe(1);
    expect(afterFirst[0]!.content).toBe('Hello');

    boundAppend('World');
    expect(history.current.ids.length).toBe(2);
    expect(history.canUndo).toBe(true);

    history.undo();
    expect(history.current.ids.length).toBe(1);
  });

  it('should bind functions that do not return a conversation without pushing', () => {
    const history = new ConversationHistory(createConversation());
    const boundStats = history.bind(getStatistics);

    const stats = boundStats();
    expect(stats.total).toBe(0);
    expect(history.current.ids.length).toBe(0); // Should not have pushed
  });

  it('should not push non-conformant objects to history', () => {
    const original = createConversation({ id: 'original' });
    const history = new ConversationHistory(original);
    const boundIncomplete = history.bind(() => ({
      id: 'incomplete',
      messages: [],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      // missing status, metadata
    }));

    boundIncomplete();
    expect(history.current.id).toBe('original'); // Should NOT have pushed the incomplete object
  });

  it('should not push objects with null metadata to history', () => {
    const original = createConversation({ id: 'original' });
    const history = new ConversationHistory(original);
    const boundWithNullMetadata = history.bind(() => ({
      id: 'null-metadata',
      status: 'active',
      metadata: null,
      messages: [],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    }));

    boundWithNullMetadata();
    expect(history.current.id).toBe('original'); // Should NOT have pushed the object with null metadata
  });

  it('should use custom token estimator from environment when bound', () => {
    const history = new ConversationHistory(createConversation(), {
      estimateTokens: customEstimator,
    });

    // Explicit type arguments select the sync overload of `truncateToTokenLimit`:
    // `bind`'s generic inference from an overloaded function value only considers
    // the last overload signature, which would otherwise require the async options.
    const boundTruncate = history.bind<
      [number, (TruncateOptions | TokenEstimator)?],
      ConversationState
    >(truncateToTokenLimit);

    history.push(appendUserMessage(history.current, 'Hello'));
    history.push(appendUserMessage(history.current, 'World'));

    // 2 messages + initial = 3 * 100 = 300 tokens
    // Truncate to 150 should leave 1 message + initial (if initial is empty/0 tokens, but we said every message is 100)
    // Wait, createConversation creates 0 messages.
    // So 2 messages * 100 = 200 tokens.
    // Truncate to 150 should leave 1 message.

    boundTruncate(150);
    expect(history.current.ids.length).toBe(1);
  });

  it('should use custom token estimator from environment for estimateConversationTokens when bound', () => {
    const history = new ConversationHistory(createConversation(), {
      estimateTokens: customEstimator,
    });

    // Explicit type arguments select the sync overload; see the comment above
    // `boundTruncate` for why inference alone picks the wrong overload here.
    const boundEstimate = history.bind<[TokenEstimator?], number>(estimateConversationTokens);

    history.push(appendUserMessage(history.current, 'Hello'));
    history.push(appendUserMessage(history.current, 'World'));

    expect(boundEstimate()).toBe(200);
  });

  it('should return 0 for redoCount on a leaf node', () => {
    const history = new ConversationHistory(createConversation());
    expect(history.redoCount).toBe(0);
  });

  it('should return undefined when undo is not possible', () => {
    const history = new ConversationHistory(createConversation());
    expect(history.undo()).toBeUndefined();
  });

  it('should return undefined when redo is not possible', () => {
    const history = new ConversationHistory(createConversation());
    expect(history.redo()).toBeUndefined();
  });

  it('should return undefined when switching to non-existent branch', () => {
    const history = new ConversationHistory(createConversation());
    expect(history.switchToBranch(1)).toBeUndefined();
  });

  it('should return 1 for branchCount and 0 for branchIndex on root node', () => {
    const history = new ConversationHistory(createConversation());
    expect(history.branchCount).toBe(1);
    expect(history.branchIndex).toBe(0);
  });

  it('describes the outer mutation in its change event when a plugin listener writes reentrantly', () => {
    const plugin = defineMessagePlugin({ id: 'reentrant', revision: 1 }, (input) => input);
    const conversation = new ConversationHistory(createConversation({ id: 'reentrancy' }), {
      plugins: [plugin],
    });
    const changes: Array<{ ids: number; revision: number; previousIds: number }> = [];
    conversation.addEventListener('change', (event) => {
      changes.push({
        ids: event.conversation.ids.length,
        revision: event.revision,
        previousIds: event.previousConversation.ids.length,
      });
    });
    conversation.addEventListener('plugin.activated', () => {
      conversation.appendAssistantMessage('reentrant write');
    });

    conversation.appendUserMessage('outer write');

    expect(changes).toEqual([
      { ids: 2, revision: 2, previousIds: 1 },
      { ids: 1, revision: 1, previousIds: 0 },
    ]);
  });

  it('keeps the store snapshot referentially stable across non-state events', () => {
    const transaction = new HistoryTransaction(createConversation({ id: 'stable' }));
    const first = transaction.getSnapshot('open');
    transaction.buildEventDetail('plugin.activated', transaction.current, {});
    expect(transaction.getSnapshot('open')).toBe(first);
    transaction.setRestoredState(5, transaction.node);
    const second = transaction.getSnapshot('open');
    expect(second).not.toBe(first);
    expect(transaction.getSnapshot('closed')).not.toBe(second);
  });

  it('returns a callable no-op unsubscribe when subscribing after close', async () => {
    const transaction = new HistoryTransaction(createConversation({ id: 'closed-sub' }));
    const unsubscribe = transaction.subscribe(() => {}, 'closed');
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
    const conversation = new ConversationHistory(createConversation());
    await conversation.dispose();
    expect(() => conversation.subscribe(() => {})()).not.toThrow();
  });
});
