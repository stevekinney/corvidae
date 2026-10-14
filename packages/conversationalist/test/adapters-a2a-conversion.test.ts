import { describe, expect, it } from 'bun:test';

import {
  A2AMappingError,
  fromA2AArtifact,
  fromA2AArtifactReference,
  fromA2AMessage,
  fromA2APart,
  referenceA2AArtifact,
  resolveA2AArtifactReference,
  toA2AArtifact,
  toA2AArtifactReference,
  toA2AMessage,
  toA2APart,
} from '../src/adapters/a2a';
import type { A2AArtifact, A2AMessage, A2APart } from '../src/adapters/a2a/proto-types';
import { appendMessages } from '../src/conversation/append';
import { createConversationHistory } from '../src/conversation/create';
import type { ContentSource, MultiModalContent } from '../src/multi-modal';
import type { Message, MessageInput } from '../src/types';
import { getOrderedMessages } from '../src/utilities/message-store';

function roundTripPart(part: A2APart): A2APart {
  return toA2APart(fromA2APart(part));
}

function roundTripContent(content: MultiModalContent): MultiModalContent {
  return fromA2APart(toA2APart(content));
}

function captureMappingError(run: () => unknown): A2AMappingError {
  try {
    run();
  } catch (error) {
    if (error instanceof A2AMappingError) return error;
    throw error;
  }
  throw new Error('Expected an A2AMappingError to be thrown.');
}

function createMessage(overrides: Partial<Message> & Pick<Message, 'role' | 'content'>): Message {
  return {
    id: 'message-1',
    position: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    hidden: false,
    ...overrides,
  };
}

describe('A2A text parts', () => {
  it('round-trips a text part through Conversationalist text content', () => {
    const part: A2APart = { text: 'Summarize the quarterly report.' };

    expect(fromA2APart(part)).toEqual({ type: 'text', text: 'Summarize the quarterly report.' });
    expect(roundTripPart(part)).toEqual(part);
  });

  it('round-trips text content and its citations through part metadata', () => {
    const content: MultiModalContent = {
      type: 'text',
      text: 'Cited answer',
      citations: [{ url: 'https://example.com/source', title: 'Source' }],
    };

    expect(toA2APart(content)).toEqual({
      text: 'Cited answer',
      metadata: { citations: [{ url: 'https://example.com/source', title: 'Source' }] },
    });
    expect(roundTripContent(content)).toEqual(content);
  });
});

describe('A2A file parts', () => {
  it('round-trips an inline raw file part through base64 document content', () => {
    const part: A2APart = {
      raw: 'JVBERi0xLjQK',
      filename: 'report.pdf',
      mediaType: 'application/pdf',
    };

    expect(fromA2APart(part)).toEqual({
      type: 'document',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      source: { kind: 'base64', data: 'JVBERi0xLjQK' },
    });
    expect(roundTripPart(part)).toEqual(part);
  });

  it('round-trips a URI file part through reference document content', () => {
    const part: A2APart = {
      url: 'https://example.com/files/report.pdf',
      filename: 'report.pdf',
      mediaType: 'application/pdf',
    };

    expect(fromA2APart(part)).toEqual({
      type: 'document',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      source: { kind: 'reference', uri: 'https://example.com/files/report.pdf' },
    });
    expect(roundTripPart(part)).toEqual(part);
  });

  it('treats an absent filename as the proto3 empty-string default in both directions', () => {
    const part: A2APart = { raw: 'AAEC', mediaType: 'application/octet-stream' };

    expect(fromA2APart(part)).toEqual({
      type: 'document',
      name: '',
      mimeType: 'application/octet-stream',
      source: { kind: 'base64', data: 'AAEC' },
    });
    expect(roundTripPart(part)).toEqual(part);
  });

  it('round-trips an inline image part through a data URL image content', () => {
    const part: A2APart = { raw: 'iVBORw0KGgo=', mediaType: 'image/png' };

    expect(fromA2APart(part)).toEqual({
      type: 'image',
      url: 'data:image/png;base64,iVBORw0KGgo=',
      mimeType: 'image/png',
    });
    expect(roundTripPart(part)).toEqual(part);
  });

  it('round-trips a URI image part through image content', () => {
    const part: A2APart = { url: 'https://example.com/chart.png', mediaType: 'image/png' };

    expect(fromA2APart(part)).toEqual({
      type: 'image',
      url: 'https://example.com/chart.png',
      mimeType: 'image/png',
    });
    expect(roundTripPart(part)).toEqual(part);
  });

  it('round-trips image alternative text through part metadata', () => {
    const content: MultiModalContent = {
      type: 'image',
      url: 'https://example.com/chart.png',
      mimeType: 'image/png',
      text: 'Revenue by quarter',
    };

    expect(toA2APart(content)).toEqual({
      url: 'https://example.com/chart.png',
      mediaType: 'image/png',
      metadata: { text: 'Revenue by quarter' },
    });
    expect(roundTripContent(content)).toEqual(content);
  });

  it('keeps a named image file as document content so its filename survives', () => {
    const part: A2APart = {
      url: 'https://example.com/chart.png',
      filename: 'chart.png',
      mediaType: 'image/png',
    };

    expect(fromA2APart(part)).toEqual({
      type: 'document',
      name: 'chart.png',
      mimeType: 'image/png',
      source: { kind: 'reference', uri: 'https://example.com/chart.png' },
    });
    expect(roundTripPart(part)).toEqual(part);
  });
});

