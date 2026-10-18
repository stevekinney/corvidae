import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { mergeSubagentResult, prepareSubagentContext } from './subagent-context';

describe('prepareSubagentContext', () => {
  it('returns a new conversation with parent system messages', () => {
    const parent = new Conversation();
    parent.appendSystemMessage('You are a research assistant.');
    parent.appendUserMessage('Find information about cats.');
    parent.appendAssistantMessage('Searching...');

    const child = prepareSubagentContext(parent, {
      instructions: 'You are a specialist sub-agent.',
    });

    const messages = child.getMessages();
    // Should include the parent system message
    const systemMessages = messages.filter((m) => m.role === 'system');
    expect(systemMessages.length).toBeGreaterThanOrEqual(1);
    expect(
      systemMessages.some((m) =>
        (typeof m.content === 'string' ? m.content : '').includes('research assistant'),
      ),
    ).toBe(true);
  });

  it('injects subagent instructions as a system message', () => {
    const parent = new Conversation();
    parent.appendSystemMessage('Parent system.');
    parent.appendUserMessage('Do task.');

    const child = prepareSubagentContext(parent, {
      instructions: 'Focus on data analysis.',
    });

    const messages = child.getMessages();
    const systemMessages = messages.filter((m) => m.role === 'system');
    expect(
      systemMessages.some((m) =>
        (typeof m.content === 'string' ? m.content : '').includes('data analysis'),
      ),
    ).toBe(true);
  });

  it('includes a summary of recent parent context when provided', () => {
    const parent = new Conversation();
    parent.appendSystemMessage('System.');
    parent.appendUserMessage('Question 1');
    parent.appendAssistantMessage('Answer 1');
    parent.appendUserMessage('Question 2');
    parent.appendAssistantMessage('Answer 2');

    const child = prepareSubagentContext(parent, {
      instructions: 'Sub-agent task.',
      recentParentMessageCount: 2,
    });

    const messages = child.getMessages();
    // Should have parent context included
    const userMessages = messages.filter((m) => m.role === 'user');
    expect(userMessages.length).toBeGreaterThanOrEqual(1);
  });

  it('creates an isolated conversation that does not modify the parent', () => {
    const parent = new Conversation();
    parent.appendSystemMessage('System.');
    parent.appendUserMessage('Hello.');

    const parentMessageCount = parent.getMessages().length;

    const child = prepareSubagentContext(parent, { instructions: 'Sub-agent.' });
    child.appendUserMessage('Child message');

    // Parent should be unchanged
    expect(parent.getMessages().length).toBe(parentMessageCount);
  });

  it('works with empty parent conversation', () => {
    const parent = new Conversation();
    const child = prepareSubagentContext(parent, { instructions: 'Sub-agent.' });

    const messages = child.getMessages();
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.some((m) => m.role === 'system')).toBe(true);
  });
});

describe('mergeSubagentResult', () => {
  it('appends child output as an assistant message in the parent', () => {
    const parent = new Conversation();
    parent.appendSystemMessage('System.');
    parent.appendUserMessage('Do task.');

    const parentMessageCount = parent.getMessages().length;

    mergeSubagentResult(parent, {
      content: 'Task completed successfully.',
      agentName: 'research-agent',
    });

    const messages = parent.getMessages();
    expect(messages.length).toBe(parentMessageCount + 1);
    const lastMessage = messages[messages.length - 1];
    expect(lastMessage?.role).toBe('assistant');
    const lastContent = typeof lastMessage?.content === 'string' ? lastMessage.content : '';
    expect(lastContent).toContain('Task completed');
  });

  it('includes the agent name in metadata', () => {
    const parent = new Conversation();
    parent.appendSystemMessage('System.');
    parent.appendUserMessage('Do task.');

    mergeSubagentResult(parent, {
      content: 'Result.',
      agentName: 'data-agent',
    });

    const messages = parent.getMessages();
    const lastMessage = messages[messages.length - 1];
    expect(lastMessage?.metadata?.['subagentName']).toBe('data-agent');
  });
});

describe('prepareSubagentContext: multimodal parents (COR-716)', () => {
  const document = {
    type: 'document' as const,
    name: 'spec.pdf',
    mimeType: 'application/pdf',
    source: { kind: 'managed-asset' as const, assetId: 'asset-1', revision: 3 },
  };
  const image = {
    type: 'image' as const,
    source: { kind: 'remote-url' as const, url: 'https://example.com/a.png' },
    alt: 'diagram',
  };

  it('carries a recent user message’s text and media parts to the child unchanged and in order', () => {
    const parent = new Conversation();
    parent.appendUserMessage([{ type: 'text', text: 'review this' }, document, image]);

    const child = prepareSubagentContext(parent, { instructions: 'Review.' });

    expect(child.getMessages().map((m) => m.content)).toEqual([
      'Review.',
      [{ type: 'text', text: 'review this' }, document, image],
    ]);
  });

  it('never turns a media-only message into an empty string', () => {
    const parent = new Conversation();
    parent.appendUserMessage([document]);

    const child = prepareSubagentContext(parent, { instructions: 'Review.' });

    expect(child.getMessages().map((m) => m.content)).toEqual(['Review.', [document]]);
  });

  it('skips a message whose only parts are provider-private reasoning, instead of appending an empty one', () => {
    const parent = new Conversation();
    parent.appendAssistantMessage([{ type: 'thinking', thinking: 'private', signature: 'sig' }]);

    const child = prepareSubagentContext(parent, { instructions: 'Review.' });

    expect(child.getMessages().map((m) => m.content)).toEqual(['Review.']);
  });

  it('does not share part objects with the parent', () => {
    const parent = new Conversation();
    parent.appendUserMessage([image]);

    const child = prepareSubagentContext(parent, { instructions: 'Review.' });

    const parentContent = parent.getMessages()[0]?.content;
    const childContent = child.getMessages()[1]?.content;
    if (typeof parentContent === 'string' || typeof childContent === 'string') {
      throw new Error('expected parts');
    }
    expect(childContent?.[0]).not.toBe(parentContent?.[0]);
  });
});
