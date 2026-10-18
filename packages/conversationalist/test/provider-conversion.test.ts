import { describe, expect, it } from 'bun:test';

import { toAnthropicMessages } from '../src/adapters/anthropic/outbound';
import { toGeminiMessages } from '../src/adapters/gemini/outbound';
import { resolvedSourceKey, type ResolvedMediaSources } from '../src/adapters/media';
import { toOpenAIMessages } from '../src/adapters/openai/outbound';
import { appendMessages, createConversationHistory } from '../src/conversation';
import { UnsupportedContentError, type UnsupportedContentReason } from '../src/errors';
import type {
  ContentPartLineage,
  ContentSource,
  MediaContent,
  MultiModalContent,
} from '../src/multi-modal';
import type { ConversationHistory, MessageRole } from '../src/types';

/**
 * COR-716: the cross-provider modality, source, role, and rejection matrix.
 * Every row ends in the no-silent-loss property: an adapter either carries the
 * caller's payload through to the provider request, with one lineage entry per
 * delivered part, or rejects with a typed error before the provider call. It
 * never substitutes marker prose, an empty string, or text alone.
 */
const PAYLOAD = 'JVBERi0xLjQKJcfsj6IKJSVFT0YK';
const REMOTE_URL = 'https://example.com/assets/probe.bin';

type Provider = 'openai' | 'anthropic' | 'gemini';
type MediaType = MediaContent['type'];
type SourceKind = ContentSource['kind'];

const PROVIDERS: readonly Provider[] = ['openai', 'anthropic', 'gemini'];
const MEDIA_TYPES: readonly MediaType[] = ['image', 'audio', 'video', 'document', 'file'];
const SOURCE_KINDS: readonly SourceKind[] = [
  'inline',
  'data-url',
  'remote-url',
  'local-file',
  'upload',
  'provider-file',
  'mcp-resource',
  'a2a-reference',
  'managed-asset',
];

const MIME_TYPE: Record<MediaType, string> = {
  image: 'image/png',
  audio: 'audio/mpeg',
  video: 'video/mp4',
  document: 'application/pdf',
  file: 'application/zip',
};

function sourceFor(provider: Provider, kind: SourceKind, type: MediaType): ContentSource {
  switch (kind) {
    case 'inline':
      return { kind, data: PAYLOAD, encoding: 'base64' };
    case 'data-url':
      return { kind, url: `data:${MIME_TYPE[type]};base64,${PAYLOAD}` };
    case 'remote-url':
      return { kind, url: REMOTE_URL };
    case 'local-file':
      return { kind, path: '/workspace/probe.bin' };
    case 'upload':
      return { kind, uploadId: 'upload-1' };
    case 'provider-file':
      return { kind, provider, providerFileId: PAYLOAD };
    case 'mcp-resource':
      return { kind, serverId: 'server-1', uri: 'resource://probe' };
    case 'a2a-reference':
      return { kind, agentCardUrl: 'https://agent.example/card', taskId: 't', artifactId: 'a' };
    case 'managed-asset':
      return { kind, assetId: 'asset-1', revision: 3 };
  }
}

/** What each provider's wire format accepts in a user message: the spec the adapters answer to. */
const ACCEPTED: Record<Provider, Partial<Record<MediaType, readonly SourceKind[]>>> = {
  openai: {
    image: ['inline', 'data-url', 'remote-url'],
    document: ['inline', 'data-url'],
  },
  anthropic: {
    image: ['inline', 'data-url', 'remote-url', 'provider-file'],
    document: ['inline', 'data-url', 'remote-url', 'provider-file'],
  },
  gemini: {
    image: ['inline', 'data-url', 'remote-url', 'provider-file'],
    audio: ['inline', 'data-url', 'remote-url', 'provider-file'],
    video: ['inline', 'data-url', 'remote-url', 'provider-file'],
    document: ['inline', 'data-url', 'remote-url', 'provider-file'],
  },
};

