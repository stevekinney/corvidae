import { describe, expect, test } from 'bun:test';

import { loadRendererEngineFactory } from './terminal-engine-loader.ts';

describe('loadRendererEngineFactory', () => {
  test('loads nothing outside a browser', async () => {
    const failure = await loadRendererEngineFactory(false).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(failure instanceof Error ? failure.message : failure).toBe(
      'The terminal engine loads only in a browser.',
    );
  });
});