describe('A2A data parts', () => {
  it('round-trips a data part through an application/json document', () => {
    const part: A2APart = {
      data: { invoice: 'INV-7', total: 42.5, lines: [{ sku: 'ü-1', quantity: 2 }], paid: false },
    };

    const content = fromA2APart(part);
    expect(content).toMatchObject({ type: 'document', name: '', mimeType: 'application/json' });
    expect(roundTripPart(part)).toEqual(part);
  });

  it('round-trips a named data part and a scalar JSON value', () => {
    const named: A2APart = { data: ['a', 1, null], filename: 'values.json' };
    const scalar: A2APart = { data: null };

    expect(roundTripPart(named)).toEqual(named);
    expect(roundTripPart(scalar)).toEqual(scalar);
  });

  it('round-trips a data part whose media type is not JSON', () => {
    const plain: A2APart = { data: { a: 1 }, mediaType: 'text/plain' };
    const charset: A2APart = { data: { a: 1 }, mediaType: 'application/json; charset=utf-8' };

    expect(fromA2APart(plain)).toMatchObject({ type: 'document', mimeType: 'text/plain' });
    expect(roundTripPart(plain)).toEqual(plain);
    expect(roundTripPart(charset)).toEqual(charset);
  });

  it('round-trips a named data part with a vendor JSON media type', () => {
    const part: A2APart = {
      data: { status: 'ok' },
      filename: 'status.json',
      mediaType: 'application/vnd.example+json',
    };

    expect(roundTripPart(part)).toEqual(part);
  });

  it('normalizes a data part declaring application/json to the implied default', () => {
    const explicit: A2APart = { data: { a: 1 }, mediaType: 'application/json' };
    const implicit: A2APart = { data: { a: 1 } };

    expect(fromA2APart(explicit)).toEqual(fromA2APart(implicit));
    expect(roundTripPart(explicit)).toEqual(implicit);
  });

  it('maps an inline file part whose bytes are compact JSON to a data part with the same bytes', () => {
    const raw = btoa(JSON.stringify({ status: 'ok' }));
    const part: A2APart = { raw, mediaType: 'application/json' };

    const exported = roundTripPart(part);
    expect(exported).toEqual({ data: { status: 'ok' } });
    expect(btoa(JSON.stringify((exported as { data: unknown }).data))).toBe(raw);
  });

  it('keeps an application/json file part whose bytes do not parse as an inline file part', () => {
    const part: A2APart = { raw: btoa('{not json'), mediaType: 'application/json' };

    expect(roundTripPart(part)).toEqual(part);
  });

  it('keeps JSON bytes that re-serializing would change as an untouched inline file part', () => {
    const files: ReadonlyArray<A2APart> = [
      {
        raw: btoa('{"id": 12345678901234567890}'),
        filename: 'x.json',
        mediaType: 'application/json',
      },
      { raw: btoa('{"id":12345678901234567890}'), mediaType: 'application/json' },
      { raw: btoa('{\n  "status": "ok"\n}\n'), mediaType: 'application/json' },
      { raw: btoa('{"a":1,"a":2}'), mediaType: 'application/ld+json' },
    ];

    for (const part of files) {
      expect(roundTripPart(part)).toEqual(part);
    }
  });

  it('exports a JSON document whose bytes re-serializing would change as raw bytes', () => {
    const data = btoa('{"id": 12345678901234567890}');
    const content: MultiModalContent = {
      type: 'document',
      name: 'x.json',
      mimeType: 'application/json',
      source: { kind: 'base64', data },
    };

    expect(toA2APart(content)).toEqual({
      raw: data,
      filename: 'x.json',
      mediaType: 'application/json',
    });
    expect(roundTripContent(content)).toEqual(content);
  });
});