interface ExportResult {
  readonly serialized: string;
  readonly lineage: readonly ContentPartLineage[];
}

function exportFor(
  provider: Provider,
  conversation: ConversationHistory,
  sources?: ResolvedMediaSources,
): ExportResult {
  const options = sources === undefined ? undefined : { sources };
  const result =
    provider === 'openai'
      ? toOpenAIMessages(conversation, options)
      : provider === 'anthropic'
        ? toAnthropicMessages(conversation, options)
        : toGeminiMessages(conversation, options);
  const { lineage, ...wire } = result;
  return { serialized: JSON.stringify(wire), lineage };
}

function conversationOf(
  role: MessageRole,
  content: readonly MultiModalContent[],
): ConversationHistory {
  return appendMessages(createConversationHistory(), {
    role: role as 'user',
    content: [...content],
  });
}

function mediaPart(provider: Provider, type: MediaType, kind: SourceKind): MediaContent {
  return {
    type,
    source: sourceFor(provider, kind, type),
    mimeType: MIME_TYPE[type],
    name: `probe.${type}`,
  };
}

function attempt(run: () => ExportResult): ExportResult | UnsupportedContentError {
  try {
    return run();
  } catch (error) {
    if (error instanceof UnsupportedContentError) return error;
    throw error;
  }
}

/** The no-silent-loss property for one exported request. */
function expectNoSilentLoss(
  outcome: ExportResult | UnsupportedContentError,
  expected: { delivered: boolean; reason?: UnsupportedContentReason },
): void {
  if (outcome instanceof UnsupportedContentError) {
    expect(expected.delivered).toBe(false);
    if (expected.reason !== undefined) expect(outcome.reason).toBe(expected.reason);
    expect(outcome.name).toBe('UnsupportedContentError');
    return;
  }
  expect(expected.delivered).toBe(true);
  expect(outcome.serialized).not.toContain('omitted');
  expect(outcome.serialized).not.toContain('[Document:');
  expect(outcome.lineage).toHaveLength(1);
}

describe('provider conversion matrix: modality by source by provider (user role)', () => {
  for (const provider of PROVIDERS) {
    for (const type of MEDIA_TYPES) {
      for (const kind of SOURCE_KINDS) {
        const accepted = ACCEPTED[provider][type]?.includes(kind) === true;
        it(`${provider} ${type} from ${kind} is ${accepted ? 'delivered' : 'rejected'}`, () => {
          const conversation = conversationOf('user', [
            { type: 'text', text: 'before' },
            mediaPart(provider, type, kind),
            { type: 'text', text: 'after' },
          ]);
          const outcome = attempt(() => exportFor(provider, conversation));
          expectNoSilentLoss(outcome, { delivered: accepted });
          if (!(outcome instanceof UnsupportedContentError)) {
            const expectedData = kind === 'remote-url' ? REMOTE_URL : PAYLOAD;
            expect(outcome.serialized).toContain(expectedData);
            const [entry] = outcome.lineage;
            expect(entry).toMatchObject({
              partIndex: 1,
              modality: type,
              provider,
              from: kind,
            });
            expect(outcome.serialized.indexOf('before')).toBeLessThan(
              outcome.serialized.indexOf(expectedData),
            );
            expect(outcome.serialized.indexOf(expectedData)).toBeLessThan(
              outcome.serialized.indexOf('after'),
            );
          } else {
            expect(outcome.partIndex).toBe(1);
            expect(outcome.partType).toBe(type);
            expect(outcome.provider).toBe(provider);
          }
        });
      }
    }
  }
});

