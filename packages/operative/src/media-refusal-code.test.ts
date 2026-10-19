import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import type { MediaContent } from 'conversationalist';
import { Conversation } from 'conversationalist';

import type { MediaCostEstimator, MediaCostOutcome } from './context/types';
import { createActiveRun } from './create-run';
import { agentRunErrorToJSON, MediaAdmissionError } from './errors';
import type { GenerateContext } from './types';

/**
 * COR-1547 — a message whose every media part is refused because the model does not take that kind
 * of media (`modality-not-accepted` or `mime-family-not-accepted`) fails with its own native code,
 * `UNSUPPORTED_MEDIA_TYPE`, so a client can tell that from every other admission refusal. A message
 * with any admitted part, any other refusal reason, or any other mix keeps `MEDIA_NOT_ADMITTED`.
 */
const parts: MediaContent[] = [
  {
    type: 'audio',
    mimeType: 'audio/wav',
    source: { kind: 'inline', data: 'QUJD', encoding: 'base64' },
  },
  {
    type: 'video',
    mimeType: 'video/mp4',
    source: { kind: 'inline', data: 'QUJD', encoding: 'base64' },
  },
];

type Unsupported = Extract<MediaCostOutcome, { outcome: 'unsupported' }>['reason'];
type Verdict = Unsupported | 'unbounded' | 'estimated';

function estimating(verdicts: readonly Verdict[]): MediaCostEstimator {
  return (part, position): MediaCostOutcome => {
    const verdict = verdicts[position.partIndex]!;
    if (verdict === 'unbounded') {
      return { ...position, modality: part.type, outcome: 'unbounded', reason: 'size-unknown' };
    }
    if (verdict === 'estimated') {
      return {
        ...position,
        modality: part.type,
        outcome: 'estimated',
        tokens: 10,
        basis: 'catalog-estimate',
      };
    }
    return { ...position, modality: part.type, outcome: 'unsupported', reason: verdict };
  };
}

async function refusedWith(verdicts: readonly Verdict[], media: readonly MediaContent[] = parts) {
  const seen: GenerateContext[] = [];
  const conversation = new Conversation();
  conversation.appendUserMessage([...media]);
  const result = await createActiveRun({
    generate: async (context) => {
      seen.push(context);
      return { content: 'ok', toolCalls: [] };
    },
    toolbox: createToolbox([]),
    conversation,
    stopWhen: () => true,
    mediaCostEstimator: estimating(verdicts),
  }).result;
  return { result, seen };
}

const codeOf = (result: { error?: unknown }): string => (result.error as MediaAdmissionError).code;

const image: MediaContent = {
  type: 'image',
  mimeType: 'image/png',
  source: { kind: 'inline', data: 'QUJD', encoding: 'base64' },
};

describe('which admitted parts count against UNSUPPORTED_MEDIA_TYPE (COR-1547)', () => {
  it('counts only the parts admitted in a message that holds a refused part', () => {
    const refused = [
      {
        messageId: 'second',
        partIndex: 0,
        modality: 'audio' as const,
        outcome: 'unsupported' as const,
        reason: 'modality-not-accepted' as const,
      },
    ];
    // An image the thread admitted in an earlier message says nothing about the audio refused now.
    expect(
      new MediaAdmissionError(refused, { admitted: [{ messageId: 'first', partIndex: 0 }] }).code,
    ).toBe('UNSUPPORTED_MEDIA_TYPE');
    // An image admitted beside the audio, in the same message, does.
    expect(
      new MediaAdmissionError(refused, { admitted: [{ messageId: 'second', partIndex: 1 }] }).code,
    ).toBe('MEDIA_NOT_ADMITTED');
  });

  it('is UNSUPPORTED_MEDIA_TYPE for a refused message after an earlier message whose media was admitted', async () => {
    const seen: GenerateContext[] = [];
    const conversation = new Conversation();
    conversation.appendUserMessage([image]);
    const firstId = conversation.getMessages()[0]!.id;
    conversation.appendUserMessage([parts[0]!]);
    const result = await createActiveRun({
      generate: async (context) => {
        seen.push(context);
        return { content: 'ok', toolCalls: [] };
      },
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
      mediaCostEstimator: (part, position): MediaCostOutcome =>
        position.messageId === firstId
          ? {
              ...position,
              modality: part.type,
              outcome: 'estimated',
              tokens: 10,
              basis: 'catalog-estimate',
            }
          : {
              ...position,
              modality: part.type,
              outcome: 'unsupported',
              reason: 'modality-not-accepted',
            },
    }).result;
    expect(codeOf(result)).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(seen).toEqual([]);
  });
});

describe('the code of a media admission refusal (COR-1547)', () => {
  it.each(['modality-not-accepted', 'mime-family-not-accepted'] as const)(
    'is UNSUPPORTED_MEDIA_TYPE when every part is refused as %s, before any generation',
    async (reason) => {
      const { result, seen } = await refusedWith([reason, reason]);

      expect(seen).toHaveLength(0);
      expect(result.finishReason).toBe('error');
      expect(result.error).toBeInstanceOf(MediaAdmissionError);
      const error = result.error as MediaAdmissionError;
      expect(error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(error.kind).toBe('policy');
      expect(error.outcomes).toHaveLength(2);
      expect(agentRunErrorToJSON(error)).toMatchObject({
        code: 'UNSUPPORTED_MEDIA_TYPE',
        kind: 'policy',
      });
    },
  );

  it('is UNSUPPORTED_MEDIA_TYPE for a message with a single part the model does not take', async () => {
    const { result } = await refusedWith(['modality-not-accepted'], [parts[0]!]);

    expect(codeOf(result)).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  // The code says the model does not take that media. A refusal for any other reason is not that,
  // however the part was refused.
  it.each([
    'asset-flagged',
    'asset-unverified',
    'media-over-budget',
    'media-count-exceeded',
    'mime-type-mismatch',
    'source-form-not-accepted',
    'no-backend-admits-media',
    'no-route-admits-media',
  ] as const)('stays MEDIA_NOT_ADMITTED when every part is refused as %s', async (reason) => {
    const { result, seen } = await refusedWith([reason, reason]);

    expect(seen).toHaveLength(0);
    expect(result.error).toBeInstanceOf(MediaAdmissionError);
    expect(codeOf(result)).toBe('MEDIA_NOT_ADMITTED');
  });

  it('stays MEDIA_NOT_ADMITTED when one part is admitted and another is not accepted', async () => {
    const { result, seen } = await refusedWith(['estimated', 'modality-not-accepted']);

    expect(seen).toHaveLength(0);
    expect(codeOf(result)).toBe('MEDIA_NOT_ADMITTED');
    expect((result.error as MediaAdmissionError).outcomes).toHaveLength(1);
  });

  it('stays MEDIA_NOT_ADMITTED when a part the model does not take is mixed with an unbounded one', async () => {
    const { result, seen } = await refusedWith(['modality-not-accepted', 'unbounded']);

    expect(seen).toHaveLength(0);
    expect(codeOf(result)).toBe('MEDIA_NOT_ADMITTED');
  });

  it('stays MEDIA_NOT_ADMITTED when a part the model does not take is mixed with a flagged one', async () => {
    const { result } = await refusedWith(['modality-not-accepted', 'asset-flagged']);

    expect(codeOf(result)).toBe('MEDIA_NOT_ADMITTED');
  });

  it('stays MEDIA_NOT_ADMITTED when the only refused part is unbounded', async () => {
    const { result } = await refusedWith(['estimated', 'unbounded']);

    expect(codeOf(result)).toBe('MEDIA_NOT_ADMITTED');
  });
});
