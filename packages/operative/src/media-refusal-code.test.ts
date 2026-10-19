import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import type { MediaContent } from 'conversationalist';
import { Conversation } from 'conversationalist';

import type { MediaCostEstimator, MediaCostOutcome } from './context/types';
import { createActiveRun } from './create-run';
import { agentRunErrorToJSON, MediaAdmissionError } from './errors';
import type { GenerateContext } from './types';

/**
 * COR-1547 — a message whose every media part is refused as `unsupported` fails with its own
 * native code, `UNSUPPORTED_MEDIA_TYPE`, so a client can tell "this model does not take that kind
 * of media" from every other admission refusal. Any other mix keeps `MEDIA_NOT_ADMITTED`.
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

type Verdict = 'unsupported' | 'unbounded' | 'estimated';

function estimating(verdicts: readonly Verdict[]): MediaCostEstimator {
  return (part, position): MediaCostOutcome => {
    const verdict = verdicts[position.partIndex]!;
    if (verdict === 'unsupported') {
      return {
        ...position,
        modality: part.type,
        outcome: 'unsupported',
        reason: 'modality-not-accepted',
      };
    }
    if (verdict === 'unbounded') {
      return { ...position, modality: part.type, outcome: 'unbounded', reason: 'size-unknown' };
    }
    return {
      ...position,
      modality: part.type,
      outcome: 'estimated',
      tokens: 10,
      basis: 'catalog-estimate',
    };
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

describe('the code of a media admission refusal (COR-1547)', () => {
  it('is UNSUPPORTED_MEDIA_TYPE when every part is unsupported, before any generation', async () => {
    const { result, seen } = await refusedWith(['unsupported', 'unsupported']);

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
  });

  it('is UNSUPPORTED_MEDIA_TYPE for a message with a single unsupported part', async () => {
    const { result } = await refusedWith(['unsupported'], [parts[0]!]);

    expect((result.error as MediaAdmissionError).code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('stays MEDIA_NOT_ADMITTED when an unsupported part is mixed with an unbounded one', async () => {
    const { result, seen } = await refusedWith(['unsupported', 'unbounded']);

    expect(seen).toHaveLength(0);
    expect(result.error).toBeInstanceOf(MediaAdmissionError);
    expect((result.error as MediaAdmissionError).code).toBe('MEDIA_NOT_ADMITTED');
  });

  it('stays MEDIA_NOT_ADMITTED when the only refused part is unbounded', async () => {
    const { result } = await refusedWith(['estimated', 'unbounded']);

    expect((result.error as MediaAdmissionError).code).toBe('MEDIA_NOT_ADMITTED');
  });

  it('is UNSUPPORTED_MEDIA_TYPE when the parts that are refused are all unsupported, whatever else was admitted', async () => {
    const { result } = await refusedWith(['estimated', 'unsupported']);

    expect((result.error as MediaAdmissionError).code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect((result.error as MediaAdmissionError).outcomes).toHaveLength(1);
  });
});
