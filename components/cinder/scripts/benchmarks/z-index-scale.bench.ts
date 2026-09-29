import { describe, expect, test } from 'bun:test';

import { lint, warnings } from '../stylelint/z-index-scale.test-support';

// These N-vs-2N scaling tests assert host-load-sensitive wall-clock ratios, so they run through
// `bun run test:benchmarks` and stay outside the default `test` gate, which does not discover
// `*.bench.ts`. Targets are unchanged from when they lived in scripts/stylelint/z-index-scale.test.ts.
describe('cinder/z-index-scale', () => {
  test('bounds static max-floor scans with an unresolved wide sibling set', async () => {
    // This used to assert an absolute 2000ms wall-clock budget, the same
    // mis-specification its neighbor below had: it flaked twice in CI at
    // 2048ms under runner load (rerun-green both times) while the property
    // it needs to prove is that the max-floor scan stays linear in the
    // sibling count. Same protocol as the neighbor: fastest-of-3 trials at
    // N and 2N, ratio bound 4x, generous absolute ceiling only as a hang
    // guard.
    const buildCss = (siblingCount: number) => {
      const siblings = Array.from(
        { length: siblingCount },
        (_, index) => `var(--item-layer-${index}, -1)`,
      ).join(', ');
      return `
        .fixture {
          /* cinder-z-index-local: unresolved generated max arguments must fail closed promptly. */
          z-index: max(var(--runtime), ${siblings});
        }
      `;
    };
    const fastestLintTime = async (siblingCount: number) => {
      const css = buildCss(siblingCount);
      let fastest = Number.POSITIVE_INFINITY;
      for (let trial = 0; trial < 3; trial += 1) {
        const startedAt = performance.now();
        const result = await lint(css);
        fastest = Math.min(fastest, performance.now() - startedAt);
        expect(warnings(result)).toHaveLength(1);
      }
      return fastest;
    };

    const baselineSiblingCount = 32_000;
    const timeAtBaseline = await fastestLintTime(baselineSiblingCount);
    const timeAtDoubled = await fastestLintTime(baselineSiblingCount * 2);

    expect(timeAtBaseline).toBeLessThan(30_000);
    expect(timeAtDoubled).toBeLessThan(30_000);
    expect(timeAtDoubled).toBeLessThan(timeAtBaseline * 4);
  }, 35_000);

  test('builds wide clamp placeholders in linear time', async () => {
    // This used to assert an absolute wall-clock budget (2000ms), which
    // flaked in CI under load -- three real failures at 2015ms, 2028ms,
    // and 2034ms, each passing cleanly on rerun -- and could equally
    // false-fail locally on a busy machine. The property this test
    // actually needs to prove is that placeholder generation scales
    // linearly with the sibling count, not that any one run completes
    // within some fixed latency, so measure at N and 2N and assert the
    // doubled input takes less than 4x as long: comfortably above the
    // ~2x a linear algorithm should show (measured locally at N = 16,000
    // across ten runs: 1.74x-2.40x), but tight enough to still catch an
    // O(n^2) regression. Each measurement takes the fastest of 3 trials to
    // reduce scheduling noise (a slowdown can only inflate a trial, never
    // deflate it below the true minimum), and N is sized so a single
    // trial comfortably clears ~150ms even on a loaded machine, keeping
    // fixed per-lint overhead from dominating the measurement. A generous
    // absolute ceiling remains only to catch an outright hang.
    const buildCss = (siblingCount: number) => {
      const siblings = Array.from(
        { length: siblingCount },
        (_, index) => `var(--item-layer-${index}, -1)`,
      ).join(' + ');
      return `
          .fixture {
            /* cinder-z-index-local: static clamp bounds keep every generated fallback safe. */
            z-index: clamp(0, calc(var(--runtime) + ${siblings}), 1);
          }
        `;
    };
    const fastestLintTime = async (siblingCount: number) => {
      const css = buildCss(siblingCount);
      let fastest = Number.POSITIVE_INFINITY;
      for (let trial = 0; trial < 3; trial += 1) {
        const startedAt = performance.now();
        const result = await lint(css);
        fastest = Math.min(fastest, performance.now() - startedAt);
        expect(warnings(result)).toEqual([]);
      }
      return fastest;
    };

    const baselineSiblingCount = 16_000;
    const timeAtBaseline = await fastestLintTime(baselineSiblingCount);
    const timeAtDoubled = await fastestLintTime(baselineSiblingCount * 2);

    expect(timeAtBaseline).toBeLessThan(30_000);
    expect(timeAtDoubled).toBeLessThan(30_000);
    expect(timeAtDoubled).toBeLessThan(timeAtBaseline * 4);
  }, 35_000);
});