describe('provider conversion matrix: roles', () => {
  const ROLES: readonly MessageRole[] = ['system', 'developer', 'assistant'];
  for (const provider of PROVIDERS) {
    for (const role of ROLES) {
      it(`${provider} ${role} message with an image part is delivered or rejected`, () => {
        const conversation = conversationOf(role, [
          { type: 'text', text: 'context' },
          mediaPart(provider, 'image', 'inline'),
        ]);
        const outcome = attempt(() => exportFor(provider, conversation));
        // Only Gemini's model turn carries media; every other non-user role is
        // text-only on the wire.
        const delivered = provider === 'gemini' && role === 'assistant';
        expectNoSilentLoss(outcome, {
          delivered,
          ...(delivered ? {} : { reason: 'role-not-accepted' as const }),
        });
        if (outcome instanceof UnsupportedContentError) {
          expect(outcome.partIndex).toBe(1);
        } else {
          expect(outcome.serialized).toContain(PAYLOAD);
        }
      });
    }
  }
});

describe('provider conversion matrix: rejection reasons', () => {
  it('names a missing media type on inline bytes', () => {
    for (const provider of PROVIDERS) {
      const conversation = conversationOf('user', [
        {
          type: 'image',
          source: { kind: 'inline', data: PAYLOAD, encoding: 'base64' },
        },
      ]);
      const outcome = attempt(() => exportFor(provider, conversation));
      expectNoSilentLoss(outcome, { delivered: false, reason: 'mime-type-required' });
    }
  });

  it('names a modality the provider has no input for', () => {
    const conversation = conversationOf('user', [mediaPart('openai', 'video', 'inline')]);
    expectNoSilentLoss(
      attempt(() => exportFor('openai', conversation)),
      { delivered: false, reason: 'modality-not-accepted' },
    );
    expectNoSilentLoss(
      attempt(() => exportFor('anthropic', conversation)),
      { delivered: false, reason: 'modality-not-accepted' },
    );
  });

  it('names a source form the provider cannot take', () => {
    const conversation = conversationOf('user', [mediaPart('openai', 'image', 'managed-asset')]);
    for (const provider of PROVIDERS) {
      expectNoSilentLoss(
        attempt(() => exportFor(provider, conversation)),
        { delivered: false, reason: 'source-form-not-accepted' },
      );
    }
  });

  it('rejects another provider’s file handle', () => {
    const conversation = conversationOf('user', [
      {
        type: 'image',
        source: { kind: 'provider-file', provider: 'someone-else', providerFileId: 'file-1' },
        mimeType: 'image/png',
      },
    ]);
    for (const provider of ['anthropic', 'gemini'] as const) {
      expectNoSilentLoss(
        attempt(() => exportFor(provider, conversation)),
        { delivered: false, reason: 'source-form-not-accepted' },
      );
    }
  });

  it('rejects a container upload block OpenAI and Gemini cannot carry', () => {
    const conversation = conversationOf('user', [{ type: 'container_upload', file_id: 'f-1' }]);
    for (const provider of ['openai', 'gemini'] as const) {
      expectNoSilentLoss(
        attempt(() => exportFor(provider, conversation)),
        { delivered: false, reason: 'part-type-not-accepted' },
      );
    }
  });

  it('is an error with a stable code, not a bare Error', () => {
    const conversation = conversationOf('user', [mediaPart('openai', 'audio', 'inline')]);
    const outcome = attempt(() => exportFor('openai', conversation));
    expect(outcome).toBeInstanceOf(UnsupportedContentError);
    expect((outcome as UnsupportedContentError).code).toBe('error:unsupported-content');
  });
});

