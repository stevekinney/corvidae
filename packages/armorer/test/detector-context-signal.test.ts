import { describe, expect, expectTypeOf, it } from 'bun:test';

import type { DetectorContext, InputDetector } from '../src/index';

describe('DetectorContext.signal (COR-2193)', () => {
  it('is optional, so a context built without it, and a detector that ignores it, still compile', async () => {
    expectTypeOf<DetectorContext['signal']>().toEqualTypeOf<AbortSignal | undefined>();
    expectTypeOf<{
      step: number;
      conversationLength: number;
      sessionTainted: boolean;
      provenance: 'user-input';
    }>().toMatchTypeOf<DetectorContext>();

    const detector: InputDetector = {
      name: 'ignores-the-signal',
      detect: async (_input, context) => ({
        triggered: context.signal?.aborted === true,
        confidence: 0,
        category: 'none',
      }),
    };
    const controller = new AbortController();
    const context: DetectorContext = {
      step: 0,
      conversationLength: 0,
      sessionTainted: false,
      provenance: 'user-input',
      signal: controller.signal,
    };
    const before = await detector.detect('x', context);
    expect(before.triggered).toBe(false);
    controller.abort();
    const after = await detector.detect('x', context);
    expect(after.triggered).toBe(true);
  });
});
