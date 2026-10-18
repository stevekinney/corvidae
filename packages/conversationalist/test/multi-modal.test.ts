import { describe, expect, it } from 'bun:test';

import { deserializeConversationHistory } from '../src/conversation/serialization';
import { ConversationalistError } from '../src/errors';
import { Conversation } from '../src/history';
import { appendMessages, createConversationHistory, fromMarkdown, toMarkdown } from '../src/index';
import { contentSourceSchema, multiModalContentSchema } from '../src/schemas';
import type { ConversationHistory } from '../src/types';
import { getOrderedMessages } from '../src/utilities/message-store';
import { CURRENT_SCHEMA_VERSION } from '../src/versioning';

import {
  type ContentSource,
  contentSourceDisplayUrl,
  copyContent,
  copyMultiModalContent,
  type DocumentContent,
  type MultiModalContent,
  renderMediaPlaceholder,
} from '../src/multi-modal';

describe('copyMultiModalContent', () => {
  describe('text content', () => {
    it('copies text content with text property', () => {
      const input = { type: 'text' as const, text: 'Hello world' };
      const result = copyMultiModalContent(input);

      expect(result).toEqual({ type: 'text', text: 'Hello world' });
      expect(result).not.toBe(input);
    });

    it('copies text content without text property', () => {
      // Deliberately malformed: exercises defensive handling of a `text` block
      // missing its required `text` field (e.g. from an untrusted provider).
      const input = { type: 'text' };
      const result: unknown = Reflect.apply(copyMultiModalContent, undefined, [input]);

      expect(result).toEqual({ type: 'text' });
    });
  });

  describe('media content', () => {
    it('copies image content with every portable field', () => {
      const input = {
        type: 'image' as const,
        source: { kind: 'remote-url' as const, url: 'https://example.com/image.png' },
        mimeType: 'image/png',
        name: 'image.png',
        alt: 'Alt text',
        caption: 'A caption',
        transcript: 'A transcript',
        extractedText: 'Extracted',
        metadata: { nested: { depth: 1 } },
      };
      const result = copyMultiModalContent(input);

      expect(result).toEqual(input);
      expect(result).not.toBe(input);
      if (result.type !== 'image') throw new Error('Expected copied image');
      expect(result.source).not.toBe(input.source);
      expect(result.metadata).not.toBe(input.metadata);
    });

    it('copies image content with only a source', () => {
      const input = {
        type: 'image' as const,
        source: { kind: 'remote-url' as const, url: 'https://example.com/image.png' },
      };
      const result = copyMultiModalContent(input);

      expect(result).toEqual(input);
      expect(Object.keys(result)).toEqual(['type', 'source']);
    });

    it('copies audio, video, and file content under their own type', () => {
      for (const type of ['audio', 'video', 'file'] as const) {
        const input = {
          type,
          source: { kind: 'managed-asset' as const, assetId: 'asset-1', revision: 3 },
          mimeType: 'application/octet-stream',
        };
        const result = copyMultiModalContent(input);

        expect(result).toEqual(input);
        expect(result).not.toBe(input);
      }
    });
  });

  describe('tool blocks deep-copy JSON payloads', () => {
    it('copies document content without sharing source objects', () => {
      const input: DocumentContent = {
        type: 'document',
        name: 'requirements.pdf',
        mimeType: 'application/pdf',
        source: { kind: 'inline', data: 'cGRm', encoding: 'base64' },
      };
      const result = copyMultiModalContent(input);

      expect(result).toEqual(input);
      expect(result).not.toBe(input);
      if (result.type !== 'document') throw new Error('Expected copied document');
      expect(result.source).not.toBe(input.source);
    });

    it('renders document reference fallbacks without embedding base64 data', () => {
      expect(
        renderMediaPlaceholder({
          type: 'document',
          name: 'requirements.pdf',
          mimeType: 'application/pdf',
          source: { kind: 'inline', data: 'cGRm', encoding: 'base64' },
        }),
      ).toBe('[Document: requirements.pdf (application/pdf); base64 data omitted]');

      expect(
        renderMediaPlaceholder({
          type: 'document',
          name: 'notes.md',
          mimeType: 'text/markdown',
          source: { kind: 'local-file', path: '/workspace/notes.md' },
        }),
      ).toBe('[Document: notes.md (text/markdown) at /workspace/notes.md]');
    });

    it('copies thinking content', () => {
      const input = { type: 'thinking' as const, thinking: 'reasoning', signature: 'sig' };
      const result = copyMultiModalContent(input);

      expect(result).toEqual(input);
      expect(result).not.toBe(input);
    });

    it('copies redacted thinking content', () => {
      const input = { type: 'redacted_thinking' as const, data: 'encrypted' };
      const result = copyMultiModalContent(input);

      expect(result).toEqual(input);
      expect(result).not.toBe(input);
    });

    it('deep-copies server_tool_use input so mutating the copy does not affect the original', () => {
      const input = {
        type: 'server_tool_use' as const,
        id: 'c1',
        name: 't',
        input: { nested: { value: 1 }, list: [1, 2] },
      };
      const result = copyMultiModalContent(input);

      expect(result).toEqual(input);
      // The nested payload must be an independent reference.
      if (result.type !== 'server_tool_use') throw new Error('Expected copied server tool use');
      expect(result.input).not.toBe(input.input);
      result.input = { nested: { value: 999 }, list: [9] };
      expect(input.input).toEqual({ nested: { value: 1 }, list: [1, 2] });
    });

    it('deep-copies a second server_tool_use input', () => {
      const input = {
        type: 'server_tool_use' as const,
        id: 's1',
        name: 'web_search',
        input: { query: 'x', opts: { deep: true } },
      };
      const result = copyMultiModalContent(input);
      if (result.type !== 'server_tool_use') throw new Error('Expected copied server tool use');
      expect(result.input).not.toBe(input.input);
    });

    it('deep-copies web_search_tool_result content', () => {
      const input = {
        type: 'web_search_tool_result' as const,
        tool_use_id: 's1',
        content: [{ url: 'https://example.com', nested: { a: 1 } }],
      };
      const result = copyMultiModalContent(input);
      if (result.type !== 'web_search_tool_result')
        throw new Error('Expected copied search result');
      expect(result.content).not.toBe(input.content);
    });

    it('deep-copies server tool result content variants', () => {
      const variants = [
        'code_execution_tool_result',
        'bash_code_execution_tool_result',
        'text_editor_code_execution_tool_result',
        'web_fetch_tool_result',
      ] as const;

      for (const type of variants) {
        const input = {
          type,
          tool_use_id: `${type}-1`,
          content: { nested: { value: type } },
        };
        const result = copyMultiModalContent(input);
        expect(result).toEqual(input);
        if (!('tool_use_id' in result)) throw new Error('Expected copied server tool result');
        expect(result.content).not.toBe(input.content);
      }
    });

    it('copies container upload content', () => {
      const input = { type: 'container_upload' as const, file_id: 'file-1' };
      const result = copyMultiModalContent(input);

      expect(result).toEqual(input);
      expect(result).not.toBe(input);
    });
  });
});