describe('A2A part fields Conversationalist content cannot hold', () => {
  it('drops a text part media type and metadata other than citations', () => {
    const part: A2APart = {
      text: '# hi',
      mediaType: 'text/markdown',
      metadata: { foo: 1, citations: [{ title: 'Source' }] },
    };

    expect(fromA2APart(part)).toEqual({
      type: 'text',
      text: '# hi',
      citations: [{ title: 'Source' }],
    });
  });

  it('drops file part metadata other than image alternative text', () => {
    const part: A2APart = {
      url: 'https://example.com/report.pdf',
      filename: 'report.pdf',
      mediaType: 'application/pdf',
      metadata: { foo: 1, text: 'Report' },
    };

    expect(roundTripPart(part)).toEqual({
      url: 'https://example.com/report.pdf',
      filename: 'report.pdf',
      mediaType: 'application/pdf',
    });
  });

  it('brings back an image without a media type as an octet-stream document', () => {
    const content: MultiModalContent = { type: 'image', url: 'https://example.com/a.png' };

    expect(toA2APart(content)).toEqual({ url: 'https://example.com/a.png' });
    expect(roundTripContent(content)).toEqual({
      type: 'document',
      name: '',
      mimeType: 'application/octet-stream',
      source: { kind: 'reference', uri: 'https://example.com/a.png' },
    });
  });

  it('brings back an unnamed image/* document as image content', () => {
    const content: MultiModalContent = {
      type: 'document',
      name: '',
      mimeType: 'image/png',
      source: { kind: 'reference', uri: 'https://example.com/a.png' },
    };

    expect(roundTripContent(content)).toEqual({
      type: 'image',
      url: 'https://example.com/a.png',
      mimeType: 'image/png',
    });
  });
});

