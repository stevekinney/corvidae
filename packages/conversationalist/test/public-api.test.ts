import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  appendMessages,
  Conversation,
  createConversationHistory,
  createPIIRedaction,
  createProjection,
  DEFAULT_PII_RULES,
  isConversationHistory,
  type PIIRedactionOptions,
  type PIIRedactionRule,
  type ProjectionApplyOptions,
  redactMessageAtPosition,
  redactPii,
  type StatefulProjectionOptions,
  type StatelessProjectionOptions,
  withEnvironment,
} from '../src/index';

describe('root public API', () => {
  it('redacts a message with a schema-valid empty identifier', () => {
    const history = appendMessages(createConversationHistory(), {
      id: '',
      role: 'user',
      content: 'secret',
      position: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      metadata: {},
      hidden: false,
    });
    const result = redactMessageAtPosition(history, 0);
    expect(result.ids).toEqual(['']);
    expect(result.messages['']?.content).toBe('[REDACTED]');
  });
  it('exposes the conversation and history contracts from the package root', () => {
    const history = createConversationHistory();
    const conversation = new Conversation(history);

    expect(conversation).toBeInstanceOf(Conversation);
    expect(isConversationHistory(history)).toBe(true);
  });

  it('binds an environment through the package root', () => {
    const timestamp = '2026-09-16T00:00:00.000Z';
    const createHistory = withEnvironment({ now: () => timestamp }, createConversationHistory);

    expect(createHistory({ id: 'root-bound' }).createdAt).toBe(timestamp);
  });

  it('exposes configurable and default PII redaction through the root', () => {
    const rule: PIIRedactionRule = { regex: /private/gu, replace: '[CUSTOM]' };
    const options: PIIRedactionOptions = { rules: { custom: rule } };
    const redact = createPIIRedaction(options);

    expect(redact('private user@example.com')).toBe('[CUSTOM] [EMAIL_REDACTED]');
    expect(DEFAULT_PII_RULES.email.replace).toBe('[EMAIL_REDACTED]');
    expect(redactPii({ role: 'user', content: 'user@example.com' }).content).toBe(
      '[EMAIL_REDACTED]',
    );
  });

  it('accepts both public projection option shapes and apply options from the root', () => {
    const statelessOptions: StatelessProjectionOptions<string> = {
      identify: (event) => event,
      reduce: ({ conversation }) => conversation,
    };
    const statefulOptions: StatefulProjectionOptions<string, number> = {
      ...statelessOptions,
      initialState: 0,
      reduce: ({ conversation, state }) => ({ conversation, state: state + 1 }),
    };
    const applyOptions: ProjectionApplyOptions = { logKey: 'root-api' };
    const stateless = createProjection(statelessOptions);
    const stateful = createProjection(statefulOptions);

    stateless.apply(['first'], applyOptions);
    stateful.apply(['first', 'second'], applyOptions);

    expect(stateless.processedCount).toBe(1);
    expect(stateful.processedCount).toBe(2);
  });

  it.each(['openai', 'anthropic', 'gemini'] as const)(
    'exports to a dynamically selected %s provider',
    async (provider) => {
      const conversation = new Conversation(createConversationHistory());
      conversation.appendUserMessage('root provider payload');

      const payload = await conversation.toProvider(provider);

      expect(JSON.stringify(payload)).toContain('root provider payload');
    },
  );

  it('keeps provider adapters lazy for the browser-safe root entry point', () => {
    const source = readFileSync(resolve(import.meta.dir, '../src/history-providers.ts'), 'utf8');

    expect(source).toContain("import('./adapters/openai')");
    expect(source).toContain("import('./adapters/anthropic')");
    expect(source).toContain("import('./adapters/gemini')");
  });

  it('keeps the Anthropic SDK conversion behind its provider-specific entry point', async () => {
    const root = await import('../src/index');
    const sdk = await import('../src/adapters/anthropic/sdk');

    expect('toAnthropicMessagesForSdk' in root).toBe(false);
    expect(sdk.toAnthropicMessagesForSdk).toBeFunction();
  });

  it('rejects a payload whose shape does not match the selected provider', async () => {
    const payload = { contents: [] };

    const error = await Conversation.fromProvider('openai', payload).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('expected provider validation to reject');
    expect(error.message).toContain('OpenAI provider requires an array payload');
  });

  it('does not append a provider result after a concurrent revision', async () => {
    let contentReads = 0;
    const payload = [
      {
        role: 'user' as const,
        get content(): string {
          contentReads += 1;
          return 'stale provider result';
        },
      },
    ];
    const conversation = new Conversation(createConversationHistory());
    const append = conversation.appendProvider('openai', payload);
    conversation.appendUserMessage('current revision');

    const error = await append.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('expected revision conflict');
    expect(error.message).toContain('expected revision 0, received 1');
    expect(conversation.getMessages().map((message) => message.content)).toEqual([
      'current revision',
    ]);
    expect(contentReads).toBe(0);
  });
});

it('dispatches symbol disposal through the replaceable public dispose action', async () => {
  const conversation = new Conversation(createConversationHistory());
  let disposeCalls = 0;
  const dispose = async (): Promise<void> => {
    disposeCalls += 1;
  };
  Reflect.set(conversation, 'dispose', dispose);

  await conversation[Symbol.asyncDispose]();
  conversation[Symbol.dispose]();

  expect(disposeCalls).toBe(2);
});

it('dispatches ids through the replaceable getMessageIds action', () => {
  const conversation = new Conversation(createConversationHistory());
  const ids = ['replacement-id'];
  Reflect.set(conversation, 'getMessageIds', () => ids);

  expect(conversation.ids).toBe(ids);
});
