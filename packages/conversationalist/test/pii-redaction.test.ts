import { describe, expect, it } from 'bun:test';
import { createPIIRedactionPlugin } from '../src/index';
import type { MultiModalContent } from '../src/multi-modal';
import type { JSONValue, MessageInput } from '../src/types';

function requireRecord(value: JSONValue | undefined): Record<string, JSONValue> {
  if (!isJSONRecord(value)) {
    throw new Error('Expected a JSON object');
  }
  return value;
}

function isJSONRecord(value: JSONValue | undefined): value is Record<string, JSONValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireParts(content: MessageInput['content']) {
  if (typeof content === 'string') throw new Error('Expected multimodal content');
  return content;
}

describe('PII redaction in tool arguments, results, and metadata', () => {
  it('retains prototype-named data properties while redacting their contents', () => {
    const metadata = { ['__proto__']: { contact: 'user@example.com' } };
    const result = createPIIRedactionPlugin()({ role: 'user', content: '', metadata });
    expect(result.metadata).toEqual({ ['__proto__']: { contact: '[EMAIL_REDACTED]' } });
    expect(JSON.stringify(result.metadata)).toBe('{"__proto__":{"contact":"[EMAIL_REDACTED]"}}');
    expect(Object.getPrototypeOf(result.metadata)).toBe(Object.prototype);
    expect(metadata['__proto__'].contact).toBe('user@example.com');
  });

  it('redacts PII in toolCall.arguments', () => {
    const plugin = createPIIRedactionPlugin();
    const input: MessageInput = {
      role: 'tool-call',
      content: '',
      toolCall: {
        id: 'tc-1',
        name: 'sendEmail',
        arguments: { to: 'user@example.com', subject: 'Hello' },
      },
    };

    const result = plugin(input);
    const args = requireRecord(result.toolCall?.arguments);
    expect(args['to']).toBe('[EMAIL_REDACTED]');
    expect(args['subject']).toBe('Hello');
  });

  it('redacts PII in toolResult.content', () => {
    const plugin = createPIIRedactionPlugin();
    const input: MessageInput = {
      role: 'tool-result',
      content: 'Result',
      toolResult: {
        callId: 'tc-1',
        outcome: 'success',
        content: 'Contact user@example.com or call 555-123-4567',
      },
    };

    const result = plugin(input);
    const content = result.toolResult?.content;
    if (typeof content !== 'string') throw new Error('Expected text result');
    expect(content).toContain('[EMAIL_REDACTED]');
    expect(content).toContain('[PHONE_REDACTED]');
  });

  it('redacts PII in nested arrays within tool result content', () => {
    const plugin = createPIIRedactionPlugin();
    const input: MessageInput = {
      role: 'tool-result',
      content: 'Result',
      toolResult: {
        callId: 'tc-1',
        outcome: 'success',
        content: { contacts: ['alice@example.com', 'bob@example.com'] },
      },
    };

    const result = plugin(input);
    const content = requireRecord(result.toolResult?.content);
    const contacts = content['contacts'];
    if (!Array.isArray(contacts)) throw new Error('Expected contacts array');
    expect(contacts[0]).toBe('[EMAIL_REDACTED]');
    expect(contacts[1]).toBe('[EMAIL_REDACTED]');
  });

  it('redacts PII in metadata values', () => {
    const plugin = createPIIRedactionPlugin();
    const input: MessageInput = {
      role: 'user',
      content: 'Hello',
      metadata: {
        email: 'secret@example.com',
        nested: { phone: '555-123-4567' },
      },
    };

    const result = plugin(input);
    expect(result.metadata!['email']).toBe('[EMAIL_REDACTED]');
    expect(requireRecord(result.metadata?.['nested'])['phone']).toBe('[PHONE_REDACTED]');
  });

  it('redacts PII inside structural tool-result content blocks (web_search / web_fetch / code-execution)', () => {
    const plugin = createPIIRedactionPlugin();
    const input: MessageInput = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Here you go.' },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'stu-1',
          content: [{ snippet: 'reach me at user@example.com' }],
        },
        {
          type: 'web_fetch_tool_result',
          tool_use_id: 'wf-1',
          content: { text: 'page says email admin@example.com' },
        },
        {
          type: 'bash_code_execution_tool_result',
          tool_use_id: 'stu-2',
          content: { stdout: 'token printed: call 555-123-4567' },
        },
      ],
    };

    const result = plugin(input);
    const parts = requireParts(result.content).filter((part) => 'tool_use_id' in part);
    const search = parts.find((p) => p.type === 'web_search_tool_result');
    const fetch = parts.find((p) => p.type === 'web_fetch_tool_result');
    const code = parts.find((p) => p.type === 'bash_code_execution_tool_result');
    expect(JSON.stringify(search?.content)).toContain('[EMAIL_REDACTED]');
    expect(JSON.stringify(fetch?.content)).toContain('[EMAIL_REDACTED]');
    expect(JSON.stringify(code?.content)).toContain('[PHONE_REDACTED]');
  });

  it('leaves thinking text and signature intact (redaction must not desync the signature)', () => {
    const plugin = createPIIRedactionPlugin();
    const input: MessageInput = {
      role: 'assistant',
      content: [
        // The user email here is internal reasoning; rewriting it would break
        // the byte-for-byte signature pairing required for replay.
        { type: 'thinking', thinking: 'the user is user@example.com', signature: 'sig==' },
      ],
    };
    const result = plugin(input);
    const part = requireParts(result.content)[0];
    if (part?.type !== 'thinking') throw new Error('Expected thinking part');
    expect(part?.thinking).toBe('the user is user@example.com');
    expect(part?.signature).toBe('sig==');
  });

  it('redacts PII in server_tool_use input', () => {
    const plugin = createPIIRedactionPlugin();
    const input: MessageInput = {
      role: 'assistant',
      content: [
        {
          type: 'server_tool_use',
          id: 'stu-1',
          name: 'web_search',
          input: { query: 'who is user@example.com' },
        },
      ],
    };
    const result = plugin(input);
    const part = requireParts(result.content)[0];
    if (part?.type !== 'server_tool_use') throw new Error('Expected server tool part');
    expect(JSON.stringify(part?.input)).toContain('[EMAIL_REDACTED]');
  });

  it('redacts PII inside text-block citation metadata', () => {
    const plugin = createPIIRedactionPlugin();
    const input: MessageInput = {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'See source.',
          citations: [{ cited_text: 'contact user@example.com', url: 'https://example.com' }],
        },
      ],
    };
    const result = plugin(input);
    const part = requireParts(result.content)[0];
    if (part?.type !== 'text') throw new Error('Expected cited text');
    expect(JSON.stringify(part?.citations)).toContain('[EMAIL_REDACTED]');
  });
});