describe('provider conversion matrix: lineage and wire shape', () => {
  it('splits a data URL into a provider base64 block and records it', () => {
    const conversation = conversationOf('user', [
      { type: 'image', source: { kind: 'data-url', url: `data:image/png;base64,${PAYLOAD}` } },
    ]);
    const anthropic = toAnthropicMessages(conversation);
    expect(anthropic.messages[0]?.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PAYLOAD } },
    ]);
    expect(anthropic.lineage).toEqual([
      {
        messageId: expect.any(String),
        partIndex: 0,
        modality: 'image',
        provider: 'anthropic',
        from: 'data-url',
        to: 'inline',
        transform: 'data-url-split',
      },
    ]);
    const gemini = toGeminiMessages(conversation);
    expect(gemini.contents[0]?.parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: PAYLOAD } },
    ]);
    expect(gemini.lineage[0]?.transform).toBe('data-url-split');
    const openai = toOpenAIMessages(conversation);
    expect(openai.messages[0]?.content).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PAYLOAD}` } },
    ]);
    expect(openai.lineage[0]?.transform).toBe('passthrough');
  });

  it('names the provider file id a file reference delivered', () => {
    const conversation = conversationOf('user', [
      {
        type: 'document',
        source: { kind: 'provider-file', provider: 'anthropic', providerFileId: 'file_9' },
      },
    ]);
    const { lineage } = toAnthropicMessages(conversation);
    expect(lineage[0]).toMatchObject({
      from: 'provider-file',
      to: 'provider-file',
      transform: 'provider-file-reference',
      providerFileId: 'file_9',
    });
  });

  it('keeps part order across several media parts and records every one', () => {
    const conversation = conversationOf('user', [
      mediaPart('gemini', 'image', 'remote-url'),
      { type: 'text', text: 'between' },
      mediaPart('gemini', 'audio', 'inline'),
      mediaPart('gemini', 'video', 'data-url'),
    ]);
    const { contents, lineage } = toGeminiMessages(conversation);
    expect(contents[0]?.parts.map((part) => Object.keys(part)[0])).toEqual([
      'fileData',
      'text',
      'inlineData',
      'inlineData',
    ]);
    expect(lineage.map((entry) => [entry.partIndex, entry.modality])).toEqual([
      [0, 'image'],
      [2, 'audio'],
      [3, 'video'],
    ]);
  });

  it('delivers a managed asset only through a resolved source and records the original identity', () => {
    const conversation = conversationOf('user', [
      {
        type: 'document',
        source: { kind: 'managed-asset', assetId: 'asset-7', revision: 4 },
        mimeType: 'application/pdf',
        name: 'contract.pdf',
      },
    ]);
    const messageId = conversation.ids[0]!;
    const sources: ResolvedMediaSources = new Map([
      [
        resolvedSourceKey(messageId, 0),
        {
          outcome: 'resolved',
          source: { kind: 'inline', data: PAYLOAD, encoding: 'base64' },
          safety: 'clean',
        },
      ],
    ]);
    const anthropic = toAnthropicMessages(conversation, { sources });
    expect(anthropic.messages[0]?.content).toEqual([
      {
        type: 'document',
        title: 'contract.pdf',
        source: { type: 'base64', media_type: 'application/pdf', data: PAYLOAD },
      },
    ]);
    expect(anthropic.lineage).toEqual([
      {
        messageId,
        partIndex: 0,
        modality: 'document',
        provider: 'anthropic',
        from: 'managed-asset',
        to: 'inline',
        transform: 'resolved',
        assetId: 'asset-7',
        revision: 4,
      },
    ]);
    // The stored message is unchanged: asset identity and revision survive.
    expect(conversation.messages[messageId]?.content).toEqual([
      {
        type: 'document',
        source: { kind: 'managed-asset', assetId: 'asset-7', revision: 4 },
        mimeType: 'application/pdf',
        name: 'contract.pdf',
      },
    ]);
  });

  it('delivers a plain-text document to Anthropic as a text source', () => {
    const conversation = conversationOf('user', [
      {
        type: 'document',
        name: 'notes.md',
        mimeType: 'text/markdown',
        source: { kind: 'inline', data: '# Notes', encoding: 'utf8' },
      },
    ]);
    const { messages } = toAnthropicMessages(conversation);
    expect(messages[0]?.content).toEqual([
      {
        type: 'document',
        title: 'notes.md',
        source: { type: 'text', media_type: 'text/markdown', data: '# Notes' },
      },
    ]);
  });
});
