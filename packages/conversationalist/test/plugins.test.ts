import { describe, expect, it } from 'bun:test';

import type { ConversationEnvironment } from '../src';
import {
  appendMessages,
  Conversation,
  createConversationHistory as createConversation,
} from '../src';
import { defineMessagePlugin } from '../src/environment';
import { createPIIRedactionPlugin, redactPii } from '../src/plugins/pii-redaction';
import type { MessageInput } from '../src/types';
import { getOrderedMessages } from '../src/utilities/message-store';

const maliciousPlugin = (input: MessageInput): MessageInput => {
  if (input.role === 'tool-result' && input.toolResult) {
    return {
      ...input,
      toolResult: { ...input.toolResult, callId: 'invalid-id' },
    };
  }
  return input;
};

describe('redactPii', () => {
  it('should redact emails', () => {
    const env = { plugins: [redactPii] };
    let conv = createConversation({}, env);
    conv = appendMessages(conv, { role: 'user', content: 'My email is test@example.com' }, env);

    expect(getOrderedMessages(conv)[0]!.content).toBe('My email is [EMAIL_REDACTED]');
  });

  it('should redact phone numbers', () => {
    const env = { plugins: [redactPii] };
    let conv = createConversation({}, env);
    conv = appendMessages(conv, { role: 'user', content: 'Call me at 123-456-7890' }, env);

    expect(getOrderedMessages(conv)[0]!.content).toBe('Call me at [PHONE_REDACTED]');
  });

  it('should redact API keys', () => {
    const env = { plugins: [redactPii] };
    let conv = createConversation({}, env);
    conv = appendMessages(
      conv,
      {
        role: 'user',
        content: 'My key is api_key: "sk-1234567890abcdef1234567890abcdef"',
      },
      env,
    );

    expect(getOrderedMessages(conv)[0]!.content).toBe('My key is api_key: "[KEY_REDACTED]"');
  });

  it('should redact multi-modal content', () => {
    const env = { plugins: [redactPii] };
    let conv = createConversation({}, env);
    conv = appendMessages(
      conv,
      {
        role: 'user',
        content: [
          { type: 'text', text: 'My email is test@example.com' },
          { type: 'image', source: { kind: 'remote-url', url: 'https://example.com/image.png' } },
        ],
      },
      env,
    );

    expect(getOrderedMessages(conv)[0]!.content).toEqual([
      { type: 'text', text: 'My email is [EMAIL_REDACTED]' },
      { type: 'image', source: { kind: 'remote-url', url: 'https://example.com/image.png' } },
    ]);
  });

  it('should not redact by default', () => {
    let conv = createConversation({});
    conv = appendMessages(conv, {
      role: 'user',
      content: 'My email is test@example.com',
    });

    expect(getOrderedMessages(conv)[0]!.content).toBe('My email is test@example.com');
  });

  it('should work when bound to Conversation', () => {
    const env = { plugins: [redactPii] };
    const history = new Conversation(createConversation(), env);
    const boundAppend = history.bind(
      (conversation, input: MessageInput, boundEnv?: Partial<ConversationEnvironment>) =>
        appendMessages(conversation, input, boundEnv),
    );

    boundAppend({ role: 'user', content: 'My email is test@example.com' });

    expect(getOrderedMessages(history.current)[0]!.content).toBe('My email is [EMAIL_REDACTED]');
  });

  it('should support custom redaction rules', () => {
    const customPlugin = createPIIRedactionPlugin({
      rules: {
        ssn: {
          regex: /\d{3}-\d{2}-\d{4}/g,
          replace: '[SSN_REDACTED]',
        },
      },
    });

    const env = { plugins: [customPlugin] };
    let conv = createConversation({}, env);
    conv = appendMessages(conv, { role: 'user', content: 'SSN: 123-45-6789' }, env);

    expect(getOrderedMessages(conv)[0]!.content).toBe('SSN: [SSN_REDACTED]');
  });

  it('should support excluding default rules', () => {
    const customPlugin = createPIIRedactionPlugin({
      excludeRules: ['email'],
    });

    const env = { plugins: [customPlugin] };
    let conv = createConversation({}, env);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Email: test@example.com, Phone: 123-456-7890' },
      env,
    );

    expect(getOrderedMessages(conv)[0]!.content).toBe(
      'Email: test@example.com, Phone: [PHONE_REDACTED]',
    );
  });

  it('should validate tool references after plugins are applied', () => {
    const env = { plugins: [maliciousPlugin] };
    const conv = createConversation({ id: 'test' }, env);

    const action = () =>
      appendMessages(
        conv,
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'valid-id', name: 'test', arguments: {} },
        },
        {
          role: 'tool-result',
          content: '',
          toolResult: { callId: 'valid-id', outcome: 'success', content: {} },
        },
        env,
      );

    // This should fail because the plugin changes the callId to 'invalid-id'
    // If it doesn't fail, it means validation happened before the plugin.
    expect(action).toThrow(/tool result references non-existent tool-call: invalid-id/);
  });
});

describe('plugin activation accounting', () => {
  it('does not strand earlier activations when a later plugin in the pipeline throws', () => {
    const first = defineMessagePlugin({ id: 'first', revision: 1 }, (input) => input);
    let shouldFail = true;
    const conditional = defineMessagePlugin({ id: 'conditional', revision: 1 }, (input) => {
      if (shouldFail) throw new Error('conditional failed');
      return input;
    });
    const conversation = new Conversation(createConversation({ id: 'stranded' }), {
      plugins: [first, conditional],
    });
    const activated: string[] = [];
    conversation.addEventListener('plugin.activated', (event) => {
      activated.push(event.plugin?.id ?? 'none');
    });

    expect(() => conversation.appendUserMessage('fails')).toThrow('conditional failed');
    expect(activated).toEqual(['first', 'conditional']);

    shouldFail = false;
    activated.length = 0;
    conversation.appendUserMessage('succeeds');
    // Both plugins already activated once; nothing stale may be re-announced.
    expect(activated).toEqual([]);
  });
});
