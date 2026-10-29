/**
 * COR-716 — every wrapper that returns a `GenerateFunction` around another
 * reports the backends it can reach. Media admission costs parts against those
 * descriptors; a wrapper that dropped them would leave admission with nothing
 * to cost against and refuse every part as `no-estimator`. The provider
 * factories themselves are covered by `provider-backend-descriptors.test.ts`.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import { withCacheMetrics } from '../src/cache/cache-metrics';
import { withCache } from '../src/cache/with-cache';
import { createLazyGenerate } from '../src/create-lazy-generate';
import { composeGenerate, createFallbackGenerate } from '../src/generate-middleware';
import {
  readBackendDescriptors,
  withBackendDescriptors,
} from '../src/providers/backend-descriptor-attachment';
import { createFalloverGenerate } from '../src/providers/fallover/create-fallover-generate';
import { createModelCatalog } from '../src/providers/model-catalog';
import { createRoutingGenerate } from '../src/providers/routing/create-routing-generate';
import { withRoutingMetrics } from '../src/providers/routing/routing-metrics';
import { withStreaming } from '../src/streaming';
import { withEnhancedStreaming } from '../src/streaming/enhanced-streaming';
import type { GenerateFunction, GenerateMiddleware, StreamingGenerateFunction } from '../src/types';

const descriptors = createModelCatalog().descriptors.filter(
  (descriptor) => descriptor.provider === 'anthropic',
);

function inner(): GenerateFunction {
  return withBackendDescriptors(async () => ({ content: 'ok', toolCalls: [] }), descriptors);
}

function innerStreaming(): StreamingGenerateFunction {
  return withBackendDescriptors(async () => ({ content: 'ok', toolCalls: [] }), descriptors);
}

describe('every generate wrapper keeps the inner backend descriptors (COR-716)', () => {
  const bare: GenerateMiddleware = (next) => async (context) => next(context);
  const wrappers: ReadonlyArray<readonly [string, () => GenerateFunction]> = [
    ['composeGenerate', () => composeGenerate(inner(), bare)],
    ['createFallbackGenerate', () => createFallbackGenerate({ providers: [inner()] })],
    [
      'createFalloverGenerate',
      () => createFalloverGenerate({ providers: [{ name: 'only', generate: inner() }] }),
    ],
    [
      'createRoutingGenerate',
      () =>
        createRoutingGenerate({
          routes: [{ name: 'only', generate: inner() }],
          strategy: () => ({ route: 'only', reason: 'test' }),
          fallback: 'only',
        }),
    ],
    [
      'withRoutingMetrics',
      () =>
        withRoutingMetrics({
          routes: [{ name: 'only', generate: inner() }],
          strategy: () => ({ route: 'only', reason: 'test' }),
          fallback: 'only',
        }).generate,
    ],
    ['createLazyGenerate', () => createLazyGenerate(() => inner(), { descriptors })],
    ['withCache', () => withCache(inner(), { store: textValueStore(new MemoryStorage()) })],
    [
      'withCacheMetrics',
      () => withCacheMetrics(inner(), { store: textValueStore(new MemoryStorage()) }).generate,
    ],
    ['withStreaming', () => withStreaming(innerStreaming())],
    ['withEnhancedStreaming', () => withEnhancedStreaming(innerStreaming())],
  ];

  for (const [name, build] of wrappers) {
    it(`${name} reports the inner descriptors`, () => {
      // Compared as sets: a union wrapper orders descriptors by their triple.
      const attached = readBackendDescriptors(build());
      expect(attached.map((descriptor) => descriptor.model).toSorted()).toEqual(
        descriptors.map((descriptor) => descriptor.model).toSorted(),
      );
    });
  }
});
