import { describe, expect, test } from 'bun:test';

import { loadRendererEngineFactory } from './terminal-engine-loader.ts';

describe('loadRendererEngineFactory', () => {
  test('loads the engine in a browser and returns a factory that builds it', async () => {
    const factory = await loadRendererEngineFactory();
    const engine = factory({
      readOnly: false,
      announceOutput: false,
      reducedMotion: false,
      ariaLabel: 'Terminal',
      theme: {},
      geometry: { columns: 30, rows: 6 },
    });
    expect(engine.geometry).toEqual({ columns: 30, rows: 6 });
    engine.dispose();
  });

  test('loads nothing outside a browser', async () => {
    const failure = await loadRendererEngineFactory(false).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(failure instanceof Error ? failure.message : failure).toBe(
      'The terminal engine loads only in a browser.',
    );
  });

  test('constructs nothing until the factory is called', async () => {
    const factory = await loadRendererEngineFactory();
    expect(document.querySelectorAll('.xterm')).toHaveLength(0);
    expect(typeof factory).toBe('function');
  });
});
