import type { BackendDescriptor } from '@lostgradient/operative';

/**
 * A catalog row written out for the tests that need some row to copy from. Operative holds no row
 * of its own (COR-2151) and this package takes no vendor package, so the shape is spelled here.
 */
export const catalogRow: BackendDescriptor = {
  provider: 'example',
  endpoint: 'https://example.invalid',
  model: 'example-model',
  aliases: [],
  lifecycle: 'stable',
  modalities: {
    text: { input: true, output: true, sourceForms: ['inline'] },
    image: { input: false, output: false, sourceForms: [] },
    document: { input: false, output: false, sourceForms: [] },
    audio: { input: false, output: false, sourceForms: [] },
    video: { input: false, output: false, sourceForms: [] },
    file: { input: false, output: false, sourceForms: [] },
  },
  mimeFamilies: [],
  mediaLimits: [],
  mediaCounts: [],
  providerFetchesRemoteUrls: false,
  contextWindowTokens: 100_000,
  maxOutputTokens: 8_000,
  streaming: true,
  tools: true,
  parallelTools: true,
  structuredOutput: true,
  parameterCompatibility: [],
  caching: false,
  batchInference: false,
  explicitThinkingRequest: false,
  serverSideTokenCounting: false,
  effort: { portable: [], nativeMapping: 'unsupported', degradesTo: {} },
  availability: 'available',
  health: 'healthy',
  source: 'static',
  freshness: '2026-10-17T00:00:00.000Z',
};
