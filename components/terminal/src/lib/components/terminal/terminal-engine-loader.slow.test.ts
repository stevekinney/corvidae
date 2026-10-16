import { describe, expect, test } from 'bun:test';

import { loadRendererEngineFactory } from './terminal-engine-loader.ts';

// The engine import is about 34 ms on a quiet host. A validate run that starves the host stretched
// it to 76 s against Bun's 5 s per-test clock (reproduced on main 1 time in 3 at load 140), so
// these two tests run in `test:slow` with the clock unchanged, as AGENTS.md prescribes for the
// COR-1499 class. The rejection outside a browser does no import and stays in the fast lane.
describe('loadRendererEngineFactory (real import)', () => {
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

  test('constructs nothing until the factory is called', async () => {
    const factory = await loadRendererEngineFactory();
    expect(document.querySelectorAll('.xterm')).toHaveLength(0);
    expect(typeof factory).toBe('function');
  });
});