describe('unsupported A2A content', () => {
  const unsupported: ReadonlyArray<MultiModalContent> = [
    { type: 'thinking', thinking: 'Considering options.', signature: 'signature-1' },
    { type: 'redacted_thinking', data: 'encrypted' },
    { type: 'server_tool_use', id: 'srvtool-1', name: 'web_search', input: { query: 'a2a' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtool-1', content: [] },
    { type: 'code_execution_tool_result', tool_use_id: 'srvtool-2', content: {} },
    { type: 'bash_code_execution_tool_result', tool_use_id: 'srvtool-3', content: {} },
    { type: 'text_editor_code_execution_tool_result', tool_use_id: 'srvtool-4', content: {} },
    { type: 'web_fetch_tool_result', tool_use_id: 'srvtool-5', content: {} },
    { type: 'container_upload', file_id: 'file-1' },
  ];

  for (const content of unsupported) {
    it(`rejects ${content.type} content with a typed error naming the part kind`, () => {
      const error = captureMappingError(() => toA2APart(content));

      expect(error.kind).toBe(content.type);
      expect(error.code).toBe('error:validation');
      expect(error.message).toContain(content.type);
    });
  }

  it('rejects a message containing thinking content instead of dropping the part', () => {
    const message = createMessage({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Plan first.', signature: 'signature-1' },
        { type: 'text', text: 'Answer' },
      ],
    });

    const error = captureMappingError(() => toA2AMessage(message));
    expect(error.kind).toBe('thinking');
  });

  it('rejects an inbound part that sets no content field', () => {
    const error = captureMappingError(() => fromA2APart({ mediaType: 'text/plain' } as A2APart));

    expect(error.kind).toBe('part');
  });

  it('rejects an inbound part that sets more than one content field', () => {
    const error = captureMappingError(() =>
      fromA2APart({ text: 'hello', url: 'https://example.com' } as unknown as A2APart),
    );

    expect(error.kind).toBe('part');
  });
});

describe('A2A messages', () => {
  it('round-trips a user message with mixed parts and metadata', () => {
    const a2aMessage: A2AMessage = {
      messageId: 'message-7',
      role: 'ROLE_USER',
      parts: [
        { text: 'Review the attached contract.' },
        {
          url: 'https://example.com/contract.pdf',
          filename: 'contract.pdf',
          mediaType: 'application/pdf',
        },
        { data: { priority: 'high' } },
      ],
      metadata: { channel: 'email' },
    };

    const imported = fromA2AMessage(a2aMessage);
    expect(imported.messageId).toBe('message-7');
    expect('id' in imported).toBe(false);
    expect(imported.role).toBe('user');
    expect(imported.metadata).toEqual({ channel: 'email' });

    const message = createMessage({
      id: imported.messageId,
      role: imported.role,
      content: imported.content,
      metadata: imported.metadata ?? {},
    });
    expect(toA2AMessage(message)).toEqual(a2aMessage);
  });

  it('maps an assistant message with string content to a single agent text part', () => {
    const message = createMessage({ id: 'message-2', role: 'assistant', content: 'Done.' });

    expect(toA2AMessage(message)).toEqual({
      messageId: 'message-2',
      role: 'ROLE_AGENT',
      parts: [{ text: 'Done.' }],
    });
    expect(fromA2AMessage(toA2AMessage(message))).toEqual({
      messageId: 'message-2',
      role: 'assistant',
      content: [{ type: 'text', text: 'Done.' }],
    });
  });

  it('rejects message roles that A2A cannot carry with a typed error naming the role', () => {
    for (const role of ['system', 'developer', 'tool-call', 'tool-result', 'snapshot'] as const) {
      const error = captureMappingError(() => toA2AMessage(createMessage({ role, content: 'x' })));
      expect(error.kind).toBe(role);
    }
  });

  it('copies metadata and citations so the mapped message shares no JSON with its source', () => {
    const a2aMessage: A2AMessage = {
      messageId: 'message-4',
      role: 'ROLE_AGENT',
      parts: [{ text: 'Cited', metadata: { citations: [{ title: 'Source' }] } }],
      metadata: { trace: { step: 1 } },
    };

    const imported = fromA2AMessage(a2aMessage);
    const exported = toA2AMessage(
      createMessage({
        role: imported.role,
        content: imported.content,
        metadata: imported.metadata ?? {},
      }),
    );

    expect(imported.metadata?.['trace']).not.toBe(a2aMessage.metadata?.['trace']);
    expect(imported.content[0]).toMatchObject({ citations: [{ title: 'Source' }] });
    expect((imported.content[0] as { citations?: unknown }).citations).not.toBe(
      a2aMessage.parts[0]?.metadata?.['citations'],
    );
    expect(exported.metadata?.['trace']).not.toBe(imported.metadata?.['trace']);
  });

  it('appends an imported message as new input, running plugins and minting a local id', () => {
    const redact = (input: MessageInput): MessageInput => ({
      ...input,
      content:
        typeof input.content === 'string' ? '[redacted]' : [{ type: 'text', text: '[redacted]' }],
    });
    const imported = fromA2AMessage({
      messageId: 'remote-1',
      role: 'ROLE_USER',
      parts: [{ text: 'secret' }],
    });

    const conversation = appendMessages(createConversationHistory(), imported, {
      plugins: [redact],
    });
    const [message] = getOrderedMessages(conversation);

    expect(message?.content).toEqual([{ type: 'text', text: '[redacted]' }]);
    expect(message?.id).not.toBe('remote-1');
    expect(message !== undefined && 'messageId' in message).toBe(false);
  });

  it('rejects a message with no content parts', () => {
    const error = captureMappingError(() =>
      toA2AMessage(createMessage({ role: 'user', content: [] })),
    );

    expect(error.kind).toBe('message');
  });

  it('rejects an inbound message with an unspecified role', () => {
    const error = captureMappingError(() =>
      fromA2AMessage({ messageId: 'message-3', role: 'ROLE_UNSPECIFIED', parts: [{ text: 'x' }] }),
    );

    expect(error.kind).toBe('ROLE_UNSPECIFIED');
  });
});

describe('A2A artifacts', () => {
  it('round-trips an artifact and its parts', () => {
    const artifact: A2AArtifact = {
      artifactId: 'artifact-1',
      name: 'Summary',
      description: 'Quarterly summary',
      parts: [{ text: 'Revenue grew.' }, { data: { growth: 0.12 } }],
      metadata: { generatedBy: 'analyst' },
    };

    const imported = fromA2AArtifact(artifact);
    expect(imported.content).toEqual([
      { type: 'text', text: 'Revenue grew.' },
      expect.objectContaining({ type: 'document', mimeType: 'application/json' }),
    ]);
    expect(toA2AArtifact(imported)).toEqual(artifact);
  });

  it('rejects an artifact with no parts', () => {
    const error = captureMappingError(() =>
      toA2AArtifact({ artifactId: 'artifact-2', content: [] }),
    );

    expect(error.kind).toBe('artifact');
  });
});

describe('a2a-reference content source', () => {
  const source: ContentSource = {
    kind: 'a2a-reference',
    agentCardUrl: 'https://agents.example.com/.well-known/agent-card.json',
    artifactId: 'artifact-9',
  };

  it('round-trips through an A2A artifact reference', () => {
    const reference = toA2AArtifactReference(source);

    expect(reference).toEqual({
      agentCardUrl: 'https://agents.example.com/.well-known/agent-card.json',
      artifactId: 'artifact-9',
    });
    expect(fromA2AArtifactReference(reference)).toEqual(source);
  });

  it('resolves to the referenced artifact and references it back', () => {
    const artifact: A2AArtifact = { artifactId: 'artifact-9', parts: [{ text: 'Result' }] };
    const catalog = {
      agentCardUrl: 'https://agents.example.com/.well-known/agent-card.json',
      artifacts: [{ artifactId: 'artifact-8', parts: [{ text: 'Other' }] }, artifact],
    };

    const resolved = resolveA2AArtifactReference(source, catalog);
    expect(resolved).toBe(artifact);
    const referenced = referenceA2AArtifact(catalog.agentCardUrl, resolved);
    expect(referenced).toEqual(source);
    expect(resolveA2AArtifactReference(referenced, catalog)).toBe(artifact);
  });

  it('rejects resolution against a catalog holding the artifact id more than once', () => {
    const error = captureMappingError(() =>
      resolveA2AArtifactReference(source, {
        agentCardUrl: 'https://agents.example.com/.well-known/agent-card.json',
        artifacts: [
          { artifactId: 'artifact-9', parts: [{ text: 'From task one' }] },
          { artifactId: 'artifact-9', parts: [{ text: 'From task two' }] },
        ],
      }),
    );

    expect(error.code).toBe('error:validation');
    expect(error.kind).toBe('a2a-reference');
  });

  it('rejects resolution against a different agent or a missing artifact', () => {
    const otherAgent = captureMappingError(() =>
      resolveA2AArtifactReference(source, {
        agentCardUrl: 'https://other.example.com/.well-known/agent-card.json',
        artifacts: [{ artifactId: 'artifact-9', parts: [{ text: 'Result' }] }],
      }),
    );
    expect(otherAgent.code).toBe('error:not-found');

    const missing = captureMappingError(() =>
      resolveA2AArtifactReference(source, {
        agentCardUrl: 'https://agents.example.com/.well-known/agent-card.json',
        artifacts: [],
      }),
    );
    expect(missing.code).toBe('error:not-found');
    expect(missing.kind).toBe('a2a-reference');
  });

  it('rejects other content source kinds with a typed error naming the source kind', () => {
    const error = captureMappingError(() =>
      toA2AArtifactReference({ kind: 'remote-url', url: 'https://example.com/a.png' }),
    );

    expect(error.kind).toBe('remote-url');
  });
});