describe('PII redaction in media parts', () => {
  it('redacts the portable text a media part carries and leaves its source untouched', () => {
    const plugin = createPIIRedactionPlugin();
    const source = { kind: 'managed-asset' as const, assetId: 'asset-1', revision: 2 };
    const result = plugin({
      role: 'user',
      content: [
        {
          type: 'image',
          source,
          mimeType: 'image/png',
          name: 'scan of user@example.com',
          alt: 'photo from user@example.com',
          caption: 'call 555-123-4567',
          transcript: 'contact user@example.com',
          extractedText: 'email: user@example.com',
          metadata: { owner: 'user@example.com', list: ['user@example.com', 3] },
        },
      ],
    });
    expect(requireParts(result.content)).toEqual([
      {
        type: 'image',
        source,
        mimeType: 'image/png',
        name: 'scan of [EMAIL_REDACTED]',
        alt: 'photo from [EMAIL_REDACTED]',
        caption: 'call [PHONE_REDACTED]',
        transcript: 'contact [EMAIL_REDACTED]',
        extractedText: 'email: [EMAIL_REDACTED]',
        metadata: { owner: '[EMAIL_REDACTED]', list: ['[EMAIL_REDACTED]', 3] },
      },
    ]);
  });

  it('does not add fields a media part did not have', () => {
    const plugin = createPIIRedactionPlugin();
    const part = {
      type: 'document' as const,
      source: { kind: 'remote-url' as const, url: 'https://example.com/a.pdf' },
    };
    const result = plugin({ role: 'user', content: [part] });
    expect(requireParts(result.content)).toEqual([part]);
    expect(Object.keys(requireParts(result.content)[0]!)).toEqual(['type', 'source']);
  });

  describe('the text a provider reads from a part’s own bytes (COR-716)', () => {
    const plugin = createPIIRedactionPlugin();
    const redactPart = (part: MultiModalContent) =>
      requireParts(plugin({ role: 'user', content: [part] }).content)[0]!;

    it('redacts an email inside inline UTF-8 text, keeping the encoding', () => {
      expect(
        redactPart({
          type: 'document',
          mimeType: 'text/plain',
          source: { kind: 'inline', data: 'contact me at jane.doe@example.com', encoding: 'utf8' },
        }),
      ).toEqual({
        type: 'document',
        mimeType: 'text/plain',
        source: { kind: 'inline', data: 'contact me at [EMAIL_REDACTED]', encoding: 'utf8' },
      });
    });

    it('redacts inline base64 under a text media type and re-encodes it', () => {
      const redacted = redactPart({
        type: 'document',
        mimeType: 'text/markdown; charset=utf-8',
        source: { kind: 'inline', data: btoa('mail jane.doe@example.com'), encoding: 'base64' },
      });
      expect(redacted).toMatchObject({
        source: { kind: 'inline', data: btoa('mail [EMAIL_REDACTED]'), encoding: 'base64' },
      });
    });

    it('redacts an email inside a textual data URL, keeping its header and encoding', () => {
      const base64 = redactPart({
        type: 'document',
        source: {
          kind: 'data-url',
          url: `data:text/plain;base64,${btoa('write jane.doe@example.com')}`,
        },
      });
      expect(base64).toMatchObject({
        source: {
          kind: 'data-url',
          url: `data:text/plain;base64,${btoa('write [EMAIL_REDACTED]')}`,
        },
      });

      const percent = redactPart({
        type: 'document',
        source: { kind: 'data-url', url: 'data:text/plain,write%20jane.doe%40example.com' },
      });
      expect(percent).toMatchObject({
        source: {
          kind: 'data-url',
          url: `data:text/plain,${encodeURIComponent('write [EMAIL_REDACTED]')}`,
        },
      });
    });

    it('leaves binary bytes alone, even when they happen to contain an address', () => {
      const part: MultiModalContent = {
        type: 'image',
        mimeType: 'image/png',
        source: { kind: 'inline', data: btoa('jane.doe@example.com'), encoding: 'base64' },
      };
      expect(redactPart(part)).toEqual(part);
    });

    it('refuses a text body that is not UTF-8 instead of passing it through unredacted', () => {
      expect(() =>
        plugin({
          role: 'user',
          content: [
            {
              type: 'document',
              mimeType: 'text/plain',
              source: { kind: 'inline', data: btoa('\xff\xfe'), encoding: 'base64' },
            },
          ],
        }),
      ).toThrow(/UTF-8/);
    });
  });
});