describe('copyContent', () => {
  it('returns string content unchanged', () => {
    const result = copyContent('Hello world');
    expect(result).toBe('Hello world');
  });

  it('copies array of multi-modal content', () => {
    const input: MultiModalContent[] = [
      { type: 'text', text: 'Hello' },
      {
        type: 'image',
        source: { kind: 'remote-url', url: 'https://example.com/img.png' },
      },
    ];
    const result = copyContent(input);

    expect(result).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'image', source: { kind: 'remote-url', url: 'https://example.com/img.png' } },
    ]);
    expect(result).not.toBe(input);
    if (typeof result === 'string') throw new Error('Expected copied multimodal array');
    expect(result[0]).not.toBe(input[0]);
  });

  it('handles empty array', () => {
    const result = copyContent([]);
    expect(result).toEqual([]);
  });

  it('handles readonly array', () => {
    const input: readonly { type: 'text'; text: string }[] = [{ type: 'text', text: 'Test' }];
    const result = copyContent(input);

    expect(result).toEqual([{ type: 'text', text: 'Test' }]);
  });
});

// ── COR-716: persistence preserves media parts byte-for-byte ────────────────

const ALL_SOURCES: readonly ContentSource[] = [
  { kind: 'inline', data: 'QUJD', encoding: 'base64' },
  { kind: 'inline', data: 'plain text', encoding: 'utf8' },
  { kind: 'data-url', url: 'data:image/png;base64,QUJD' },
  { kind: 'remote-url', url: 'https://example.com/a.png' },
  { kind: 'local-file', path: '/workspace/a.png' },
  { kind: 'upload', uploadId: 'upload-1' },
  { kind: 'provider-file', provider: 'anthropic', providerFileId: 'file_1' },
  { kind: 'mcp-resource', serverId: 'server-1', uri: 'resource://a' },
  {
    kind: 'a2a-reference',
    agentCardUrl: 'https://agent.example/card',
    taskId: 'task-1',
    artifactId: 'artifact-1',
  },
  { kind: 'managed-asset', assetId: 'asset-1', revision: 7 },
  { kind: 'managed-asset', assetId: 'asset-2' },
];

