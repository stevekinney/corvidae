/**
 * The OpenAI rows and the conversationalist OpenAI adapter agree on what the backend accepts:
 * for every modality and source form, the adapter takes the part exactly when the row declares it.
 * Moved here from Operative's multimodal input tests with the rows (COR-2151).
 */
import { describe, expect, it } from 'bun:test';
import type { ContentSource, MediaContent } from 'conversationalist';
import { Conversation, toOpenAIMessages, UnsupportedContentError } from 'conversationalist';

import { openAIRows } from '../src/openai-catalog.ts';

const BYTES = 'QUJDREVGRw=='; // base64 of "ABCDEFG"

describe('the OpenAI rows and the adapter agree on what the backend accepts', () => {
  const SOURCE_KINDS: ContentSource['kind'][] = [
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
  const MIME: Record<MediaContent['type'], string> = {
    image: 'image/png',
    audio: 'audio/mpeg',
    video: 'video/mp4',
    document: 'application/pdf',
    file: 'application/zip',
  };

  function sourceFor(
    provider: 'openai',
    kind: ContentSource['kind'],
    type: MediaContent['type'],
  ): ContentSource {
    switch (kind) {
      case 'inline':
        return { kind, data: BYTES, encoding: 'base64' };
      case 'data-url':
        return { kind, url: `data:${MIME[type]};base64,${BYTES}` };
      case 'remote-url':
        return { kind, url: 'https://example.com/probe.bin' };
      case 'local-file':
        return { kind, path: '/tmp/probe.bin' };
      case 'upload':
        return { kind, uploadId: 'upload-1' };
      case 'provider-file':
        return { kind, provider, providerFileId: 'file-1' };
      case 'mcp-resource':
        return { kind, serverId: 'server', uri: 'resource://probe' };
      case 'a2a-reference':
        return { kind, agentCardUrl: 'https://agent.example', taskId: 't', artifactId: 'a' };
      case 'managed-asset':
        return { kind, assetId: 'asset' };
    }
  }

  function adapterAccepts(part: MediaContent): boolean {
    const history = new Conversation();
    history.appendUserMessage([part]);
    try {
      toOpenAIMessages(history.current);
      return true;
    } catch (error) {
      if (error instanceof UnsupportedContentError) return false;
      throw error;
    }
  }

  const PROVIDER = 'openai';
  for (const descriptor of openAIRows()) {
    for (const type of ['image', 'audio', 'video', 'document', 'file'] as const) {
      it(`${descriptor.model} ${type}: adapter acceptance equals the descriptor's declaration`, () => {
        const entry = descriptor.modalities[type];
        for (const kind of SOURCE_KINDS) {
          const declared = entry.input && entry.sourceForms.includes(kind);
          const part: MediaContent = {
            type,
            source: sourceFor(PROVIDER, kind, type),
            mimeType: MIME[type],
            name: 'probe',
          };
          expect([descriptor.model, type, kind, adapterAccepts(part)]).toEqual([
            descriptor.model,
            type,
            kind,
            declared,
          ]);
        }
      });
    }
  }
});
