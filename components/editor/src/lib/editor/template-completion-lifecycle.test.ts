import type { PlaceholderCandidate, PlaceholderCompletionConfiguration } from '@lostgradient/markdown';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createCompletionHarness,
  createMockElement,
  flushMicrotasks,
  flushTimers,
  makeCandidate,
} from './template-completion-test-utilities.js';

describe('template completion async lookup lifecycle', () => {
  const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');

  beforeEach(() => {
    const mockBody = createMockElement();
    const mockDocumentElement = createMockElement();
    const mockDocument = {
      body: mockBody,
      documentElement: mockDocumentElement,
      createElement: () => createMockElement(),
    };
    Object.defineProperty(globalThis, 'document', {
      value: mockDocument,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    if (originalDocumentDescriptor) {
      Object.defineProperty(globalThis, 'document', originalDocumentDescriptor);
      return;
    }
    Reflect.deleteProperty(globalThis, 'document');
  });

  it('swallows aborted async lookup rejections without uncaught errors', async () => {
    const abortedQueries: string[] = [];
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const deferredResolutions = new Map<string, (value: PlaceholderCandidate[]) => void>();
      const configuration: PlaceholderCompletionConfiguration = {
        candidates: [],
        minimumQueryLength: 1,
        lookupDebounceMs: 0,
        lookupCandidates: (query, signal) =>
          new Promise<PlaceholderCandidate[]>((resolve, reject) => {
            deferredResolutions.set(query, resolve);
            signal.addEventListener(
              'abort',
              () => {
                abortedQueries.push(query);
                reject(new Error(`aborted:${query}`));
              },
              { once: true },
            );
          }),
      };

      const harness = await createCompletionHarness(configuration);

      harness.typeText('a');
      await flushTimers();

      harness.typeText('b');
      await flushTimers();

      deferredResolutions.get('ab')?.([]);
      await flushMicrotasks();

      harness.pluginView.destroy?.();
      await flushTimers();

      expect(abortedQueries).toContain('a');
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('keeps suggestions from the latest query when rapid typing causes overlapping lookups', async () => {
    type DeferredLookup = {
      resolve: (value: PlaceholderCandidate[]) => void;
      signal: AbortSignal;
    };
    const deferredByQuery = new Map<string, DeferredLookup>();

    const configuration: PlaceholderCompletionConfiguration = {
      candidates: [],
      minimumQueryLength: 1,
      lookupDebounceMs: 0,
      lookupCandidates: (query, signal) =>
        new Promise<PlaceholderCandidate[]>((resolve) => {
          deferredByQuery.set(query, { resolve, signal });
        }),
    };

    const harness = await createCompletionHarness(configuration);
    harness.typeText('a');
    await flushTimers();

    harness.typeText('b');
    await flushTimers();

    deferredByQuery.get('ab')?.resolve([makeCandidate('ab.latest')]);
    await flushMicrotasks();

    deferredByQuery.get('a')?.resolve([makeCandidate('a.stale')]);
    await flushMicrotasks();

    const pluginState = harness.getPluginState();

    expect(deferredByQuery.get('a')?.signal.aborted).toBe(true);
    expect(pluginState?.query).toBe('ab');
    expect(pluginState?.suggestions.map((candidate) => candidate.path)).toEqual(['ab.latest']);

    harness.pluginView.destroy?.();
  });
});
