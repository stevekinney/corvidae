import { describe, expect, it } from 'bun:test';

import { Engine } from '../../src/core/engine.ts';
import type { WorkflowContext } from '../../src/core/types.ts';
import { workflow } from '../../src/core/types/workflow-function.ts';
import { BunSQLiteStorage } from '../../src/storage/bun-sql.ts';

const LIBRARY_TARGET_MS = 100;

describe('Library cold start', () => {
  it(`new Engine() to first workflow start completes in <${LIBRARY_TARGET_MS}ms`, async () => {
    const iterations = 10;
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();

      const storage = new BunSQLiteStorage(':memory:');
      const engine = new Engine({ storage });

      const ping = workflow({ name: 'ping' }).execute(async function* (_ctx: WorkflowContext) {
        yield* [];
        return 'pong';
      });
      engine.register(ping);

      const handle = await engine.start('ping', null);
      await handle.result();

      const elapsed = performance.now() - start;
      times.push(elapsed);

      engine[Symbol.dispose]();
      storage[Symbol.dispose]();
    }

    // Use the median to avoid outliers from first-run JIT compilation.
    const sorted = [...times].toSorted((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const min = sorted[0]!;
    const max = sorted[sorted.length - 1]!;

    console.log(
      [
        `\n  Library cold start benchmark (${iterations} iterations):`,
        `    Median:          ${median.toFixed(2)}ms`,
        `    Min:             ${min.toFixed(2)}ms`,
        `    Max:             ${max.toFixed(2)}ms`,
        `    Target:          <${LIBRARY_TARGET_MS}ms\n`,
      ].join('\n'),
    );

    expect(median).toBeLessThan(LIBRARY_TARGET_MS);
  });
});
