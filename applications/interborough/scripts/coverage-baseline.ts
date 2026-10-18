/**
 * Measured coverage floor for this workspace's `test:coverage` (`check-coverage.ts`).
 *
 * This is a RATCHET, not the plan's target: `docs/implementation-plan.md` §11
 * targets 100% adjusted coverage with an explicit reviewed allowance file,
 * weft-style, once the console's surfaces stabilize. That is aspirational and
 * not enforced here — this file only records the highest measured watermark
 * so coverage cannot silently regress below it. Bump numbers upward (never
 * downward without a written reason in the PR) whenever `bun run
 * test:coverage` reports a new high-water mark; regenerate by running it and
 * copying the printed per-area/overall counts below.
 *
 * PROVISIONAL — see the note above `overall` before trusting these numbers.
 */

/** Raw hit/found counts for one coverage area (or the `overall` rollup). */
export type AreaCoverage = {
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
};

export type CoverageBaseline = {
  measuredAt: string;
  /**
   * Re-measured 2026-08-11 after the cinder 0.23.0 / weft 0.18.0 wave.
   * Absolute covered lines rose again (23,180 → 23,273). One area moved for a
   * reason worth recording rather than silently re-baselining: `src/lib`
   * reported 60.65% against a 60.92% floor, entirely from LINE ATTRIBUTION,
   * not lost coverage. `scopes.svelte.ts`'s module doc shrank by ~25 lines
   * when the probe-and-infer explanation was replaced by the
   * `weft.system.principal` description, which renumbers the whole file and
   * shifts how the Svelte-compiled output maps back to source lines — the
   * "uncovered" lines it reports are the `AUTHORIZATION_SCOPES` literal and
   * class-declaration lines, which are plainly executed (41 passing tests in
   * `scopes.svelte.test.ts` + `scopes.svelte.integration.test.ts` exercise
   * every branch of `resolvePrincipal`, `hasScope`, `bannerMode`,
   * `denyScope`, and `scopeGate`, the last two against real `serve()`
   * instances). Coverage of the module went UP in substance: its three boot
   * outcomes are now pinned on the wire instead of against a fake client.
   *
   * Earlier note (2026-08-10), kept for context: re-measured after the
   * cinder 0.22.0 / weft 0.16.0 dependency
   * wave. Absolute covered lines ROSE (23,003 → 23,180) but a few area
   * percentages dipped fractionally, for structural reasons reviewed in that
   * change: `src/lib` lost exactly the two covered lines of the removed
   * `budget:*` scopes (weft#844); `src/routes/system` grew with the new
   * authoritative Active-alerts section (weft#843) whose compiled template
   * branches are partially covered; `tests` (= `tests/setup.ts` + the smoke
   * harnesses — test FILES are not instrumented) shifted because every test
   * file now imports `@testing-library/svelte` statically, so setup.ts's
   * dynamic-import fallback paths no longer execute. That static-import
   * conversion is itself the fix for `bun test --parallel=1` hard-failing
   * whenever the library's module-scope `beforeEach()` registration first
   * evaluated INSIDE a running test — the root cause of the coverage suite's
   * 378-failure crashes (and the likely identity of the previously
   * intermittent full-suite failure).
   *
   * Earlier note (2026-07-24), kept for context: re-measured after the
   * Cinder 0.19.0 migration. Coverage runs serially because Bun's
   * default-parallel coverage workers can collide on the integration
   * servers' ephemeral ports; the exact command is recorded in
   * package.json's `test:coverage` script.
   *
   * 2026-07-24 SIGTRAP investigation (isolated worktree): the earlier
   * full-parallel SIGTRAP (exit 133; crash report
   * ~/Library/Logs/DiagnosticReports/bun-2026-07-24-121054.ips) did NOT
   * reproduce in 3/3 loaded runs on Bun 1.3.13 — artificial load produced
   * EADDRINUSE noise instead, consistent with the port-collision rationale
   * above — and the full suite ran clean on Bun 1.3.14. Not escalated to
   * oven-sh/bun without a reproduction. Also verified: `--path-ignore-patterns`
   * takes real GLOBS matched against the path (`'*storage-client*'` excludes;
   * a bare substring like `'storage-client'` matches nothing — Jest-style
   * regex-substring expectations do not transfer), and explicitly named file
   * arguments override ignore patterns.
   */
  overall: AreaCoverage;
  areas: Record<string, AreaCoverage>;
};

/**
 * Platforms the coverage gate records separate baselines for.
 *
 * Bun's LCOV attribution is DETERMINISTIC per platform but materially
 * different between macOS and Linux: the same commit, same suite, and same
 * 1213-test pass produced e.g. `src/routes/system` 89.26% lines on darwin
 * vs 26.31% on linux (CI run 31435362335, byte-identical across a rerun —
 * some areas measure higher on linux, some lower, so neither is a subset
 * of the other). One shared floor therefore cannot gate both environments;
 * each platform ratchets against numbers measured on that platform.
 */
export type CoverageMeasurementPlatform = 'darwin' | 'linux';

/** The current process's baseline platform, or `null` when unrecognized. */
export function coverageMeasurementPlatform(): CoverageMeasurementPlatform | null {
  return process.platform === 'darwin' || process.platform === 'linux' ? process.platform : null;
}

