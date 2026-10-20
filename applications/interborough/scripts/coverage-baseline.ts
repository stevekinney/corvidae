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
  // Re-measured for COR-1491 and COR-1492, which add `src/routes/tasks` (the Tasks view) and the
  // Bureau's reviews in `src/routes/reviews`, on top of COR-1493 and COR-1494 (`src/routes/audit`,
  // `src/routes/goals`, and `src/routes/schedules`). Every area is re-measured on darwin with the
  // command in `run-coverage.ts`. The Linux baseline below is not re-measured: it needs a Linux
  // host, so `src/routes/tasks` has no Linux floor yet.
  measuredAt: '2026-10-19T23:30:00.000Z',
  overall: { linesFound: 70108, linesHit: 68247, functionsFound: 13855, functionsHit: 13479 },
  areas: {
    fixtures: { linesFound: 698, linesHit: 321, functionsFound: 69, functionsHit: 12 },
    scripts: { linesFound: 965, linesHit: 965, functionsFound: 68, functionsHit: 68 },
    src: { linesFound: 152, linesHit: 152, functionsFound: 26, functionsHit: 26 },
    'src/app': { linesFound: 3604, linesHit: 3537, functionsFound: 652, functionsHit: 634 },
    'src/lib': { linesFound: 3838, linesHit: 3821, functionsFound: 594, functionsHit: 590 },
    // COR-1532, measured on darwin: the agent editor's route, form, state, and revision history.
    'src/routes/agent-editor': {
      linesFound: 1448,
      linesHit: 1434,
      functionsFound: 332,
      functionsHit: 327,
    },
    'src/routes/agents': {
      linesFound: 1900,
      linesHit: 1893,
      functionsFound: 402,
      functionsHit: 396,
    },
    // COR-1493, measured on darwin: the audit search.
    'src/routes/audit': { linesFound: 642, linesHit: 642, functionsFound: 152, functionsHit: 152 },
    'src/routes/chat': { linesFound: 1444, linesHit: 1435, functionsFound: 297, functionsHit: 292 },
    'src/routes/dashboard': {
      linesFound: 1472,
      linesHit: 1236,
      functionsFound: 254,
      functionsHit: 230,
    },
    // COR-1494, measured on darwin: the goals list, its create drawer, and its cancel.
    'src/routes/goals': {
      linesFound: 1222,
      linesHit: 1218,
      functionsFound: 310,
      functionsHit: 306,
    },
    'src/routes/placeholder': { linesFound: 23, linesHit: 23, functionsFound: 4, functionsHit: 4 },
    'src/routes/reviews': {
      linesFound: 2918,
      linesHit: 2864,
      functionsFound: 610,
      functionsHit: 593,
    },
    // COR-1494, measured on darwin: the kinds, the writes by owner, and the agent-run drawer.
    'src/routes/schedules': {
      linesFound: 5065,
      linesHit: 4991,
      functionsFound: 1108,
      functionsHit: 1085,
    },
    'src/routes/storage': {
      linesFound: 2660,
      linesHit: 2637,
      functionsFound: 543,
      functionsHit: 532,
    },
    'src/routes/system': {
      linesFound: 10532,
      linesHit: 10497,
      functionsFound: 2106,
      functionsHit: 2076,
    },
    // COR-1491, measured on darwin: the Tasks view.
    'src/routes/tasks': {
      linesFound: 1836,
      linesHit: 1727,
      functionsFound: 355,
      functionsHit: 341,
    },
    'src/routes/workers': {
      linesFound: 12913,
      linesHit: 12778,
      functionsFound: 2576,
      functionsHit: 2560,
    },
    // COR-1533, measured on darwin: the Workflows area's catalog, a type's page, its runs, and its editor.
    'src/routes/workflow-definitions': {
      linesFound: 2522,
      linesHit: 2511,
      functionsFound: 524,
      functionsHit: 520,
    },
    'src/routes/workflows': {
      linesFound: 14966,
      linesHit: 14294,
      functionsFound: 3045,
      functionsHit: 2903,
    },
    'src/views': { linesFound: 376, linesHit: 376, functionsFound: 67, functionsHit: 67 },
    tests: { linesFound: 173, linesHit: 149, functionsFound: 24, functionsHit: 23 },
  },
};

const LINUX_BASELINE: CoverageBaseline = {
  // COR-1533 re-measured darwin only. The recorded Linux and darwin counts were identical at the
  // last measurement on both, so this carries the darwin counts until a Linux run records its own.
  measuredAt: '2026-10-19T18:00:00.000Z',
  overall: { linesFound: 62656, linesHit: 60795, functionsFound: 12349, functionsHit: 11984 },
  areas: {
    fixtures: { linesFound: 698, linesHit: 321, functionsFound: 69, functionsHit: 12 },
    scripts: { linesFound: 954, linesHit: 954, functionsFound: 68, functionsHit: 68 },
    src: { linesFound: 152, linesHit: 152, functionsFound: 26, functionsHit: 26 },
    'src/app': { linesFound: 3273, linesHit: 3206, functionsFound: 630, functionsHit: 612 },
    'src/lib': { linesFound: 2777, linesHit: 2762, functionsFound: 463, functionsHit: 459 },
    // COR-1532, measured on darwin: the agent editor's route, form, state, and revision history.
    'src/routes/agent-editor': {
      linesFound: 1447,
      linesHit: 1433,
      functionsFound: 332,
      functionsHit: 327,
    },
    'src/routes/agents': { linesFound: 641, linesHit: 641, functionsFound: 139, functionsHit: 138 },
    'src/routes/chat': { linesFound: 1306, linesHit: 1276, functionsFound: 265, functionsHit: 255 },
    'src/routes/dashboard': {
      linesFound: 1472,
      linesHit: 1236,
      functionsFound: 254,
      functionsHit: 230,
    },
    'src/routes/placeholder': { linesFound: 23, linesHit: 23, functionsFound: 4, functionsHit: 4 },
    'src/routes/reviews': {
      linesFound: 2204,
      linesHit: 2060,
      functionsFound: 440,
      functionsHit: 421,
    },
    'src/routes/schedules': {
      linesFound: 3678,
      linesHit: 3600,
      functionsFound: 791,
      functionsHit: 768,
    },
    'src/routes/storage': {
      linesFound: 2660,
      linesHit: 2637,
      functionsFound: 543,
      functionsHit: 532,
    },
    'src/routes/system': {
      linesFound: 10532,
      linesHit: 10497,
      functionsFound: 2106,
      functionsHit: 2076,
    },
    'src/routes/workers': {
      linesFound: 12913,
      linesHit: 12778,
      functionsFound: 2576,
      functionsHit: 2560,
    },
    // COR-1533, measured on darwin: the Workflows area's catalog, a type's page, its runs, and its editor.
    'src/routes/workflow-definitions': {
      linesFound: 2517,
      linesHit: 2506,
      functionsFound: 524,
      functionsHit: 520,
    },
    'src/routes/workflows': {
      linesFound: 14860,
      linesHit: 14188,
      functionsFound: 3028,
      functionsHit: 2886,
    },
    'src/views': { linesFound: 376, linesHit: 376, functionsFound: 67, functionsHit: 67 },
    tests: { linesFound: 173, linesHit: 149, functionsFound: 24, functionsHit: 23 },
  },
};

export const COVERAGE_BASELINES: Record<CoverageMeasurementPlatform, CoverageBaseline | null> = {
  darwin: DARWIN_BASELINE,
  linux: LINUX_BASELINE,
};