function richUserContent(): MultiModalContent[] {
  return [
    { type: 'text', text: 'first' },
    ...ALL_SOURCES.map((source, index): MultiModalContent => {
      const type = (['image', 'audio', 'video', 'document', 'file'] as const)[index % 5]!;
      return {
        type,
        source,
        mimeType:
          type === 'file'
            ? 'application/octet-stream'
            : `${type === 'document' ? 'application' : type}/${type === 'document' ? 'pdf' : 'x-test'}`,
        name: `part-${index}`,
        alt: `alt ${index}`,
        caption: `caption ${index}`,
        transcript: `transcript ${index}`,
        extractedText: `extracted ${index}`,
        metadata: { index, nested: { list: [index, null, true] } },
      };
    }),
    { type: 'text', text: 'last' },
  ];
}

/** Every message's content serialized in order: key order and values are compared as bytes. */
function contentBytes(conversation: ConversationHistory): string {
  return JSON.stringify(getOrderedMessages(conversation).map((message) => message.content));
}

function richConversation() {
  let conversation = createConversationHistory();
  conversation = appendMessages(
    conversation,
    { role: 'user', content: richUserContent() },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'private reasoning', signature: 'sig==+/' },
        { type: 'redacted_thinking', data: 'ZW5jcnlwdGVk' },
        { type: 'text', text: 'answer' },
      ],
    },
  );
  return conversation;
}

