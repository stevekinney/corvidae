/**
 * COR-1548 — what an agent's model descriptors say about the media it takes, in the shape
 * `bureau.agents.list` serves. An agent with no descriptor (an opaque generate) has none; several
 * descriptors (a routed agent) collapse to what every one of them takes, so a client never offers
 * a file that one route would refuse.
 */
import { createModelCatalog, type BackendDescriptor } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { mediaCapabilitiesOf } from './agent-catalog.ts';

const rows = createModelCatalog().descriptors;
const anthropic = rows.find((row) => row.provider === 'anthropic')!;
const gemini = rows.find((row) => row.provider === 'gemini')!;

function without(descriptor: BackendDescriptor, limits: BackendDescriptor['mediaLimits']) {
  return { ...descriptor, mediaLimits: limits };
}

describe('mediaCapabilitiesOf', () => {
  it('is null for an agent with no descriptor', () => {
    expect(mediaCapabilitiesOf([])).toBeNull();
  });

  it('reads the input and output of each modality, the families, and the per-part byte limits', () => {
    const media = mediaCapabilitiesOf([anthropic])!;

    expect(media.modalities['image']).toEqual({ input: true, output: false });
    expect(media.modalities['audio']).toEqual({ input: false, output: false });
    expect(media.mimeFamilies).toEqual(['text', 'image', 'document']);
    expect(media.mediaLimits).toEqual([{ modality: 'image', maxBytes: 10 * 1024 * 1024 }]);
  });

  it('carries only per-part limits that name a byte count', () => {
    const media = mediaCapabilitiesOf([
      without(anthropic, [
        { scope: 'per-part', modality: 'image', maxBytes: 5 },
        { scope: 'aggregate', modality: 'image', maxBytes: 50 },
        { scope: 'per-part', modality: 'video', maxDurationSeconds: 30 },
      ]),
    ])!;

    expect(media.mediaLimits).toEqual([{ modality: 'image', maxBytes: 5 }]);
  });

  it('keeps, for several descriptors, only what every one takes, with the smallest limit', () => {
    const media = mediaCapabilitiesOf([anthropic, gemini])!;

    // Gemini takes audio and video; Anthropic does not, so neither is offered.
    expect(media.modalities['audio']?.input).toBe(false);
    expect(media.modalities['image']?.input).toBe(true);
    expect(media.mimeFamilies).toEqual(['text', 'image', 'document']);
    // Anthropic's 10 MiB image limit is below Gemini's 20 MiB.
    expect(media.mediaLimits).toContainEqual({ modality: 'image', maxBytes: 10 * 1024 * 1024 });
    expect(media.mediaLimits.filter((limit) => limit.modality === 'image')).toHaveLength(1);
  });

  it('keeps only the families every route takes, whichever route comes first', () => {
    // Gemini takes audio and video as well; Anthropic does not. Listed first, Gemini's broader
    // families would survive a union, so the order is what tells an intersection from a union.
    const media = mediaCapabilitiesOf([gemini, anthropic])!;

    expect(media.mimeFamilies).toEqual(['text', 'image', 'document']);
    expect(media.mimeFamilies).not.toContain('audio');
    expect(media.mimeFamilies).not.toContain('video');
  });

  it('does not let a descriptor with no limit for a modality remove another’s limit', () => {
    const media = mediaCapabilitiesOf([without(anthropic, []), anthropic])!;

    expect(media.mediaLimits).toEqual([{ modality: 'image', maxBytes: 10 * 1024 * 1024 }]);
  });
});
