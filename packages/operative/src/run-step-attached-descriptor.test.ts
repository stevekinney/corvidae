/**
 * COR-2146 — media admission reads the descriptors attached to a run's `generate`. A host that
 * attaches the catalog row a generate was built from, owner edits and a plugin's own row included,
 * therefore decides admission by that row, not by the static row a vendor factory stamped.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, type MediaContent } from 'conversationalist';

import { createActiveRun } from './create-run';
import { MediaAdmissionError } from './errors';
import {
  createModelCatalog,
  withBackendDescriptors,
  type BackendDescriptor,
} from './providers/index';
import type { GenerateFunction } from './types';

const seed = createModelCatalog().descriptors.find((row) => row.provider === 'anthropic')!;

/** About 3 KiB once decoded: inside the seed row's 10 MiB per-part image cap. */
const image: MediaContent = {
  type: 'image',
  mimeType: 'image/png',
  source: { kind: 'inline', data: 'QUJD'.repeat(1024), encoding: 'base64' },
};

/** The seed row with its per-part image limit lowered, as an owner's edit would leave it. */
const lowered: BackendDescriptor = {
  ...seed,
  mediaLimits: [{ scope: 'per-part', modality: 'image', maxBytes: 1024 }],
};

async function run(row: BackendDescriptor) {
  let called = 0;
  const generate: GenerateFunction = async () => {
    called += 1;
    return { content: 'ok', toolCalls: [] };
  };
  const conversation = new Conversation();
  conversation.appendUserMessage([image]);
  const result = await createActiveRun({
    generate: withBackendDescriptors(generate, [row]),
    toolbox: createToolbox([]),
    conversation,
    stopWhen: () => true,
  }).result;
  return { result, called: () => called };
}

describe('media admission by the attached row', () => {
  it('admits an image the seed row admits', async () => {
    const { result, called } = await run(seed);
    expect(result.error).toBeUndefined();
    expect(called()).toBe(1);
  });

  it('refuses the same image under a row whose image limit was lowered', async () => {
    const { result, called } = await run(lowered);
    expect(result.error).toBeInstanceOf(MediaAdmissionError);
    expect(called()).toBe(0);
  });
});