describe('media parts survive every persistence path', () => {
  it('accepts every one of the nine source kinds, and no other', () => {
    for (const source of ALL_SOURCES) {
      expect(contentSourceSchema.safeParse(source).success).toBeTrue();
    }
    expect(contentSourceSchema.safeParse({ kind: 'base64', data: 'QUJD' }).success).toBeFalse();
    expect(
      contentSourceSchema.safeParse({ kind: 'inline', data: '', encoding: 'base64' }).success,
    ).toBeFalse();
    expect(contentSourceSchema.safeParse({ kind: 'remote-url', url: 'nope' }).success).toBeFalse();
    expect(
      contentSourceSchema.safeParse({ kind: 'managed-asset', assetId: 'a', revision: -1 }).success,
    ).toBeFalse();
  });

  it('parses a media part to exactly the value that went in, with no undefined keys', () => {
    for (const part of richUserContent()) {
      const parsed = multiModalContentSchema.parse(part);
      expect(parsed).toEqual(part);
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(part));
    }
    const bare = multiModalContentSchema.parse({
      type: 'file',
      source: { kind: 'managed-asset', assetId: 'asset-3' },
    });
    expect(Object.keys(bare)).toEqual(['type', 'source']);
  });

  it('round-trips serialization byte-for-byte', () => {
    const conversation = richConversation();
    const wire = JSON.parse(JSON.stringify(conversation));
    const restored = deserializeConversationHistory(wire);
    expect(restored).toEqual(conversation);
    expect(contentBytes(restored)).toBe(contentBytes(conversation));
    const [user, assistant] = getOrderedMessages(restored);
    expect(user?.content).toEqual(richUserContent());
    expect(assistant?.content).toEqual([
      { type: 'thinking', thinking: 'private reasoning', signature: 'sig==+/' },
      { type: 'redacted_thinking', data: 'ZW5jcnlwdGVk' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('round-trips snapshot restore, including a fork', () => {
    const live = new Conversation(richConversation());
    const forked = live.fork();
    forked.appendUserMessage('follow-up');

    for (const source of [live, forked]) {
      const restored = Conversation.from(JSON.parse(JSON.stringify(source.snapshot())));
      expect(restored.current).toEqual(source.current);
      expect(contentBytes(restored.current)).toBe(contentBytes(source.current));
      const content = getOrderedMessages(restored.current)[0]?.content;
      expect(content).toEqual(richUserContent());
    }
  });

  it('preserves asset identity and revision exactly, including an absent revision', () => {
    const restored = deserializeConversationHistory(JSON.parse(JSON.stringify(richConversation())));
    const content = getOrderedMessages(restored)[0]?.content;
    if (!Array.isArray(content)) throw new Error('expected parts');
    const assets = content.flatMap((part) =>
      'source' in part && part.source.kind === 'managed-asset' ? [part.source] : [],
    );
    expect(assets).toEqual([
      { kind: 'managed-asset', assetId: 'asset-1', revision: 7 },
      { kind: 'managed-asset', assetId: 'asset-2' },
    ]);
  });

  it('round-trips through markdown frontmatter', () => {
    const conversation = richConversation();
    const restored = fromMarkdown(toMarkdown(conversation, { includeMetadata: true }));
    expect(getOrderedMessages(restored)[0]?.content).toEqual(richUserContent());
  });

  it('copies independently of the original', () => {
    const [user] = getOrderedMessages(richConversation());
    const content = user?.content;
    if (!Array.isArray(content)) throw new Error('expected parts');
    const copied = copyContent(content);
    expect(copied).toEqual(content);
    if (typeof copied === 'string') throw new Error('expected parts');
    copied.forEach((part, index) => expect(part).not.toBe(content[index]));
  });
});

describe('stored data from another schema version is refused, not read', () => {
  it('refuses a frame, a markdown frontmatter, and a snapshot', () => {
    const conversation = richConversation();
    const stale = {
      ...JSON.parse(JSON.stringify(conversation)),
      schemaVersion: CURRENT_SCHEMA_VERSION - 1,
    };
    expect(() => deserializeConversationHistory(stale)).toThrow(/unsupported schema version/);

    const markdown = toMarkdown(conversation, { includeMetadata: true }).replace(
      `schemaVersion: ${CURRENT_SCHEMA_VERSION}`,
      `schemaVersion: ${CURRENT_SCHEMA_VERSION - 1}`,
    );
    expect(markdown).toContain(`schemaVersion: ${CURRENT_SCHEMA_VERSION - 1}`);
    let thrown: unknown;
    try {
      fromMarkdown(markdown);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConversationalistError);
    expect((thrown as ConversationalistError).code).toBe('error:unsupported-schema-version');

    const snapshot = JSON.parse(JSON.stringify(new Conversation(conversation).snapshot()));
    snapshot.conversationSchemaVersion = CURRENT_SCHEMA_VERSION - 1;
    expect(() => Conversation.from(snapshot)).toThrow(ConversationalistError);
  });
});

describe('display helpers', () => {
  it('shows a URL only for the two kinds that are URLs', () => {
    expect(
      ALL_SOURCES.map((source) => [source.kind, contentSourceDisplayUrl(source)]).filter(
        ([, url]) => url !== undefined,
      ),
    ).toEqual([
      ['data-url', 'data:image/png;base64,QUJD'],
      ['remote-url', 'https://example.com/a.png'],
    ]);
  });

  it('renders a placeholder for every source kind without embedding bytes', () => {
    for (const source of ALL_SOURCES) {
      const placeholder = renderMediaPlaceholder({ type: 'file', source, name: 'x.bin' });
      expect(placeholder.startsWith('[File: x.bin')).toBeTrue();
      expect(placeholder).not.toContain('QUJD');
    }
  });
});