const DARWIN_BASELINE: CoverageBaseline = {
  // Re-measured for COR-1488, when the console moved into this application and gained its sidebar,
  // view frame, and placeholder routes, on darwin with the command in `run-coverage.ts`. The areas
  // keep the names they had in the console's own workspace; `src/views` and `src/routes/placeholder`
  // are new, and the `src` area now holds the entry point and the route table. `src/lib` then lost
  // `setApiKey`, ten lines and two functions that were all covered, with the API-key form it served.
  measuredAt: '2026-10-18T04:00:00.000Z',
  overall: { linesFound: 46825, linesHit: 44991, functionsFound: 9179, functionsHit: 8835 },
  areas: {
    fixtures: { linesFound: 698, linesHit: 321, functionsFound: 69, functionsHit: 12 },
    scripts: { linesFound: 879, linesHit: 874, functionsFound: 60, functionsHit: 59 },
    src: { linesFound: 152, linesHit: 152, functionsFound: 26, functionsHit: 26 },
    'src/app': { linesFound: 2481, linesHit: 2405, functionsFound: 491, functionsHit: 471 },
    'src/lib': { linesFound: 1490, linesHit: 1479, functionsFound: 259, functionsHit: 255 },
    'src/routes/dashboard': {
      linesFound: 1410,
      linesHit: 1174,
      functionsFound: 246,
      functionsHit: 222,
    },
    'src/routes/placeholder': { linesFound: 23, linesHit: 23, functionsFound: 4, functionsHit: 4 },
    'src/routes/reviews': {
      linesFound: 2204,
      linesHit: 2060,
      functionsFound: 440,
      functionsHit: 421,
    },
    'src/routes/schedules': {
      linesFound: 3675,
      linesHit: 3597,
      functionsFound: 790,
      functionsHit: 767,
    },
    'src/routes/storage': {
      linesFound: 2676,
      linesHit: 2649,
      functionsFound: 534,
      functionsHit: 523,
    },
    'src/routes/system': {
      linesFound: 8797,
      linesHit: 8762,
      functionsFound: 1804,
      functionsHit: 1777,
    },
    'src/routes/workers': {
      linesFound: 8553,
      linesHit: 8407,
      functionsFound: 1663,
      functionsHit: 1649,
    },
    'src/routes/workflows': {
      linesFound: 13274,
      linesHit: 12599,
      functionsFound: 2709,
      functionsHit: 2566,
    },
    'src/views': { linesFound: 376, linesHit: 376, functionsFound: 67, functionsHit: 67 },
    tests: { linesFound: 127, linesHit: 103, functionsFound: 15, functionsHit: 14 },
  },
};

const LINUX_BASELINE: CoverageBaseline = {
  // COR-1488 re-measured darwin only. The recorded Linux and darwin counts were identical at the
  // last measurement on both, so this carries the darwin counts until a Linux run records its own.
  measuredAt: '2026-10-18T04:00:00.000Z',
  overall: { linesFound: 46825, linesHit: 44991, functionsFound: 9179, functionsHit: 8835 },
  areas: {
    fixtures: { linesFound: 698, linesHit: 321, functionsFound: 69, functionsHit: 12 },
    scripts: { linesFound: 879, linesHit: 874, functionsFound: 60, functionsHit: 59 },
    src: { linesFound: 152, linesHit: 152, functionsFound: 26, functionsHit: 26 },
    'src/app': { linesFound: 2481, linesHit: 2405, functionsFound: 491, functionsHit: 471 },
    'src/lib': { linesFound: 1490, linesHit: 1479, functionsFound: 259, functionsHit: 255 },
    'src/routes/dashboard': {
      linesFound: 1410,
      linesHit: 1174,
      functionsFound: 246,
      functionsHit: 222,
    },
    'src/routes/placeholder': { linesFound: 23, linesHit: 23, functionsFound: 4, functionsHit: 4 },
    'src/routes/reviews': {
      linesFound: 2204,
      linesHit: 2060,
      functionsFound: 440,
      functionsHit: 421,
    },
    'src/routes/schedules': {
      linesFound: 3675,
      linesHit: 3597,
      functionsFound: 790,
      functionsHit: 767,
    },
    'src/routes/storage': {
      linesFound: 2676,
      linesHit: 2649,
      functionsFound: 534,
      functionsHit: 523,
    },
    'src/routes/system': {
      linesFound: 8797,
      linesHit: 8762,
      functionsFound: 1804,
      functionsHit: 1777,
    },
    'src/routes/workers': {
      linesFound: 8553,
      linesHit: 8407,
      functionsFound: 1663,
      functionsHit: 1649,
    },
    'src/routes/workflows': {
      linesFound: 13274,
      linesHit: 12599,
      functionsFound: 2709,
      functionsHit: 2566,
    },
    'src/views': { linesFound: 376, linesHit: 376, functionsFound: 67, functionsHit: 67 },
    tests: { linesFound: 127, linesHit: 103, functionsFound: 15, functionsHit: 14 },
  },
};

export const COVERAGE_BASELINES: Record<CoverageMeasurementPlatform, CoverageBaseline | null> = {
  darwin: DARWIN_BASELINE,
  linux: LINUX_BASELINE,
};
