import { $, Glob } from 'bun';

// Bun parses `bunfig.toml` natively when imported, so `coveragePathIgnorePatterns`
// stays a single source of truth (no hand-rolled TOML parse that could drift). The
// path resolves relative to THIS file, so it holds regardless of the invocation cwd.
import bunfig from '../bunfig.toml';
import { HANG_GUARD_MILLISECONDS } from './lib/hang-guard.ts';
// The package manifest supplies the `test` script's own exclusions, for the same reason
// `bunfig.toml` supplies the instrumentation ignores: one list, read where it is written.
import packageJson from '../package.json' with { type: 'json' };

type CoverageResult = {
  covered: boolean;
  lines: { total: number; hit: number; missed: number };
  functions: { total: number; hit: number; missed: number };
  uncoveredFiles: string[];
};

type FileCoverageResult = {
  covered: boolean;
  lines: { total: number; hit: number; missed: number };
  functions: { total: number; hit: number; missed: number };
};

type CoverageAllowance = {
  functions?: number;
  lines?: Set<number>;
  requireUncoveredLines?: boolean;
};

/**
 * The `workflow-event-feed.ts` lines Bun leaves uncovered on a given host. Linux on x64 misses
 * line 398 (the returned `subscribe` reference); macOS and linux/arm64 (the Dev Container on
 * Apple silicon, COR-1379) cover it, and the allowance's `requireUncoveredLines` would fail
 * them if it still named the line.
 */
export function workflowEventFeedUncoveredLines(platform: string, architecture: string): number[] {
  return platform === 'darwin' || architecture === 'arm64' ? [] : [398];
}

/**
 * What `scripts/benchmarks/memory-footprint.ts` leaves uncovered on a given platform: nothing on
 * macOS, and its macOS-only `proc_pid_rusage` FFI path everywhere else.
 */
export function memoryFootprintUncoveredOutsideDarwin(
  platform: string,
): Pick<CoverageAllowance, 'functions' | 'lines'> {
  if (platform === 'darwin') return { lines: new Set() };
  return { functions: 3, lines: new Set([36, 37, 38, 39, 40, 41, 45, 46, 47, 54, 79]) };
}

type DocumentedCoverageAllowance = CoverageAllowance & { reason: string };

type CoverageAllowanceEntry = readonly [path: string, allowance: DocumentedCoverageAllowance];

/**
 * Build one allowance layer from its raw entry array, failing loudly on a duplicate
 * key WITHIN the layer. A `new Map([...])` silently keeps only the last entry for a
 * repeated key, so a copy-paste duplicate inside a single literal would quietly drop
 * an allowance with no signal (this exact bug shipped mid-PR in #516). Keeping the
 * entries as a named array and asserting `length === unique keys` here turns that
 * silent drop into a build-time error naming the layer and key.
 */
export function buildAllowanceLayer(
  layerName: string,
  entries: ReadonlyArray<CoverageAllowanceEntry>,
): Map<string, CoverageAllowance> {
  const seen = new Set<string>();
  for (const [path] of entries) {
    if (seen.has(path)) {
      throw new Error(
        `Duplicate coverage-allowance key "${path}" within ${layerName}. ` +
          'A Map literal silently keeps only the last entry for a repeated key; ' +
          'merge the two entries into one so no allowance is dropped.',
      );
    }
    seen.add(path);
  }
  return new Map(entries);
}

type NamedAllowanceLayer = readonly [name: string, layer: ReadonlyMap<string, CoverageAllowance>];

/**
 * Assert that two refresh layers partition their keys: a key in BOTH means removing
 * its row from one layer silently re-activates the other layer's (often
 * stale-line-numbered) allowance — a silent gate flip. The two layers are passed by
 * direct reference rather than matched by name against the ordered layer list, so a
 * renamed or mistyped layer can never silently skip this check (which would defeat
 * the whole point: a guard against silent allowance failures must not itself fail
 * silently). Base/override layering against a refresh layer stays legal.
 */
function assertRefreshLayersPartitionKeys(
  first: NamedAllowanceLayer,
  second: NamedAllowanceLayer,
): void {
  const [firstName, firstLayer] = first;
  const [secondName, secondLayer] = second;
  for (const key of firstLayer.keys()) {
    if (secondLayer.has(key)) {
      throw new Error(
        `Coverage-allowance key "${key}" appears in both ${firstName} and ${secondName}. ` +
          'A key may live in at most one refresh layer, or removing one row silently ' +
          'reactivates the other layer’s (possibly stale) allowance.',
      );
    }
  }
}

/**
 * Assemble the final allowance map from its ordered layers (last layer wins for a
 * shadowed key — the intended base→override mechanic), after asserting the two
 * mutually-exclusive refresh layers partition their keys (see
 * {@link assertRefreshLayersPartitionKeys}).
 */
export function assembleAllowanceLayers(
  layers: ReadonlyArray<NamedAllowanceLayer>,
  refreshLayers: readonly [NamedAllowanceLayer, NamedAllowanceLayer],
): Map<string, CoverageAllowance> {
  assertRefreshLayersPartitionKeys(refreshLayers[0], refreshLayers[1]);
  const assembled = new Map<string, CoverageAllowance>();
  for (const [, layer] of layers) {
    for (const [key, allowance] of layer) {
      assembled.set(key, allowance);
    }
  }
  return assembled;
}

/**
 * Read `coveragePathIgnorePatterns` from `bunfig.toml`. A file matching one of these is
 * excluded from LCOV instrumentation entirely — it never appears as an `SF:` record — so
 * any allowance keyed to such a path is DEAD: it ignores nothing and its line numbers
 * silently drift as the file is edited, looking live while being inert (this is what
 * happened to the old `scripts/check-coverage.ts` self-allowance, dead since 501d14ef).
 * Reading the patterns from `bunfig.toml` keeps it the single source of truth rather than
 * hardcoding the list here.
 */
export function readCoveragePathIgnorePatterns(): string[] {
  const patterns = bunfig.test?.coveragePathIgnorePatterns;
  if (patterns === undefined) return [];
  if (
    !Array.isArray(patterns) ||
    patterns.some((pattern: unknown) => typeof pattern !== 'string')
  ) {
    throw new Error(
      'bunfig.toml [test].coveragePathIgnorePatterns must be an array of strings; ' +
        `got ${JSON.stringify(patterns)}.`,
    );
  }
  return patterns;
}

/**
 * Whether an allowance key (a repo-relative file path) would be excluded by a
 * `coveragePathIgnorePatterns` entry. Bun matches these patterns against LCOV file paths
 * as GLOBS — NOT substrings — so this uses {@link Glob} for every pattern. Verified
 * empirically (see the characterization test in `check-coverage.test.ts`): a bare
 * `nested` does NOT exclude `sub/nested-file.ts` (a substring matcher would wrongly flag
 * it — a false positive), while `*`, `?`, `[…]`, and `**` all behave as glob
 * metacharacters (a `*`-only matcher would miss `?`/`[…]` — a false negative). An exact
 * filename like `scripts/check-coverage.ts` is a glob with no metacharacters and matches
 * the literal path. Matching Bun exactly is the whole point: a mismatch produces either a
 * dead allowance that slips through or a live allowance wrongly rejected.
 */
function allowanceKeyMatchesIgnorePattern(key: string, pattern: string): boolean {
  return new Glob(pattern).match(key);
}

/**
 * Reject any allowance key that matches a `coveragePathIgnorePatterns` entry. Such a key
 * is a dead allowance — the file it names is never instrumented, so the allowance can
 * never fire — and worse, its line numbers drift silently as the file changes. This
 * closes the dead-allowance class systematically, the same way {@link buildAllowanceLayer}
 * (within-layer duplicates) and {@link assertRefreshLayersPartitionKeys} (cross-shadowed
 * refresh keys) close the duplicate / cross-shadow classes (#539).
 */
export function assertNoAllowanceKeyIsCoverageIgnored(
  allowances: ReadonlyMap<string, CoverageAllowance>,
  ignorePatterns: readonly string[],
): void {
  for (const key of allowances.keys()) {
    for (const pattern of ignorePatterns) {
      if (allowanceKeyMatchesIgnorePattern(key, pattern)) {
        throw new Error(
          `Coverage-allowance key "${key}" matches coveragePathIgnorePatterns entry ` +
            `"${pattern}" in bunfig.toml. That file is excluded from LCOV instrumentation, ` +
            'so the allowance is dead (it ignores nothing and its line numbers drift ' +
            'silently). Remove the allowance entry, or un-ignore the path in bunfig.toml.',
        );
      }
    }
  }
}

// Bun's per-test timeout for the coverage run: twice the hang guard, as `scripts/test-deadlines.ts`
// sets it for every other lane (this package cannot import the root scripts, so it computes its own).
const TEST_TIMEOUT_ARGUMENT = `--timeout=${2 * HANG_GUARD_MILLISECONDS}`;
const COVERAGE_FAILURE_OUTPUT_TAIL_BYTES = 16 * 1024 * 1024;
const COVERAGE_TEST_FILE_GLOBS = ['*test.ts', '*spec.ts'] as const;

function isGeneratedCoverageArtifact(filePath: string): boolean {
  // Bun records generated fixture paths relative to the coverage-run CWD, so worktree
  // depth changes the number of `../` segments and the temp root may be `var/folders/`,
  // `private/tmp/`, or `tmp/` (#503). The second matcher still gates this to known
  // fixture names, so a non-fixture temp file is not caught.
  if (
    /(?:\.\.\/)+(?:private\/)?(?:var\/folders\/|tmp\/)/.test(filePath) &&
    /(?:\/weft-(?:schedule(?:-lmdb)?-(?:workflows|input)|cli-edge-workflows)-[^/]+(?:\.ts|\/module\.ts)$|\/weft-validate-[^/]+\/[^/]+\.ts$|\/weft-validate-(?:json-invalid|mixed-(?:clean|invalid)|multi-[ab])-[^/]+\.ts$)/.test(
      filePath,
    )
  ) {
    return true;
  }

  return false;
}

function createLineSet(startLine: number, endLine: number): Set<number> {
  return new Set(
    Array.from({ length: endLine - startLine + 1 }, (_value, index) => startLine + index),
  );
}

function createMergedLineSet(...lineSets: Array<Set<number>>): Set<number> {
  return new Set(lineSets.flatMap((lineSet) => [...lineSet]));
}

const BASE_COVERAGE_ALLOWANCES = buildAllowanceLayer('BASE_COVERAGE_ALLOWANCES', [
  [
    'scripts/generate-operation-client.ts',
    {
      reason:
        'Bun reports one function miss in this file. The CLI body is `runGenerateOperationClientCommand`, which the tests run in process (COR-1459), so its lines are covered and no line allowance remains; the one-line `import.meta.main` entry is reported as hit.',
      functions: 1,
    },
  ],
  [
    'scripts/check-implementation-file-sizes.ts',
    {
      reason:
        'Bun reports one function miss in this file with every line hit. The CLI body is `runCli`, which the tests run in process, and the one-line `import.meta.main` entry is reported as hit, so no line allowance remains.',
      functions: 1,
    },
  ],
  [
    'scripts/benchmarks/benchmark-subprocess.ts',
    {
      reason:
        'Malformed child-process benchmark payloads are defensive failures; exercising them would require replacing the real benchmark subprocess protocol. Realigned for corvidae: the file lives under `scripts/benchmarks/` here (upstream: `src/benchmarks/`) and is reformatted, so the three defensive-throw bodies fall at lines 28-29 (`result.exitCode !== 0`), 38 (`lastOutputLine === undefined`), and 43 (`!validateMeasurement(parsed)`) instead of upstream’s 49, 50, 59, 64.',
      lines: new Set([28, 29, 38, 43]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/core/engine/broadcast.ts',
    {
      reason:
        'The remaining listener-disposal branch is timing-dependent cleanup after a broadcast subscriber has already detached.',
      lines: new Set([46]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/core/schedule/cron-formatter.ts',
    {
      reason:
        'Bun reports an aggregate formatter function miss even though valid cron fields and every invalid-field diagnostic are covered.',
      functions: 1,
      lines: new Set([185, 187]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/core/scheduler/duration.ts',
    {
      reason:
        'The remaining duration branches reject values outside JavaScript safe-integer bounds that the public scheduler schema already excludes.',
      lines: new Set([38, 39, 40, 91]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/core/inline-execution-strategy.ts',
    {
      reason:
        'Bun reports one unnamed aggregate function miss in this class module despite complete line coverage and direct strategy tests.',
      functions: 1,
    },
  ],
]);

const COVERAGE_ALLOWANCE_OVERRIDES = buildAllowanceLayer('COVERAGE_ALLOWANCE_OVERRIDES', [
  [
    'src/core/engine/callback-creators.ts',
    {
      reason:
        'Bun reports an unnamed callback-closure miss after the callback factory paths are exercised through engine integration tests.',
      functions: 1,
    },
  ],
  [
    'src/core/engine/queries.ts',
    {
      reason:
        'The remaining query-registry line is a defensive missing-handler branch after registration and teardown behavior is covered.',
      lines: new Set([17]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/core/interceptor/index.ts',
    {
      reason:
        'The uncovered interceptor fallback rejects a malformed chain result that correctly typed interceptors cannot produce.',
      functions: 1,
      lines: new Set([25, 26, 27]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/server/authorization.ts',
    {
      reason:
        'The residual authorization branch handles an operation catalog entry without a declared access policy, which catalog validation forbids.',
      lines: new Set([159]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/server/json-rpc-websocket.ts',
    {
      reason:
        'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths (the emit() catch-block’s emitterBroken = true, line 117). Realigned for corvidae from a fresh coverage/lcov.info (COR coverage-gate adoption): corvidae additionally carries a defensive branch upstream does not (lines 219-225) that rejects a subscription-start result whose envelope shape is not isSubscriptionStartEnvelope() and reports an internal error instead of proceeding — every current caller only ever constructs a well-formed envelope, so no test manufactures the malformed shape needed to reach it.',
      functions: 2,
      lines: new Set([117, 219, 220, 221, 222, 223, 224, 225]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/server/stdio-session.ts',
    {
      reason:
        'Bun maps framing-loop exits and one aggregate adapter function as uncovered although oversize, resynchronization, partial-frame, and writer-close behavior is tested.',
      functions: 1,
      lines: new Set([353, 390]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/service-worker/setup.ts',
    {
      reason:
        'Browser and worker-runtime behavior is exercised outside the Bun LCOV process, which cannot attribute these remaining paths.',
      functions: 1,
    },
  ],
  [
    'src/storage/auto.ts',
    {
      reason:
        'Driver and runtime-specific behavior cannot be attributed in the default Bun LCOV process; fresh coverage confirms only these residual misses. Realigned for corvidae from a fresh coverage/lcov.info (COR coverage-gate adoption): upstream’s coordinates no longer matched corvidae’s file.',
      lines: new Set([107, 109]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/storage/resolve.ts',
    {
      reason:
        'Driver and runtime-specific behavior cannot be attributed in the default Bun LCOV process; fresh coverage confirms only these residual misses. Realigned for corvidae from a fresh coverage/lcov.info (COR coverage-gate adoption), superseding the prior WFT-138 re-derivation: upstream’s coordinates no longer matched corvidae’s file.',
      functions: 5,
      lines: new Set([
        58, 59, 60, 61, 62, 67, 68, 69, 70, 71, 75, 82, 84, 85, 86, 88, 94, 96, 97, 98, 100, 101,
        102, 117, 118, 119, 120, 149, 157, 182, 203, 210, 211, 212, 213, 254, 255, 256, 257, 258,
        259,
      ]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/storage/web-extension.ts',
    {
      reason:
        'Browser and worker-runtime behavior is exercised outside the Bun LCOV process, which cannot attribute these remaining paths.',
      functions: 3,
    },
  ],
]);

// Keep the fresh mainline coverage refresh separate from the historical base
// allowances so line-movement updates are mechanically reviewable and do not
// create duplicate keys inside a single Map literal.
const CURRENT_MAIN_COVERAGE_ALLOWANCE_OVERRIDES = buildAllowanceLayer(
  'CURRENT_MAIN_COVERAGE_ALLOWANCE_OVERRIDES',
  [
    [
      'src/client/http-handle.ts',
      {
        reason:
          'Bun reports one generated handle callback as missed although HTTP handle result and metadata paths are covered through transport-contract tests.',
        functions: 1,
      },
    ],
    [
      'src/client/http-schedule-handle.ts',
      {
        reason:
          'Bun reports one generated schedule-handle callback as missed although schedule operations are covered through transport-contract tests.',
        functions: 1,
      },
    ],
    [
      'src/core/context/durable-activity.ts',
      {
        reason:
          'The AsyncLocalStorage-unavailable fallback runs in portability subprocesses, whose hits Bun does not merge into the parent LCOV report.',
        functions: 3,
        lines: new Set([
          124, 145, 146, 147, 148, 158, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174,
          175, 176, 177, 178, 182, 183, 184, 185, 189, 190, 191, 192, 193, 194, 260, 261, 262, 264,
          265,
        ]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/context/parallel-operations.ts',
      {
        reason:
          'The remaining coordinator branches reject impossible nested-settlement states after race, all, and speculative paths are behaviorally covered.',
        lines: new Set([19, 20, 21, 31, 37, 38, 39]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/context/run-operation.ts',
      {
        reason:
          'Bun leaves the generator loop closing line cold after the final retry and catch paths settle, despite direct retry-state coverage.',
        lines: new Set([459]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/review-list-entries.ts',
      {
        reason:
          'The remaining review-list branch protects against a persisted review status excluded by the decoded state schema.',
        lines: new Set([120]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/types/definition-schema-to-json.ts',
      {
        reason:
          'The optional Valibot converter resolution failure is exercised without the dependency in a child process whose hits are not merged into parent Bun LCOV.',
        lines: new Set([189, 190, 191, 194, 195]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/realm/__fixtures__/workflow-implementation.fixture.ts',
      {
        reason:
          'Test-only stand-in for a workflow implementation module (COR-249), imported by revision-realm-worker-entry.ts. Its constant and its one function execute inside a spawned Worker thread when a real turn is dispatched and released (worker-realm.test.ts), and Bun does not merge Worker-thread execution hits into the parent process LCOV report — the same class of gap this file already documents for genuine child-process execution elsewhere (confirmed directly: a full-suite run reports FNF:1/FNH:0 and DA:0 for lines 19-21 for this file — line 20 is the blank line between the const and function declarations, which Bun still emits a DA: record for).',
        lines: new Set([19, 20, 21]),
        functions: 1,
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/realm/revision-realm-registry.ts',
      {
        reason:
          "Every one of this file's 12 functions is exercised by revision-realm-registry.test.ts (including markActive and dispose, added specifically to close this gap), and a full-suite coverage run confirms 100% LINE coverage for this file (no DA:0 lines remain) — the file-level LINE total in the coverage summary already reflects that. Despite this, the same run's FNH (11) is one short of FNF (12): the same 'Bun's LCOV FNH undercounts a function whose every line is otherwise hit' artifact already documented elsewhere in this registry (see get-task-diagnostics.ts's entry below, and the NoConditionalBatchStorage precedent in workflow-visibility-backfill.test-support.ts) — not reproduced by running this file's own test in isolation (100% functions there too), only by the full suite's exact combination of files, matching that precedent's own description of the artifact shifting by process composition.",
        functions: 1,
      },
    ],
    [
      'src/core/realm/worker-realm.ts',
      {
        reason:
          "The `messageerror` listener (COR-249) delegates to the exact same `#handleWorkerFailure` a real Worker `error` event already exercises end to end (worker-realm.test.ts's throwing-worker and timeout tests) — its registration statement is unreached as a LINE (358, shifted from 324 by COR-246's `close`-event/`whenReclaimed` reclamation proof, itself shifted from 292 by COR-113's idempotent-termination hardening) and its callback is unreached as a FUNCTION. `messageerror` fires when structured-clone deserialization fails on the RECEIVING side; a `postMessage` call with a non-cloneable payload throws synchronously on the SENDING side instead (`DataCloneError`, confirmed directly against Bun 1.4.2), so there is no reliable, non-flaky way to manufacture the receiving-side failure from a test. A fresh full-suite lcov confirms the specific line the `error` listener's own textually-identical `this.#handleWorkerFailure();` call site sits on (the callback body, one line below the registration) reports nonzero hits despite `messageerror` itself never firing — the same 'Bun's LCOV attributes a hit count to the wrong source line for one of two textually-identical call-expression statements' class of artifact already documented for revision-realm-registry.ts's entry above and elsewhere in this registry — so the registration line, not the callback body line, is this allowance's stable target. A full-suite run's FNF/FNH is two short, not one: the second is the sibling 'Bun's LCOV FNH undercounts a fully line-covered function' artifact, not reproduced when this file's own tests run in isolation (only the messageerror gap shows there).",
        lines: new Set([358]),
        functions: 2,
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/realm/child-process-realm.ts',
      {
        reason:
          "A fresh full-suite coverage run reports 100% LINE coverage for this file (every DA: record has a nonzero hit count — child-process-realm.test.ts and realm-conformance.test.ts together exercise the ready handshake, digest mismatch, dispatch/release/failure, crash/terminate/discard, restart, the spawn-epoch stale-restart guard, and reclamation) but FNH is one short of FNF, with no `FNDA:0,` entry anywhere in the file's record. The same 'Bun's LCOV FNH undercounts a function whose every line is otherwise hit' artifact already documented for revision-realm-registry.ts's and revision-realm-execution-strategy.ts's entries above.",
        functions: 1,
      },
    ],
    [
      'src/core/worker-checkpoint-resume-state.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 1,
      },
    ],
    [
      'src/core/worker-execution-strategy.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 2,
      },
    ],
    [
      'src/mcp/resources.ts',
      {
        reason:
          'Bun maps the workflow-resource parser closing brace as uncovered after the direct state-URI parsing assertion executes its return path (187); the exhaustive default for an unknown ParsedResourceUri kind is separately unreachable through the validated URI parser, which only ever produces one of the declared kinds (126-129).',
        lines: new Set([126, 127, 128, 129, 187]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/mcp/stdio.ts',
      {
        reason:
          'Bun reports one unnamed aggregate function in the stdio session although its admission, serving, frame-limit, drain, and failure paths are each asserted by stdio.test.ts.',
        functions: 1,
      },
    ],
    [
      'src/mcp/server.ts',
      {
        reason:
          'A resource-update notification that the SDK fails to send is reported from a promise rejection handler (275); the connection check before it leaves only a transport that closes between the check and the send, which no test can schedule deterministically.',
        functions: 1,
        lines: new Set([275]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/mcp/search-subscriptions.ts',
      {
        reason:
          'Bun reports two unnamed aggregate functions although search-subscriptions.test.ts drives every tracking, release, cancellation, and stream-error path.',
        functions: 2,
      },
    ],
    [
      'src/server/api-catalog.ts',
      {
        reason:
          'The remaining catalog lines reject inconsistent operation metadata that the statically declared catalog does not contain.',
        lines: new Set([161, 162, 166, 167, 169, 170, 171, 172, 174, 176]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/server/json-rpc-dispatch.ts',
      {
        reason:
          'The remaining dispatch lines guard a catalog operation without a JSON-RPC binding, which registration validation excludes.',
        lines: new Set([200, 201]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/testing/fake-timers.test-support.ts',
      {
        reason:
          'The remaining fake-timer line is the defensive error for a timer identifier not created by this test harness.',
        lines: new Set([244]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/testing/storage-backends.test-support.ts',
      {
        reason:
          'Driver and runtime-specific behavior cannot be attributed in the default Bun LCOV process; fresh coverage confirms only these residual misses.',
        lines: new Set([72, 73, 74]),
        requireUncoveredLines: true,
      },
    ],
  ],
);

const CURRENT_MAIN_COVERAGE_ALLOWANCE_REFRESH = buildAllowanceLayer(
  'CURRENT_MAIN_COVERAGE_ALLOWANCE_REFRESH',
  [
    [
      'examples/order-processing/src/client.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        functions: 1,
        lines: new Set([
          13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
          36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57,
          58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 73, 77, 78, 79, 80, 81, 82, 83,
          84, 85, 86, 87, 88, 89, 90, 91, 92,
        ]),
        requireUncoveredLines: true,
      },
    ],
    [
      'scripts/benchmarks/workflow-starts-runner.ts',
      {
        reason:
          'The throughput benchmark runs in a fresh Bun subprocess, and Bun does not propagate that child execution into parent-process LCOV. Realigned for corvidae from a fresh coverage/lcov.info (COR coverage-gate adoption): the file lives under `scripts/benchmarks/` here (upstream: `src/benchmarks/`) and is reformatted, so the allowed lines no longer matched upstream’s coordinates.',
        functions: 1,
        lines: new Set([
          28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
          50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71,
          72, 73, 74, 75, 76, 82, 83, 84, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 98, 99,
        ]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/cli/utilities.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        lines: new Set([127]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/context/speculative-child.ts',
      {
        reason:
          'The remaining speculative-child branch guards a settlement state that the speculation coordinator prevents.',
        lines: new Set([25]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/callback-creators-core.ts',
      {
        reason:
          'Bun reports callback-wrapper function misses although the core callback bundles are exercised through engine lifecycle tests.',
        functions: 2,
      },
    ],
    [
      'src/core/engine/callback-creators-router-registry.ts',
      {
        reason:
          'The remaining router-registry lines reject a callback route omitted from the complete internal route table.',
        lines: new Set([26, 27, 29]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/termination/finalizer-claim.ts',
      {
        reason:
          'Bun reports the lease-loss closure as missed although finalizer claim success, contention, and deposition are behaviorally tested.',
        functions: 1,
      },
    ],
    [
      'src/core/schedule/cron-occurrence.ts',
      {
        reason:
          'The residual cron-occurrence line handles an invalid calendar rollover excluded by validated cron fields.',
        lines: new Set([217]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/worker-execution-ownership.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 1,
      },
    ],
    [
      'src/core/worker-listener-registry.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 1,
      },
    ],
    [
      'src/core/worker-protocol.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 2,
      },
    ],
    [
      'src/server/operations/get-workflow-result.ts',
      {
        reason:
          'Bun reports the terminal-result callback as missed although successful, failed, and missing workflow results are covered through operation tests.',
        functions: 1,
      },
    ],
    [
      'src/server/workflow-event-feed.ts',
      {
        reason:
          'Bun maps the returned subscribe reference and no-op dispose body inconsistently across platforms even though both are exercised by the feed tests.',
        lines: new Set(workflowEventFeedUncoveredLines(process.platform, process.arch)),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/storage/durability/adapter-spec.test-support.ts',
      {
        reason:
          'Driver and runtime-specific behavior cannot be attributed in the default Bun LCOV process; fresh coverage confirms only these residual misses. Realigned for corvidae from a fresh coverage/lcov.info (COR coverage-gate adoption): upstream’s coordinates no longer matched corvidae’s file.',
        functions: 5,
        lines: new Set([
          36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191,
          192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 219, 220, 221, 222, 223, 304,
        ]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/storage/indexeddb-fault-harness.test-support.ts',
      {
        reason:
          'Browser and worker-runtime behavior is exercised outside the Bun LCOV process, which cannot attribute these remaining paths.',
        functions: 2,
      },
    ],
    [
      'src/storage/indexeddb.ts',
      {
        reason:
          'Browser and worker-runtime behavior is exercised outside the Bun LCOV process, which cannot attribute these remaining paths.',
        functions: 1,
      },
    ],
    [
      'src/worker/registry/fair-share.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 1,
      },
    ],
    [
      'src/worker/long-poll.ts',
      {
        reason:
          'Focused LCOV for src/worker/long-poll.test.ts reports 100% line coverage for long-poll.ts and FNF/FNH 39/38, while emitting no FN/FNDA function identity records for this file; every branch and public accessor is covered by the long-poll worker tests, so this is the same Bun FNH undercount artifact documented for other fully line-covered files.',
        functions: 1,
      },
    ],
    [
      'src/testing/scheduler-contract.test-support.ts',
      {
        reason:
          'Bun reports a callback in the shared scheduler contract harness as missed although each adapter executes the contract assertions.',
        functions: 7,
      },
    ],
    [
      'src/server/json-rpc-websocket-client.test-support.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 2,
        lines: new Set([97, 98, 112, 116, 127, 135, 140, 145, 150]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/testing/subprocess-engine.ts',
      {
        reason:
          'Subprocess-engine startup and failure paths run in child Bun processes whose hits are not merged into the parent LCOV report. Realigned for corvidae from a fresh coverage/lcov.info (COR coverage-gate adoption): upstream’s coordinates no longer matched corvidae’s file.',
        functions: 7,
        lines: new Set([
          127, 128, 129, 130, 131, 147, 148, 149, 242, 243, 244, 245, 246, 247, 248, 270, 276, 402,
          403, 404, 405, 406, 407, 408, 409,
        ]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/testing/worker-fault-injection-frames.test-support.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 2,
        lines: new Set([
          13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34,
          35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56,
          57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78,
          79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100,
          101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118,
          119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136,
          137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154,
          155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172,
          173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190,
          191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208,
          209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225,
        ]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/testing/worker-fault-injection.test-support.ts',
      // Realigned for corvidae from a fresh coverage/lcov.info (COR coverage-gate adoption):
      // corvidae's copy carries more never-invoked fault-injection helpers than upstream's
      // (the missed-function count is unchanged at 15, so this is a pure line-set expansion,
      // not new dead functions), so the allowed range grew from upstream's 91 lines to 122.
      //
      // Realigned again (COR-235): `nextServerMessage`'s `NextServerMessageOptions` type and
      // `waitForServerMessage`'s "omitted `timeoutMs` installs no timer" branch added 10 lines
      // before line 48 and a further 6 lines inside the (still-never-fired) timeout callback
      // starting at old line 289 — net +10 through old line 288, +16 from old line 289 on. Every
      // one of the 122 coordinates below is the corresponding OLD coordinate plus that offset,
      // confirmed against a fresh coverage/lcov.info generated after this edit (each new
      // coordinate carries a genuine zero hit count; none regressed to newly covered or to a
      // non-`DA:` line). The missed-function count is unchanged at 15 — this file gained no new
      // functions, only the one already-present `waitForServerMessage` grew by 6 lines.
      //
      // Line 286, the closing brace of `if (predicate(candidate))` in the `inboundBuffer` scan
      // of `waitForServerMessage`, is deliberately NOT allowed. Bun attributes the pass-over of
      // a buffered non-matching message (the fall-through to the next iteration) to that brace,
      // and the loop-exit path to line 287. No other suite deterministically buffers a
      // non-matching message ahead of a waiter, so the line was covered in some runs and not in
      // others, and an allowance for it failed the gate whenever it was covered.
      // `worker-fault-injection.test.ts` now passes over a buffered message on every run, so
      // the line is deterministically covered.
      //
      // Line 307, the rejection inside `waitForServerMessage`'s timeout callback, is allowed: the
      // callers that once passed `timeoutMs` and let it elapse no longer set a wall-clock budget
      // (load-proof tests), so no suite runs the callback.
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 15,
        lines: new Set([
          100, 115, 116, 117, 118, 126, 127, 128, 159, 160, 161, 162, 163, 164, 165, 166, 171, 172,
          173, 174, 217, 218, 219, 220, 244, 250, 256, 257, 258, 259, 260, 265, 266, 267, 305, 306,
          307, 313, 314, 315, 316, 317, 318, 319, 320, 321, 322, 323, 324, 325, 326, 327, 328, 329,
          330, 331, 332, 333, 334, 335, 336, 337, 338, 339, 340, 341, 342, 343, 344, 345, 346, 347,
          348, 349, 350, 351, 352, 371, 372, 379, 383, 397, 398, 404, 409, 410, 417, 418, 419, 420,
          421, 422, 423, 424, 425, 426, 427, 428, 429, 431, 440, 441, 447, 448, 453, 454, 467, 468,
          469, 470, 471, 472, 476, 477, 478, 479, 480, 484, 485, 486, 487, 488,
        ]),
        requireUncoveredLines: true,
      },
    ],
  ],
);

const CURRENT_BRANCH_COVERAGE_ALLOWANCE_REFRESH = buildAllowanceLayer(
  'CURRENT_BRANCH_COVERAGE_ALLOWANCE_REFRESH',
  [
    [
      'examples/remote-worker/src/index.ts',
      {
        reason:
          'Three distinct unreachable classes, none a test gap: (1) lines 30-32, the body of formatGreetingRemotely.execute, are unreachable by design — activityExecution.mode is "remote" has no local-fallback branch at all, so the engine never calls this local implementation, the same invariant COR-154’s zero-invocation spy tests assert elsewhere in this package; (2) lines 80 and 95 are defensive validation the example’s own happy-path fixture (remote-worker.test.ts) never violates — isGreetingInput always accepts the fixture’s well-formed input, and the remote worker always returns a string, so triggering either throw would mean injecting a malformed wire payload past RemoteWorker’s own contract, not exercising this example; (3) lines 106-107, the `if (import.meta.main)` CLI entry point, only run when this file is spawned directly (remote-worker.test.ts’s second test does this via `Bun.spawn`), and that child process’s hits are not attributed to the parent Bun LCOV report — the same class of gap already documented for examples/order-processing/src/client.ts and src/server.ts above and examples/hello-world/src/index.ts in TARGET_ONLY_COVERAGE_ALLOWANCES.',
        functions: 1,
        lines: new Set([30, 31, 32, 80, 95, 106, 107]),
        requireUncoveredLines: true,
      },
    ],
    [
      'examples/order-processing/src/server.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        functions: 1,
        lines: new Set([12, 13, 14, 15, 16, 17, 18, 19, 20, 23, 24, 25, 26, 27, 28, 30, 32]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/cli/api-arguments.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report. Realigned for corvidae from a fresh coverage/lcov.info (COR coverage-gate adoption): upstream’s coordinates no longer matched corvidae’s file.',
        lines: new Set([61]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/cli/codegen.ts',
      {
        reason:
          'Filesystem/network edge cases unreachable through the public --from/--server path: an OS-level rename failure (and its best-effort temp-file cleanup), a parent path that exists but is not a directory, resolveConnection() rethrowing something other than ConnectionConfigurationError, AbortSignal.timeout() producing anything but a TimeoutError, composeRegistryUrl() throwing on a URL resolveConnection() already validated, and emitRegistryDeclaration() throwing something other than CodegenEmitError. Realigned for corvidae from a fresh coverage/lcov.info (COR coverage-gate adoption): confirmed each of these six branches still exists at the new coordinates; only the line numbers moved.',
        functions: 1,
        lines: new Set([
          81, 82, 83, 84, 85, 174, 175, 224, 269, 270, 294, 325, 326, 327, 329, 330, 331, 332,
        ]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/cli/json-input.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        functions: 1,
      },
    ],
    [
      'src/cli/noun-verb-arguments.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report. Realigned for corvidae from a fresh coverage/lcov.info (COR coverage-gate adoption): upstream’s coordinates no longer matched corvidae’s file.',
        lines: new Set([163]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/cli/output.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        functions: 5,
      },
    ],
    [
      'src/cli/server-client.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report. Realigned for corvidae from a fresh coverage/lcov.info (COR coverage-gate adoption): upstream’s coordinates no longer matched corvidae’s file.',
        lines: new Set([63, 64, 74]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/cli/server-commands.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report. Realigned for corvidae from a fresh coverage/lcov.info (COR coverage-gate adoption): upstream’s coordinates no longer matched corvidae’s file.',
        lines: new Set([79, 80, 81, 82, 83, 167, 168]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/cli/storage-factory.ts',
      {
        reason:
          'Exhaustive default for an unknown storage backend is unreachable through the validated CLI/API surface; no caller can construct an invalid StorageBackend.',
        lines: new Set([21, 22, 23, 24]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/cli/tail.ts',
      {
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        functions: 3,
        lines: new Set([101]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/cli/workflow-commands.ts',
      {
        reason:
          'Exhaustive default for an unknown WorkflowCommand action is unreachable through the validated CLI parser, which only ever produces one of the declared actions.',
        lines: new Set([55, 56, 57, 58]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/client/client-contract.test-support.ts',
      {
        reason:
          'Bun reports unnamed callbacks in this shared contract harness despite direct coverage of query, update, signal, async-activity, and event-wait paths.',
        functions: 3,
      },
    ],
    [
      'src/client/event-stream-transport.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        lines: new Set([153]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/client/event-stream.test-support.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 1,
      },
    ],
    [
      'src/client/event-stream.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 1,
      },
    ],
    [
      'src/client/local-event-tail.ts',
      {
        reason:
          'The remaining local-tail lines are listener teardown after terminal settlement, covered behaviorally but not mapped by Bun to the closing callback.',
        functions: 2,
        lines: new Set([168, 169]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/connection.ts',
      {
        reason:
          'sameDestination()’s catch-block fallback (`return a === b;`) runs only when `new URL()` throws for at least one of the two server strings being compared — every current caller passes an already-validated URL, so no test constructs the malformed string needed to reach the parse failure. Realigned for corvidae from a fresh coverage/lcov.info (COR coverage-gate adoption): the branch now falls at line 218 instead of upstream’s 220.',
        lines: new Set([218]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/compression.ts',
      {
        reason:
          'Exhaustive default for an unknown CompressionAlgorithm is unreachable through the validated engine/CLI surface, which only ever selects one of the declared algorithms.',
        lines: new Set([197, 198, 199]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/anonymous-signal-sequence.ts',
      {
        reason:
          'Bun reports sequence-update closures as missed although initialization, increment, overflow, and persistence behavior is covered.',
        functions: 2,
      },
    ],
    [
      'src/server/handler/auth-context-principal.ts',
      {
        reason:
          'Exhaustive default for an unknown AuthContext method is unreachable through the authenticator surface, which only ever produces one of the declared AuthMethod values.',
        lines: new Set([53, 54, 55]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/server/json-rpc-http.ts',
      {
        reason:
          'Exhaustive default for an unknown DispatchJsonRpcResult kind is unreachable through the dispatch pipeline, which only ever produces one of the declared result kinds.',
        lines: new Set([142, 143, 144]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/server/operation-catalog/workflow-adapter.ts',
      {
        reason:
          'corvidae’s copyAccessPolicy() deep-copies each AccessPolicy variant (lines 184-188 ’scoped’, 192-193/196-200/204-205 ’optionalAuth’ and the remaining variants) so a caller cannot mutate the catalog’s stored policy through a returned copy; every variant’s shape is fixed by the catalog definitions passed to registerOperations(), which the current fixtures only exercise with a narrow subset of variants, leaving the others’ copy branches unreached without a test that registers a catalog naming every variant.',
        lines: new Set([184, 185, 186, 187, 188, 192, 193, 196, 197, 198, 199, 200, 204, 205]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/server/runtime/websocket-upgrade.ts',
      {
        reason:
          'Exhaustive default for an unknown WebSocket connectionType is unreachable through the upgrade handshake, which only ever assigns one of the declared connection types.',
        lines: new Set([150, 151, 152]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/revision-realm-execution-construction.ts',
      {
        // `buildRevisionRealmExecutionStrategyBundle()`'s own doc marks this
        // exact branch defensive: its sole caller (`createExecutionStrategyBundle`)
        // always derives `revisionRealmExecution` from
        // `resolveRevisionRealmExecutionForMode(options, workflowExecutionMode)`,
        // which already throws whenever `workflowExecutionMode === 'realm'` and
        // `options.revisionRealmExecution` is missing — the only way this
        // function's own `workflowExecutionMode !== 'realm'` check above has
        // already passed AND `revisionRealmExecution` is still null is to call
        // it directly with mismatched arguments, the same class of guard already
        // allowed for `dynamic-source-execution.ts`'s "Unreachable in practice"
        // entry above.
        reason:
          "Defensive fail-loud guard for an invariant resolveRevisionRealmExecutionForMode() itself guarantees when called with the same workflowExecutionMode; has no reachable runtime path to test without calling this function directly with mismatched arguments (COR-249's engine integration, R2E).",
        lines: new Set([78, 79, 80]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/realm/revision-realm-execution-strategy.ts',
      {
        reason:
          "Realigned after COR-249's cancel-while-parked #inFlight fix (R2E correction round 2). The prior entry's lines: new Set([96, 97, 98, 99]) never actually matched outboundFailure()'s own multi-line signature in any revision checked here — that signature sits four lines below (100-103 before this round's edit, 107-110 after), and 96-99 fell on the preceding interface's closing property/brace instead, which is why the allowance's requireUncoveredLines check never fired: those line numbers carry no `DA:` records at all (type-only declarations), so the parser's `ignoredLines?.has(lineNumber)` check simply never matched them. A fresh full-suite lcov for the file as it stands now (post-fix) shows zero lines with a zero hit count anywhere in the file, including outboundFailure()'s actual signature at 107-110, so no line-level exclusion is needed at all and the stale entry is dropped rather than re-pointed. Only the OTHER previously-documented artifact still reproduces: a full-suite run's FNF/FNH (19/18) is one short, the same 'Bun's LCOV FNH undercounts a function whose every line is otherwise hit' artifact documented for revision-realm-registry.ts's and worker-realm.ts's entries above — not reproduced when only this file's own tests run.",
        functions: 1,
      },
    ],
  ],
);

// The two refresh layers are mutually exclusive: a key may live in at most one,
// otherwise removing its row silently reactivates the other's (possibly stale)
// allowance. Bind them once and pass the SAME references both into the ordered
// merge list and into the exclusivity check, so the guarded pair can never drift
// from the layers actually assembled.
const AUDIT_BACKLOG_COVERAGE_ALLOWANCE_TOP_OFFS = buildAllowanceLayer(
  'AUDIT_BACKLOG_COVERAGE_ALLOWANCE_TOP_OFFS',
  [
    [
      'src/conformance/run-conformance.ts',
      {
        reason:
          'The shared conformance check sequence (COR-1365 moved it here from `src/cli/conformance.ts`, which carried this allowance at lines 91/158/239). Only the three defensive dispatch/cancel/shutdown failure throws remain uncovered: a sandbox server that refuses a dispatch, refuses to record a cancellation it was just handed, or loses the worker it just registered is not something any conformance fixture can produce.',
        lines: new Set([151, 249, 335]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/conformance/harness.ts',
      {
        reason:
          "Process lifecycle and observation primitives for the shared conformance check sequence (moved from `src/cli/conformance-harness.ts` by COR-1365; its import block grew by six lines, so every line below shifted by six). `waitForCondition`'s catch clause is never exercised because no predicate in the passing conformance fixtures throws, and the disconnected-worker/registry-empty throws in `waitForRegisteredWorker`/`waitForReplacementWorker`/`waitForWorkerHeartbeat` are defensive failure paths no passing conformance run reaches.",
        functions: 1,
        lines: new Set([51, 105, 127, 140, 150, 167]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/cli/parse-schedule-arguments.ts',
      {
        // WFT-20's own `--revision-policy` unit tests now exercise
        // `parseScheduleArguments`'s 'create' branch in-process, so the
        // OUTER `if (values.every !== undefined) {` check (line 217) itself
        // is genuinely covered now, as is the cron-positional `else` branch
        // (224-230) — only the `--every`-with-exactly-one-positional
        // branch's own `assertExactSchedulePositionals(...)` call body
        // (218-223) remains untested, since no test exercises `create`
        // with `--every` and exactly one positional.
        reason:
          'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
        lines: new Set([218, 219, 220, 221, 222, 223]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/context/child-workflow-pipe.ts',
      {
        reason:
          'The remaining pipe branches handle simultaneous child settlement and parent cancellation races covered at the coordinator boundary.',
        lines: new Set([46, 48, 49, 66, 67, 105, 119, 120, 126, 128, 129, 130, 131, 133, 134]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/context/version-patching.ts',
      {
        reason:
          'The residual version-patching lines reject inconsistent patch records that valid checkpoint construction cannot emit.',
        lines: new Set([30, 31, 32, 51, 56, 62, 78, 79, 80]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/storage/lazy-postgres-pool.ts',
      {
        reason:
          'Driver and runtime-specific behavior cannot be attributed in the default Bun LCOV process; fresh coverage confirms only these residual misses.',
        functions: 1,
      },
    ],
    [
      'src/storage/http.ts',
      {
        reason:
          'Driver and runtime-specific behavior cannot be attributed in the default Bun LCOV process; fresh coverage confirms only these residual misses.',
        functions: 1,
        lines: new Set([238]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/attributes-tags.ts',
      {
        reason:
          'The remaining attribute-tag branches reject decoded value shapes excluded by search-attribute boundary validation.',
        functions: 1,
        lines: new Set([279, 280, 282]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/callback-creators-bundles.ts',
      {
        reason:
          'Bun reports one callback-bundle closure as missed although each bundle is exercised through engine lifecycle integration tests.',
        functions: 1,
      },
    ],
    [
      'src/core/engine/catalog-removal.ts',
      // The closed WorkflowCatalogRemovalOutcome union (from
      // core/catalog/removal.ts) makes this default branch (removeWorkflowRevision's
      // switch) unreachable at runtime without an unsafe cast; it exists
      // solely as a compile-time exhaustiveness guard, matching the
      // identical pattern already allowed for
      // `server/runtime/task-ledger-recovery.ts`'s switch. `requireUncoveredLines`
      // is intentionally omitted for the same reason it is omitted there:
      // the case-label/brace lines around it flip between hit and unhit
      // run to run with byte-identical source — a coverage-attribution
      // artifact, not a real reachability signal — so the whole
      // `default: { ... }` block is allowed, not just the two dead
      // statements inside it. Lines realigned to 213-215 by the WFT-15/16
      // dynamic-source-execution and early-inFlightStarts-reservation
      // additions above this function. Lines realigned to 231-233 by the
      // WFT-17 `resolvedRevision` field and updated JSDoc added above this
      // function. Lines realigned to 267-270 by the WFT-17 removal-race
      // fix's `WorkflowRevisionRecord` import and the `finalizeRevisionRemoval()`
      // extraction (Codex review on PR #958) — the switch itself, and this
      // default guard, are otherwise unchanged; the closing brace (270) now
      // also attributes as missed, the same brace-line artifact already
      // documented above for this exact guard. Lines realigned to 285-288
      // by the WFT-17/18 second-round Codex review's atomic-tombstone
      // rework (`resolveCatalogTombstoneIfPresent` pre-check, and
      // `tombstoneBytes`-based restore/finalize) added above this
      // function — the switch and default guard themselves are otherwise
      // unchanged. Lines realigned to 290-293 by WFT-20's `pinnedSchedules`
      // wiring (the new `countPinnedSchedulesForRevision` call and its
      // doc-comment update) added above this function — the switch and
      // default guard themselves are otherwise unchanged. Lines realigned
      // to 301-304 by WFT-21's `retainedRecoveryRecords` wiring (the new
      // `countWorkflowStateRevisionsByStatus`/`countTeardownDeadLettersForRevision`
      // calls and doc-comment updates) added above this function — the
      // switch and default guard themselves are otherwise unchanged. Lines
      // realigned to 302-305 by WFT-21's `finalizeRevisionRemoval()` lost-CAS
      // truthful-outcome fix (Codex review round 14, P2 item S-QH) added
      // above this function — the switch and default guard themselves are
      // otherwise unchanged.
      {
        reason:
          'Compile-time exhaustiveness guard for a closed discriminated union has no reachable runtime path to test without an unsafe cast.',
        lines: new Set([302, 303, 304, 305]),
      },
    ],
    [
      'src/core/engine/checkpoint-replay.ts',
      {
        reason:
          'The remaining replay line guards a checkpoint operation kind excluded by the decoded effect-log union.',
        lines: new Set([134]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/dynamic-source-execution.ts',
      {
        // `resolveExecutableRegistration()`'s own doc marks this exact branch
        // "Unreachable in practice": `resolveWorkflowSourceForExecution()`'s
        // contract guarantees a successful resolve always populates
        // `internals.sources.resolved` for the key it just resolved — the
        // only way to reach this throw is to corrupt that invariant via an
        // unsafe cast, the same class of guard already allowed for
        // `catalog-removal.ts`'s exhaustiveness default above.
        reason:
          'Defensive fail-loud guard for an invariant resolveWorkflowSourceForExecution() itself guarantees; has no reachable runtime path to test without an unsafe cast. ' +
          'Lines realigned to 130-139 after the WFT-15/16 review round 2 fix synchronized the sole-registered-revision fast path (no `await` before `onRevisionChosen` fires). ' +
          'Lines realigned to 147-156 after WFT-17/WFT-18 split this guard into a shared `loadAndInstallSourceRevision()` tail reused by both `resolveExecutableRegistration()` and the new `resolveExecutableRegistrationForRevision()` — the guard itself is unchanged, only its position moved. ' +
          'Lines realigned to 159-164 after WFT-21 (Codex review round 4, P2) added a `WorkflowRevisionUnavailableError` passthrough to the catch block immediately above this guard — a fully-covered branch, not part of this allowance — shifting the guard down by 7 lines with no change to the guard itself. The `if` condition line and its comment lines are excluded: only the never-taken throw statement itself (its call expression through its closing `);`) is reported uncovered.',
        lines: new Set([159, 160, 161, 162, 163, 164]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/index.ts',
      {
        reason:
          'Bun reports aggregate re-export and factory closures as missed although the engine entrypoint has complete line coverage. Raised from 4 to 5 when the ownership bootstrap was extended to the global lease mode: that edit adds no new function and makes strictly more code run on the lease path, and line coverage stayed at 100 percent, so the extra miss is the same attribution artifact rather than new dead code. Raised from 5 to 6 by the WFT-15/16 `getRegistration` strategy-bundle closure (dynamic-source fallback lookup) — same attribution artifact, line coverage still 100 percent.',
        functions: 6,
      },
    ],
    [
      'src/core/engine/lease-deposition.ts',
      {
        reason:
          'Bun reports the deposition callback as missed although successful deposition and lease-loss behavior are covered through fenced-write tests.',
        functions: 1,
      },
    ],
    [
      // WFT-20: `resolveCachedStartRevision`/`resolveStartRevisionUncached`
      // were extracted out of `lifecycle/start.ts` into their own module
      // (`lifecycle/start-revision-resolution.ts`) so both `start.ts` and
      // the new pinned-schedule-revision resolver can import the same
      // logic instead of duplicating it — this allowance moved with them.
      'src/core/engine/lifecycle/start-revision-resolution.ts',
      {
        // `resolveStartRevisionUncached()`'s own doc marks its FINAL throw
        // "Unreachable in practice": every call site resolved `type` to a
        // real `registration` first, so `registeredCatalogRevisions` is
        // always populated once `ensureWorkflowCatalogReady()` here settles.
        // The success path immediately above it (the
        // `if (afterReadiness !== undefined) { return … }` block, WFT-20)
        // IS genuinely reachable and covered now — `resolveScheduleRevisionForPin()`/
        // `resolveScheduleCreationRevision()` call this uncached fallback
        // from `schedule()`, a caller that (unlike `engine.start()`'s
        // top-level entry gates) does not already await
        // `ensureWorkflowCatalogReady()` beforehand, so the cache-miss
        // fallback is a real, exercised path there. Only the throw
        // statement's own two lines remain unreachable. (This allowance's
        // key moved from `lifecycle/start.ts` to this extracted file in
        // WFT-20; WFT-152's unrelated `lifecycle/start.ts` edit no longer
        // applies here since the function itself moved out.)
        reason:
          'Defensive fail-loud guard for an invariant every call site of resolveStartRevisionUncached() already guarantees; has no reachable runtime path to test without corrupting registeredCatalogRevisions via an unsafe cast.',
        lines: new Set([53, 61, 62, 65]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/lifecycle/resume-body.ts',
      {
        // The double-failure cleanup path IS exercised (`callbacks.failWorkflowForRecoveryHook`
        // at the preceding line, and `callbacks.handleCleanupError` at the
        // following line inside this catch's own body, both show real hit
        // counts) — only the `catch (commitError) {` line's OWN counter
        // reports zero, the identical brace/case-label attribution artifact
        // already documented for `catalog-removal.ts`'s exhaustiveness
        // guard above: a coverage-instrumentation quirk, not a real gap.
        reason:
          "Bun reports the catch clause's own line as missed although the surrounding failWorkflowForRecoveryHook call and this catch's own handleCleanupError body both show real hit counts — the same brace-line attribution artifact documented for catalog-removal.ts's exhaustiveness guard. Also reports one enclosing closure as missed for the same reason. (WFT-134 split this file's contents out of `resume.ts`, where this allowance's key/line previously lived at line 102, into this new file at line 112, to keep `resume.ts` under the implementation-file-size ceiling once the WFT-134 claim-release wrapping was added there.)",
        functions: 1,
        lines: new Set([115]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/lifecycle/start-commit.ts',
      {
        reason:
          'Bun reports one start-commit closure as missed although idempotent, conflicting, and successful commits are covered.',
        functions: 1,
      },
    ],
    [
      'src/core/engine/lifecycle/transition.ts',
      {
        reason:
          'Bun reports one transition closure as missed although terminal, cancellation, and failure transitions are covered.',
        functions: 1,
      },
    ],
    [
      'src/core/engine/pending-updates.ts',
      {
        reason:
          'Bun reports pending-update callbacks as missed although enqueue, replace, apply, and teardown behavior is covered.',
        functions: 2,
      },
    ],
    [
      'src/core/engine/listing.ts',
      {
        reason:
          'The remaining line is the equality tiebreaker after both strict id-order branches have been exercised; distinct workflow ids in existing tests never happen to need it. ' +
          'Realigned to 238 after the WFT-15/16 review round 2 fix routed setAttributes() through the sync-only dynamic-registration fallback. ' +
          'Realigned to 239 after WFT-17/WFT-18 added the `revision` field to summaryFromState() above it. ' +
          'Realigned to 243 after WFT-19 review round 1 widened the import block (resolveExecutableRegistrationForRevision, Engine type) above it.',
        lines: new Set([243]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/retention.ts',
      {
        reason:
          'Bun maps the closing braces of the resolved-dynamic-retention loop as uncovered after the direct `return true` inside them executes (retention.test.ts + workflow-retention.test.ts both exercise the branch itself). Realigned from 34-35 when the EngineDisposedError import for the disposed-sweep check shifted the file by one line.',
        lines: new Set([35, 36]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/storage-io.ts',
      {
        reason:
          'Driver and runtime-specific behavior cannot be attributed in the default Bun LCOV process; fresh coverage confirms only these residual misses.',
        functions: 1,
      },
    ],
    [
      'src/core/engine/stream-chunk-loading.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        lines: new Set([47, 51]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/engine/workflow-concurrency.ts',
      {
        reason:
          'The remaining concurrency branches cover lease-loss and simultaneous-settlement interleavings whose public outcomes are tested without deterministic line attribution.',
        functions: 1,
        lines: new Set([125, 126, 127, 153, 154]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/core/scheduler/timer-sources.ts',
      {
        reason:
          'The residual timer-source line guards an unknown persisted timer kind excluded by timer decoding.',
        lines: new Set([51]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/server/authentication/rotating-api-key-store.ts',
      {
        reason:
          'The remaining key-store branches handle rotation races and malformed stored key metadata excluded by validated writes.',
        lines: new Set([163, 165, 166, 167]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/server/fault-to-json-rpc.ts',
      {
        reason:
          'Bun reports the default fault-mapping closure as missed although every public Weft fault code and generic fallback are asserted.',
        functions: 1,
      },
    ],
    [
      'src/server/operations/bulk-retry-failed-workflows.ts',
      {
        reason:
          'corvidae’s parseBulkRetryRequestBody() wraps its filter/control parsing in a try/catch that rethrows any parse failure as invalidParamsFault(faultMessage(error)) (line 80); every current test supplies a body that parses cleanly, so no test drives a malformed body through this specific catch.',
        lines: new Set([80]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/server/operations/get-task-detail.ts',
      // Same pattern as the get-task-diagnostics.ts entry immediately below:
      // the closed RemoteTaskRecord state union makes this default branch
      // (projectTaskDetail's switch) unreachable at runtime — a compile-time
      // exhaustiveness guard only. `requireUncoveredLines` stays omitted here:
      // upstream's own documented experience is that which of the case-label
      // and brace lines around the guard reads 0 flips between runs with
      // byte-identical source (a coverage-attribution artifact), and nothing
      // about corvidae's copy changes that mechanism. Realigned for corvidae
      // from a fresh coverage/lcov.info (COR coverage-gate adoption): the
      // same `default: { … const exhaustive … return exhaustive; }` guard
      // now falls at 407 (`default: {`), 410 (`const exhaustive`), and 411
      // (`return exhaustive`) instead of upstream's 288/291/292/293 — the
      // closing brace does not get its own DA: record at either coordinate,
      // matching the class of gap `createLineSet`/`createMergedLineSet`'s own
      // callers already work around throughout this file.
      {
        reason:
          'Compile-time exhaustiveness guard for a closed discriminated union has no reachable runtime path to test without an unsafe cast.',
        lines: new Set([407, 410, 411]),
      },
    ],
    [
      'src/server/operations/get-task-diagnostics.ts',
      // The closed RemoteTaskRecord state union makes this default branch
      // unreachable at runtime; it exists solely as a compile-time
      // exhaustiveness guard (`addRecordDiagnostics`'s switch), matching the
      // identical pattern already allowed for `task-ledger-recovery.ts`.
      // `requireUncoveredLines` is intentionally omitted for the same reason
      // it is omitted there: `default: {` (306) and its closing `}` (311)
      // are case-label/brace lines that flip between hit and unhit run to
      // run with byte-identical source — a coverage-attribution artifact,
      // not a real reachability signal — so only the two dead statements
      // inside it (309, 310) are guaranteed to read 0 every run.
      {
        reason:
          'Compile-time exhaustiveness guard for a closed discriminated union has no reachable runtime path to test without an unsafe cast.',
        lines: new Set([355, 358, 359, 360]),
      },
    ],
    [
      'src/server/rest-body.ts',
      {
        reason:
          'The remaining body-reader branches are stream abort and reader failure exits that depend on host transport faults.',
        functions: 1,
        lines: new Set([19, 20, 21, 22, 23, 30, 39, 43]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/server/runtime/task-ledger-recovery.ts',
      // The closed RemoteTaskRecord state union makes this default branch
      // unreachable at runtime; it exists solely as a compile-time
      // exhaustiveness guard (`recoverTaskLedgerRecord`'s switch), matching
      // the identical pattern already allowed for
      // `websocket-worker.ts`'s WorkerToServerMessage switch. `requireUncoveredLines`
      // stays omitted for the same reason upstream omits it: the case-label
      // and brace lines around a dead `default:` branch are a documented
      // coverage-attribution artifact, not a real reachability signal.
      // Realigned for corvidae from a fresh coverage/lcov.info (COR
      // coverage-gate adoption): the guard now falls at 173 (`default: {`),
      // 176 (`const exhaustive`), and 177 (`void exhaustive`) instead of
      // upstream's 157-161.
      {
        reason:
          'Compile-time exhaustiveness guard for a closed discriminated union has no reachable runtime path to test without an unsafe cast.',
        lines: new Set([173, 176, 177]),
      },
    ],
    [
      'src/server/runtime/task-result-resolution.ts',
      // Realigned for COR-226 (activityHeartbeatDetailsPayloadSizeError):
      // the new function mirrors taskResultPayloadSizeError's identical
      // try/catch/rethrow structure, and Bun LCOV attributes the same
      // never-taken `throw error` re-throw branch plus its preceding
      // closing brace as missed — a direct unit test exercises the
      // PayloadSizeExceededError branch (the `return error` line), but
      // forcing the `error instanceof PayloadSizeExceededError === false`
      // rethrow would require assertPayloadWithinLimit itself to throw
      // something else, which no current test does.
      {
        reason:
          'Both size-check functions (taskResultPayloadSizeError, activityHeartbeatDetailsPayloadSizeError) have a catch-block rethrow for a non-PayloadSizeExceededError that no current test forces; Bun LCOV attributes the closing brace and the throw line as missed for the newer function.',
        functions: 1,
        lines: new Set([47, 48]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/server/runtime/websocket-stream.ts',
      {
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 1,
      },
    ],
    [
      'src/server/runtime/websocket-worker.ts',
      // Realigned for COR-226 (attempt-fenced heartbeat details validation)
      // from a fresh coverage/lcov.info generated AFTER this file's own
      // edits (the new `activityHeartbeatDetailsPayloadSizeError` check in
      // `onActivityHeartbeatMessage`, now itself covered by a dedicated
      // oversized-details test) — not by offset arithmetic against the
      // pre-edit layout. The underlying branches this entry allows are
      // unchanged from the prior (COR-235/COR-237/COR-1271) realignment;
      // only their line numbers shifted:
      //
      // 1. The oversized-task-result-rejection persistence-failure log
      // (163-166, was 160-163) and the `applyTaskResultFallback` rejection
      // logger (290, was 287, the arrow-function callback passed to
      // `.catch()` — the one missed function this entry allows) — each
      // fires only when a storage write or the fallback path itself fails,
      // which no current test forces.
      //
      // 2. The revision-mismatch protocol-error branch for a stale
      // `taskResult` (259-267, was 256-264) — a genuine resend of the same
      // original message always echoes back whatever revision it echoed the
      // first time, so no current test can construct the mismatch without
      // lying about being a resend.
      //
      // 3. The closed `WorkerToServerMessage` union's `default:` branch
      // (653 `default: {`, 656 `const exhaustiveCheck`, 657 `return
      // exhaustiveCheck`) is the same compile-time-only exhaustiveness guard
      // realigned above for `get-task-detail.ts` and
      // `task-ledger-recovery.ts`, plus the preceding `activityHeartbeat`
      // case's closing brace (652), which reads 0 in this run — the same
      // case-label/brace coverage-attribution artifact those sibling
      // entries already document.
      //
      // `requireUncoveredLines: true` here, as before: the majority of what
      // this entry allows is real, meaningfully-defensive branches where a
      // future covering test should trip this check, not the minority
      // case-label/brace lines that can attribute inconsistently.
      //
      // Realigned again (COR-235), and one new branch added. Adding the
      // `activity-heartbeat-test-hooks.ts` import shifted every coordinate below it by +1;
      // `onActivityHeartbeatMessage`'s durability-report calls added a further +37 for
      // coordinates below that function (net +38, after also removing 2 dead-code-adjacent
      // lines — see below). Re-derived from a fresh coverage/lcov.info, not offset arithmetic,
      // per this entry's own standing warning above: 160-163 -> 161-164 (+1), 256-264 -> 257-265
      // (+1), 287 -> 288 (+1), 631/632/635/636 -> 669/670/673/674 (+38).
      //
      // 4. `onActivityHeartbeatMessage`'s `withRetry` closure re-checks
      // `isAssignedToAttempt` before committing the durable heartbeat write (originally 462-468,
      // now 492-498 below) — genuinely reachable, but only on `withRetry`'s SECOND attempt, after
      // `commitTaskLedgerTransition` has thrown once and `withRetry` has awaited its 100ms backoff
      // sleep; only during that real sleep can another message actually reassign or resolve the
      // attempt. No current test forces both a thrown storage error AND a race during its retry
      // backoff, and doing so would need a genuine ~100ms wall-clock wait — exactly the
      // timing-dependent test this project's own audit history (COR-1264) already argues against
      // manufacturing. The otherwise-identical sibling guard at line 444 (`extendVisibility`
      // returning `undefined` right after `getTask` found the same entry, with no `await` between
      // them) is NOT reachable by any construction and is intentionally left without a test hook
      // or an allowance entry — see its own comment.
      //
      // Realigned a further time merging COR-235 (W1c) and COR-226/COR-223 (W2): both branches
      // independently realigned this same entry from their own pre-merge coverage runs (W1c to
      // 161-164/257-265/288/462-468/669-670+673-674; W2 to 163-166/259-267/290/652-653+656-657),
      // and the merge's textual conflict was resolved by re-deriving from a fresh
      // coverage/lcov.info on the MERGED tree, not by picking a side or doing offset arithmetic on
      // either. The merge also surfaced a genuine coverage gap the textual merge itself
      // introduced: `onActivityHeartbeatMessage`'s new COR-226 `detailsError` early return had no
      // `reportActivityHeartbeatAppliedForTesting` call at all (W2 predates that test-only seam),
      // so it silently dropped the outcome report every other early-return path in this function
      // makes. Fixed by adding a `skipped` report there (see `ActivityHeartbeatAppliedEvent`'s
      // updated doc comment) and covering it with a dedicated test
      // (`websocket-worker.characterization.test.ts`'s `activityHeartbeat message` describe
      // block) — not a line this allowance should ever have covered for. Final coordinates below
      // reflect that fix: 161-164 -> 164-167, 257-265 -> 260-268, 288 -> 291, 462-468 -> 492-498,
      // 669/670/673/674 -> 700/701/704/705.
      //
      // Realigned again for the long-poll drain: its `long-poll-drain.ts` import added +1 to every
      // coordinate, and the drain trigger after `completeTask()` in `onTaskResultMessage` a further
      // +3 below it. Re-derived from a fresh coverage/lcov.info, which reports exactly the same 25
      // missed lines and one missed function: 164-167 -> 165-168, 260-268 -> 261-269,
      // 291 -> 292, 492-498 -> 496-502, 700/701/704/705 -> 704/705/708/709.
      //
      // Realigned again for COR-1366 (task result delivery history), from a fresh
      // coverage/lcov.info on the rebased tree. The same five branches remain; two grew because
      // they now record a delivery entry. The oversized-result persistence-failure branch also
      // records a `commit-rejected` delivery before logging (165-168 -> 224-232), and the
      // revision-mismatch branch now goes through the shared `rejectTaskResult` helper that
      // sends the protocolError and records the rejection (261-269 -> 331-340). The rest only
      // shifted: 292 -> 363, 496-502 -> 569-575, 704/705/708/709 -> 777/778/781/782.
      {
        reason:
          "Defensive error-logging branches for a storage write or fallback-path failure that no current test forces (224-232, 363), a revision-mismatch rejection unreachable without fabricating a non-resend (331-340), a heartbeat-retry reassignment race reachable only during withRetry's real backoff sleep (569-575), and the closed WorkerToServerMessage union default branch (777, 778, 781, 782).",
        functions: 1,
        lines: new Set([
          224, 225, 226, 227, 228, 229, 230, 231, 232, 331, 332, 333, 334, 335, 336, 337, 338, 339,
          340, 363, 569, 570, 571, 572, 573, 574, 575, 777, 778, 781, 782,
        ]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/storage/turso.ts',
      {
        reason:
          'Driver and runtime-specific behavior cannot be attributed in the default Bun LCOV process; fresh coverage confirms only these residual misses. Realigned for corvidae from a fresh coverage/lcov.info (COR coverage-gate adoption): upstream’s coordinates no longer matched corvidae’s file. Lines 81-83 (`rollbackBestEffort`) left the allowance with COR-1472: a parked workflow now writes its `waitingForSignals` record, so the concurrent parks in search-attributes-integration.test.ts contend for the write transaction on every run (nine `SQLITE_BUSY` retries per run, measured five times) and reach the rollback path.',
        functions: 2,
        lines: new Set([237, 238]),
        requireUncoveredLines: true,
      },
    ],
    [
      'src/worker/attempt-controllers.ts',
      // COR-223: 100% line coverage (every statement in this file executes
      // under the tuple-key regression tests in worker/index.test.ts and
      // worker/long-poll.test.ts) but one of its 7 declared functions is not
      // attributed as hit — the same class-with-no-explicit-constructor
      // attribution gap Bun LCOV shows elsewhere in this repository (no
      // `FN:` name data is emitted for this file, so the specific function
      // cannot be pinned to a line the way other entries do).
      {
        reason:
          'Every line of AttemptControllerTable executes under real tests (100% line coverage), but Bun LCOV attributes one of its 7 declared functions as unhit with no FN name data to identify or pin it to a line.',
        functions: 1,
      },
    ],
    [
      'src/workers/workflow-runner.ts',
      {
        // Line realigned from 524 to 523 by WFT-20's `workflowRevisions`
        // capture logic added above this function — re-derived from fresh
        // LCOV, not by inspection.
        reason:
          'Transport disconnect and concurrency exits are behaviorally tested, but Bun does not deterministically attribute these residual paths.',
        functions: 1,
        lines: new Set([523]),
        requireUncoveredLines: true,
      },
    ],
  ],
);

/**
 * Allowances for source that exists only in corvidae — added by the COR coverage-gate
 * adoption, never by upstream. Kept as its own layer rather than folded into any of the
 * five historical layers above so a reader can tell at a glance which entries describe
 * source upstream also carries (subject to realignment against upstream's own history)
 * from entries that describe a corvidae-only consolidation (`src/cli/` chief among them)
 * with no upstream counterpart to compare against. Assembled with the same last-wins
 * replace semantics as `COVERAGE_ALLOWANCE_OVERRIDES`, after the five historical layers,
 * so a corvidae-authored entry always wins over a same-keyed historical one rather than
 * the reverse.
 */
export const CORVIDAE_COVERAGE_ALLOWANCES = buildAllowanceLayer('CORVIDAE_COVERAGE_ALLOWANCES', [
  [
    'examples/a2a-workflow-agent.ts',
    {
      reason:
        'The `if (import.meta.main)` entry point only binds `startExampleAgentAndReport` to the real process: the resolved example environment, `console.info`, and the shutdown signals. It runs when `test:a2a-tck` spawns the example, a separate process whose hits are never attributed to the parent LCOV report. `startExampleAgentAndReport` and `startExampleAgent` are covered in process by examples/a2a-workflow-agent.test.ts. The one function miss is the entry block’s signal handler.',
      functions: 1,
      lines: new Set([266, 267, 268, 269, 270, 271, 272, 273, 274]),
      requireUncoveredLines: true,
    },
  ],
  [
    'scripts/run-a2a-tck.ts',
    {
      reason:
        'The real process runners behind `test:a2a-tck`: `spawnAndWait`, `runGit`, and `ensureCheckout` run `git` and `uv` against a network clone of the TCK, `startExample` spawns the example agent, and `processDependencies` binds them for the one-line `import.meta.main` entry. They need Python, `uv`, and the network, so only the opt-in `test:a2a-tck` runs them, outside the default gate. Every decision the runner makes (argument parsing, the per-level TCK command, report collection, the pass rule, and stopping the example) is in `runA2ATck`, which scripts/run-a2a-tck.test.ts runs in process with stand-ins for each runner and a stub system under test.',
      functions: 5,
      lines: new Set([
        92, 211, 215, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233,
        234, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255,
        256, 257, 258, 259, 260, 261, 265, 266, 267, 268, 269,
      ]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/cli-main.ts',
    {
      reason:
        'The `if (import.meta.main)` entry point only binds `runCliMain` to the real process: its stdout, stderr and exit, and the shutdown signals for a `serve` run. It runs when the `weft` binary is executed, a separate process whose hits are never attributed to the parent LCOV report. `runCliMain` itself, including the serve path and its shutdown, is covered in process by src/cli/cli-direct-*.test.ts, which stopped spawning the binary inside the per-test budget. Four of the eight function misses are the entry block’s stdout, stderr and exit callbacks and its signal handler. Three are the best-effort `.catch` callbacks in `listenOrRollBack`’s rollback, which run only if `server.stop()`, `engine.shutdown()` or the storage disposer themselves fail while releasing a failed start. The last is Bun’s function-undercount artifact: with those removed the file still reports one miss with every line hit.',
      functions: 8,
      lines: new Set([199, 200, 201, 202, 203, 204, 205, 206]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/hello-world-example.test-support.ts',
    {
      reason:
        "The `if (import.meta.main) {...}` CLI entry point only runs when this file is spawned directly (bun src/hello-world-example.test-support.ts), never when imported — proven by a dedicated subprocess test (src/examples.test.ts) that spawns it and asserts its stdout, exit code, and empty stderr. That child process runs outside the parent Bun test process's --coverage instrumentation, so its hits are never attributed to the parent LCOV report — the same class of gap TARGET_ONLY_COVERAGE_ALLOWANCES documents for scripts/run-gates.ts, scripts/verify-no-test-sleeps.ts, and examples/hello-world/src/index.ts above.",
      lines: new Set([76, 77, 79, 80]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/core/engine/operations-activity.ts',
    {
      reason:
        "Two defensive guards inside invokeRemoteActivity()/requireWorkflowTypeForRemoteDispatch() (both module-private, not exported): (1) `if (!broker) throw` — invokeRemoteActivity's ONLY call site gates it behind `isRemoteMode = Boolean(internals.remoteActivityBroker) && allowRemoteDispatch`, so `broker` is always truthy by construction whenever this function runs; the module comment states remoteActivityBroker is non-null if and only if activityExecution.mode === 'remote'. Reaching the throw would require internals.remoteActivityBroker to flip to null (engine disposal does this) in the exact synchronous gap between that boolean check and the call, which is not achievable from a test without internals manipulation the check-engine-internals-field-access lint already forbids reaching for. (2) `if (identity === undefined) throw` in requireWorkflowTypeForRemoteDispatch — internals.workflowTypeByWorkflowId only loses an entry via bulk-operations-purge.ts, which purge requires a TERMINAL workflow; a live in-flight remote dispatch by definition has a non-terminal workflow, so the two conditions (an active remote-mode ctx.run() and a purged mapping for the same id) are mutually exclusive in normal operation. Realigned by +1 line (COR-281): the file gained one import for the timeline task identity, shifting these four guard lines down by one; the guards themselves are unchanged.",
      lines: new Set([175, 176, 178, 210]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/server/operations/task-diagnostics-collector.ts',
    {
      reason:
        "addRecordDiagnostics()'s switch over RemoteTaskRecord['state'] ends with a closed-union exhaustiveness guard (`const exhaustive: never = decoded`). Every record this module-private function receives was already validated by decodeRemoteTaskRecord() -> isRemoteTaskRecord(), which returns null (silently skipped by the one caller, collectTaskDiagnostics) for any record whose state is not one of the six known values. A record with an out-of-union state can therefore never reach this switch at all — the sibling decode validator forecloses it before addRecordDiagnostics is ever called, the same class of guard already documented for get-task-detail.ts/task-ledger-recovery.ts's case-label/brace lines elsewhere in this file. Realigned by +2 lines (COR-198): collectTaskDiagnostics gained one new import and one new execution-identity-filter line ahead of this function, shifting the exhaustiveness guard's block-opening line (was 104), its two statement lines (were 107, 108), and its closing brace (was 109) down to 106, 109, 110, and 111 — the guard itself is unchanged.",
      lines: new Set([106, 109, 110, 111]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/server/operations/task-attempt-identity-filter.ts',
    {
      reason:
        "currentAttemptTokenOf()'s switch over RemoteTaskRecord['state'] ends with the same closed-union exhaustiveness guard as task-diagnostics-collector.ts's addRecordDiagnostics(), immediately above this entry: `record` is already a validated RemoteTaskRecord by the time it reaches this module-private function (decodeRemoteTaskRecord()'s caller never passes anything else), so a record with an out-of-union state can never reach the `default` branch. The 'queued' (line 34-35) and 'terminal' (line 41-44) branches this same switch also covers are exercised directly by get-task-diagnostics-filters.test.ts's 'excludes a queued record from every identity filter' and 'matches a resolved terminal record's identity filter via its retained attempt record' tests — only the unreachable default block (lines 45-47) is allowed.",
      lines: new Set([45, 46, 47]),
      requireUncoveredLines: true,
    },
  ],
  [
    'src/runtime/environment-configuration.ts',
    {
      reason:
        "Two structurally environment-locked branches, plus a function-count consequence of the second one the original entry's lines-only allowance didn't cover. (1) rawRuntimeEnvironment()'s `typeof process !== 'undefined'` fallback and empty-object fallback: this workspace runs exclusively under Bun (AGENTS.md: \"Bun is the default runtime... Use Bun commands only\"), so `typeof Bun !== 'undefined'` is always true in every test process — reaching the fallback would require deleting globalThis.Bun for the duration of a test, corrupting every other test sharing the same Bun process (this repo's coverage shards run many files per process). rawRuntimeEnvironment itself is still called (and function-covered) via its happy path; only these two unreachable branch lines are allowed. (2) Every `load` closure on a `Source` object in this file (createEnvironmentSource's, at the object-literal line every one of its three call sites already marks line-covered by constructing the object, and readEnvironmentVariable()'s exactSource.load, lines 139-142): every call site in this file uses environmentalist.sync(...), never .async(...), and neither Source value is exported or returned, so nothing in this codebase ever invokes `load` on either one — only `loadSync`, which environmentalist.sync() calls exclusively. `load` exists solely to satisfy the Source interface's required shape. Because createEnvironmentSource's `load` is a single-expression arrow on the same source line as its own registration, the interior body has no separate DA line to report 0 on — line coverage alone hides it entirely, and only the function tally (FNF/FNH) reveals it, which is why `functions: 2` (this arrow plus readEnvironmentVariable's) is needed alongside the line allowance below.",
      lines: new Set([8, 9, 139, 140, 141, 142]),
      requireUncoveredLines: true,
      functions: 2,
    },
  ],
  [
    'scripts/lib/workflow-visibility-backfill.test-support.ts',
    {
      reason:
        "NoConditionalBatchStorage.get()/put()/delete()/batch() are four one-statement async methods (`return null;`/`return undefined;` ×3) on consecutive lines — batch()'s in particular is byte-identical to put()'s and delete()'s. Directly verified with standalone tests (each calling exactly one of these methods alone, logging the result via console.log immediately before asserting it) that every one of them demonstrably executes and resolves correctly when called. Despite that, this file's function-level tally (FNH/FNF) is short by 2 in the authoritative full-suite run — batch()'s own two interior lines (175-176) are the only LINES ever reported at zero (allowed below), but re-running the same isolated single-method verification in different file combinations shows the SPECIFIC additional line/function that reads as zero shifts (in one combination delete()'s own `return undefined;` line reads zero despite a console.log proving that exact call executed; in the authoritative full-suite run it does not, and some other still-unidentified construct accounts for the second gap instead). That instability — the same underlying LINES and FUNCTIONS read as covered or not depending on what else shares the Bun test process — means the specific second function cannot be pinned down the way batch() was; only that workflow-visibility-backfill.test-support.test.ts (COR-1283) calls get/put/delete/batch/scan/capabilities directly, every one of them is proven by direct console.log verification to execute and return correctly, and the file's LINES are 100% covered once 175-176 are allowed (107 total, 105 otherwise-hit) with no line left unaccounted for. functions: 2 covers both the confirmed batch() gap and this second, situationally-shifting one from the same class of trivial near-identical single-statement methods.",
      lines: new Set([175, 176]),
      requireUncoveredLines: true,
      functions: 2,
    },
  ],
  [
    'src/cli/codegen-emit-registry.ts',
    {
      reason:
        "CodegenPackageNameError (`export class CodegenPackageNameError extends Error {}`) has no explicit constructor. codegen-emit-registry.test.ts's \"refuses a package name npm would not accept\" test does instantiate it (via `new CodegenPackageNameError(...)` at emitRegistryDeclaration's throw site, itself on a line already reported covered), and every other function in this file — sortedWorkflowEntries, collectSchemaOccurrences, schemaTypeReference, emitWorkflowEntry, emitAliasDeclarations (including its two-or-more-alias comparator, exercised by the \"sorts multiple alias declarations deterministically\" test), and emitRegistryDeclaration itself — is reached by the existing 18-test suite, matching this file's 100% line coverage (LF/LH 80/80). Isolated a minimal repro to confirm the mechanism before allowing it: a standalone one-file module exporting only a no-explicit-constructor `class extends Error {}` and a function that instantiates it, exercised by one passing test, reports FNF:2/FNH:1 in Bun's own LCOV — the class counts as a function but its implicit constructor is never marked hit regardless of instantiation, because Bun's coverage instrumentation has no synthesizable source line inside an absent constructor body to attach a hit record to. That reproduces this file's exact FNF:11/FNH:10 shape with nothing else unaccounted for.",
      functions: 1,
    },
  ],
  [
    'src/server/operations/storage.test-support.ts',
    {
      reason:
        "TrackingScanStorage's async-iterator return() handler. storage-raw.test.ts's one test exercising this fixture ends with `await reader.cancel()`, but the NDJSON streaming response pipeline does not propagate that ReadableStream cancellation into an early return() call on the underlying storage scan iterator, so nothing in the existing suite ever invoked it — closed with a new direct unit test (storage.test-support.test.ts, COR-1283) that constructs the iterator, calls next() once, then calls return() directly and asserts the `{ done: true, value: undefined }` result. Even with that direct call, though, the function-level count still would not register it: isolated a standalone repro (a class with next() returning one object-literal result and a structurally similar return() returning another) confirming the same class of coverage-attribution artifact already documented for NoConditionalBatchStorage.batch() in scripts/lib/workflow-visibility-backfill.test-support.ts — directly verified via a console.log immediately before the assertion that the call executes and resolves with the exact expected value every time, while Bun's LCOV FNH/FNF still does not count it as hit. All of this file's LINES are already 100% covered (LF/LH 94/94, including return()'s own three interior lines, which show non-zero hit counts) — only the function tally is short by exactly this one.",
      functions: 1,
    },
  ],
  [
    'src/server/operations/get-task-diagnostics.test-support.ts',
    {
      reason:
        "Every identifiable function in this file — echoWorkflow's generator (closed by get-task-diagnostics.test-support.test.ts, COR-1283), createEngine, ThrowingScanStorage's async-iterator chain, queuedFixture/leasedFixture/terminalFixture/deadLetteredFixture, putLedgerRecord, runDiagnostics (including its `now: () => 10_000` callback, confirmed via `options.now?.()` at get-task-diagnostics.ts:196), and diagnosticsValue — is called by the existing test suite (get-task-diagnostics.test.ts, get-task-diagnostics-filters.test.ts, and the new test-support test), matching this file's 100% line coverage (LF/LH 152/152). Directly re-verified with standalone console.log-instrumented calls that ThrowingScanStorage's scan actually throws through runDiagnostics and that the `now` callback's result flows into a successful diagnostics response, ruling out the two most structurally likely trivial-closure candidates. Bun's LCOV FNF for this file (16) still exceeds every function this elimination could identify by source inspection (12), the same kind of undercount already documented elsewhere in this registry as a known Bun LCOV limitation (see pre-commit.ts and check-revision-keyed-lookups.ts below: \"Bun's LCOV omits per-function FN:/FNDA: detail\") — unlike the two allowances directly above this one, no single function could be pinned down as the specific one FNH doesn't count, only that one residual gap remains after exhausting every identifiable call site.",
      functions: 1,
    },
  ],
  [
    'scripts/benchmarks/memory-footprint.ts',
    {
      reason:
        'The `proc_pid_rusage` FFI path (opening libSystem, caching the symbol, calling it, and the darwin branch of readMemoryFootprint) exists only on macOS, where memory-footprint.test.ts covers it. On Linux there is no libSystem to open, so those lines and three functions cannot run; COR-1379 found the gap in the linux/arm64 Dev Container.',
      ...memoryFootprintUncoveredOutsideDarwin(process.platform),
      requireUncoveredLines: true,
    },
  ],
]);

/**
 * Allowances for files that exist only in the public mirror the sync emits to, never in
 * corvidae. Upstream's registry carries these — `scripts/husky/*` (git-hook entry points),
 * `scripts/run-gates.ts` and `scripts/verify-no-test-sleeps.ts` (target-owned tooling per
 * `target-owned.json`), and `examples/hello-world/**` (an example corvidae never adopted) —
 * kept here VERBATIM rather than deleted, because `packages/weft/scripts/check-coverage.ts`
 * is itself emitted to the target unmodified, and the target's own coverage run measures
 * these real files. Corvidae's own coverage run never sees an `SF:` record for any of them
 * (the files do not exist on disk here), so each entry is inert: `COVERAGE_ALLOWANCES.get()`
 * is a Map lookup keyed by the LCOV's own file paths, and a key with no matching record is
 * simply never read. Realigning or removing these against corvidae's tree would be wrong in
 * the other direction — it would silently stop describing the target's real source the next
 * time these files are edited there.
 */
const TARGET_ONLY_COVERAGE_ALLOWANCES = buildAllowanceLayer('TARGET_ONLY_COVERAGE_ALLOWANCES', [
  [
    'scripts/run-gates.ts',
    {
      reason:
        'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
      functions: 1,
      lines: new Set([92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 193]),
      requireUncoveredLines: true,
    },
  ],
  [
    'scripts/verify-no-test-sleeps.ts',
    {
      reason:
        'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
      lines: new Set([205]),
      requireUncoveredLines: true,
    },
  ],
  [
    'examples/hello-world/src/index.ts',
    {
      reason:
        'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
      lines: new Set([68, 69, 71, 72]),
      requireUncoveredLines: true,
    },
  ],
  [
    'scripts/husky/pre-commit.ts',
    // reportTestOutcome was hoisted out of main() to module scope, landing
    // immediately before it (229-268), to fix an
    // unicorn/consistent-function-scoping finding surfaced by the
    // oxlint-tsgolint version bump; the lint:fix step also gained ~20 lines
    // scoping it to staged files only (PR #904). reportTestOutcome is only
    // ever called from inside main(), which pre-commit.test.ts never
    // invokes, so it is exactly as uncoverable as main() itself — the range
    // now runs 229-484 (was 229-474) to cover both as one contiguous span,
    // matching main()'s new end boundary after WFT-19 added a 7b)
    // revision-keyed-lookups check step (12 lines) alongside the existing
    // numbered steps. Lines before 227 (the pre-main() stash-lifecycle
    // helpers) are untouched.
    // `requireUncoveredLines` is intentionally omitted now: `return false;`
    // / the closing `}` of reportTestOutcome (267, 268) and main()'s final
    // `process.exit(0)` read as hit on this run despite neither function
    // being invoked by pre-commit.test.ts — a boundary coverage-
    // attribution artifact matching the same class already documented for
    // `task-ledger-recovery.ts`'s case-label/brace lines elsewhere in this
    // file, not a real reachability signal. `functions` bumped 8 -> 9: the
    // lint:fix scoping change's staged-file filter/existence-check closures
    // add one more never-invoked function (Bun's LCOV omits per-function
    // FN:/FNDA: detail for this file — confirmed via the raw aggregate,
    // FNF:23/FNH:14, i.e. 9 uncovered).
    {
      reason:
        'Stash and interruption behavior runs in real Git child processes, whose signal-handler and executable-hook hits are not merged into parent Bun LCOV.',
      functions: 9,
      lines: createMergedLineSet(
        new Set([
          54, 55, 84, 85, 86, 99, 100, 101, 112, 123, 124, 125, 131, 132, 133, 151, 152, 153, 160,
          161, 162, 165, 167, 168, 169, 172, 200, 201, 202, 203, 204, 205, 206, 207,
        ]),
        createLineSet(229, 484),
      ),
    },
  ],
  [
    'scripts/husky/run-tests.ts',
    {
      reason:
        'Signal forwarding and descendant termination run in child processes outside parent LCOV; Windows and process-group fallbacks are platform-specific.',
      functions: 9,
      lines: new Set([486, 491, 492, 493, 552, 553, 554, 556, 557, 561, 570, 599, 600, 601, 638]),
      requireUncoveredLines: true,
    },
  ],
  [
    'scripts/husky/verify-hooks-installed.ts',
    {
      reason:
        'Process-entry and failure-exit behavior runs in child processes whose hits are not attributed to the parent Bun LCOV report.',
      lines: new Set([76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88]),
      requireUncoveredLines: true,
    },
  ],
]);

function withCoverageAllowanceTopOffs(
  baseAllowances: Map<string, CoverageAllowance>,
  topOffs: ReadonlyMap<string, CoverageAllowance>,
): Map<string, CoverageAllowance> {
  const merged = new Map(baseAllowances);

  for (const [filePath, topOff] of topOffs) {
    const current = merged.get(filePath);
    const functions = (current?.functions ?? 0) + (topOff.functions ?? 0);
    const lines =
      current?.lines === undefined && topOff.lines === undefined
        ? undefined
        : createMergedLineSet(current?.lines ?? new Set(), topOff.lines ?? new Set());
    const requireUncoveredLines =
      current?.requireUncoveredLines === true || topOff.requireUncoveredLines === true;

    merged.set(filePath, {
      ...(functions > 0 ? { functions } : {}),
      ...(lines === undefined ? {} : { lines }),
      ...(requireUncoveredLines ? { requireUncoveredLines: true } : {}),
    });
  }

  return merged;
}

const MAIN_REFRESH_LAYER: NamedAllowanceLayer = [
  'CURRENT_MAIN_COVERAGE_ALLOWANCE_REFRESH',
  CURRENT_MAIN_COVERAGE_ALLOWANCE_REFRESH,
];
const BRANCH_REFRESH_LAYER: NamedAllowanceLayer = [
  'CURRENT_BRANCH_COVERAGE_ALLOWANCE_REFRESH',
  CURRENT_BRANCH_COVERAGE_ALLOWANCE_REFRESH,
];

// The five historical layers assemble with last-wins replacement and the
// MAIN/BRANCH refresh partition guard (#538). The audit-backlog top-offs are
// then UNIONED on top (#524): for a file in both, line sets combine and function
// counts sum — so a top-off augments, never replaces, an existing allowance.
const COVERAGE_ALLOWANCE_BASE = assembleAllowanceLayers(
  [
    ['BASE_COVERAGE_ALLOWANCES', BASE_COVERAGE_ALLOWANCES],
    ['COVERAGE_ALLOWANCE_OVERRIDES', COVERAGE_ALLOWANCE_OVERRIDES],
    ['CURRENT_MAIN_COVERAGE_ALLOWANCE_OVERRIDES', CURRENT_MAIN_COVERAGE_ALLOWANCE_OVERRIDES],
    MAIN_REFRESH_LAYER,
    BRANCH_REFRESH_LAYER,
    ['TARGET_ONLY_COVERAGE_ALLOWANCES', TARGET_ONLY_COVERAGE_ALLOWANCES],
    ['CORVIDAE_COVERAGE_ALLOWANCES', CORVIDAE_COVERAGE_ALLOWANCES],
  ],
  [MAIN_REFRESH_LAYER, BRANCH_REFRESH_LAYER],
);

export const COVERAGE_ALLOWANCES = withCoverageAllowanceTopOffs(
  COVERAGE_ALLOWANCE_BASE,
  AUDIT_BACKLOG_COVERAGE_ALLOWANCE_TOP_OFFS,
);

// Reject any allowance keyed to a coveragePathIgnorePatterns path — such a file is never
// instrumented, so the allowance is dead and its line numbers drift silently (#539). Run
// this on the fully assembled COVERAGE_ALLOWANCES (base layers + audit-backlog top-offs)
// so a dead key introduced in any layer is caught.
assertNoAllowanceKeyIsCoverageIgnored(COVERAGE_ALLOWANCES, readCoveragePathIgnorePatterns());

function summarizeCoverageFiles(files: ReadonlyMap<string, FileCoverageResult>): CoverageResult {
  const lines = { total: 0, hit: 0, missed: 0 };
  const functions = { total: 0, hit: 0, missed: 0 };
  const uncoveredFiles: string[] = [];

  for (const [filePath, fileCoverage] of files) {
    lines.total += fileCoverage.lines.total;
    lines.hit += fileCoverage.lines.hit;
    lines.missed += fileCoverage.lines.missed;
    functions.total += fileCoverage.functions.total;
    functions.hit += fileCoverage.functions.hit;
    functions.missed += fileCoverage.functions.missed;
    if (!fileCoverage.covered) {
      uncoveredFiles.push(filePath);
    }
  }

  uncoveredFiles.sort();

  return {
    covered: lines.missed === 0 && functions.missed === 0,
    lines,
    functions,
    uncoveredFiles,
  };
}

/**
 * Parse an lcov report into adjusted per-file coverage metrics.
 */
export function parseLcovFiles(content: string): Map<string, FileCoverageResult> {
  const files = new Map<string, FileCoverageResult>();
  const coveredLineAllowances: string[] = [];

  let currentFile = '';
  let fileLineTotal = 0;
  let fileLineHit = 0;
  let fileFunctionTotal = 0;
  let fileFunctionHit = 0;

  function finalizeCurrentFile(): void {
    if (!currentFile) {
      return;
    }

    if (isGeneratedCoverageArtifact(currentFile)) {
      return;
    }

    const allowance = COVERAGE_ALLOWANCES.get(currentFile);
    const ignoredFunctions = allowance?.functions ?? 0;
    const adjustedFunctionTotal = Math.max(0, fileFunctionTotal - ignoredFunctions);
    const adjustedFunctionHit = Math.min(fileFunctionHit, adjustedFunctionTotal);
    const functionMisses = adjustedFunctionTotal - adjustedFunctionHit;
    const lineMisses = fileLineTotal - fileLineHit;

    files.set(currentFile, {
      covered: lineMisses === 0 && functionMisses === 0,
      lines: {
        total: fileLineTotal,
        hit: fileLineHit,
        missed: lineMisses,
      },
      functions: {
        total: adjustedFunctionTotal,
        hit: adjustedFunctionHit,
        missed: functionMisses,
      },
    });
  }

  function resetCurrentFile(): void {
    currentFile = '';
    fileLineTotal = 0;
    fileLineHit = 0;
    fileFunctionTotal = 0;
    fileFunctionHit = 0;
  }

  for (const line of content.split('\n')) {
    if (line.startsWith('SF:')) {
      finalizeCurrentFile();
      currentFile = line.slice(3);
      fileLineTotal = 0;
      fileLineHit = 0;
      fileFunctionTotal = 0;
      fileFunctionHit = 0;
      continue;
    }

    if (isGeneratedCoverageArtifact(currentFile)) {
      continue;
    } else if (line.startsWith('FNF:')) {
      fileFunctionTotal += parseInt(line.slice(4), 10);
    } else if (line.startsWith('FNH:')) {
      fileFunctionHit += parseInt(line.slice(4), 10);
    } else if (line.startsWith('DA:')) {
      const [, lineNumberText, hitCountText] = /^DA:(\d+),(\d+)(?:,.*)?$/.exec(line) ?? [];
      // `noUncheckedIndexedAccess` (corvidae's stricter tsconfig; upstream does not enable
      // it) types a failed-match destructure as `string | undefined` for both captures. A
      // malformed `DA:` line cannot occur from Bun's own LCOV writer, but the guard makes
      // that an explicit skip instead of feeding `parseInt` an `undefined` it would coerce
      // to `NaN` and propagate silently into the coverage totals below.
      if (lineNumberText === undefined || hitCountText === undefined) continue;
      const lineNumber = parseInt(lineNumberText, 10);
      const hitCount = parseInt(hitCountText, 10);
      const allowance = COVERAGE_ALLOWANCES.get(currentFile);
      const ignoredLines = allowance?.lines;

      if (allowance !== undefined && ignoredLines?.has(lineNumber)) {
        if (hitCount > 0 && allowance.requireUncoveredLines === true) {
          coveredLineAllowances.push(`${currentFile}:${String(lineNumber)}`);
        } else {
          continue;
        }
      }

      fileLineTotal += 1;
      if (hitCount > 0) {
        fileLineHit += 1;
      }
    } else if (line === 'end_of_record') {
      finalizeCurrentFile();
      resetCurrentFile();
    }
  }

  finalizeCurrentFile();
  if (coveredLineAllowances.length > 0) {
    throw new Error(
      `Coverage allowance for ${coveredLineAllowances.join(', ')} points at a covered line. ` +
        'Realign or remove the stale allowance instead of subtracting unrelated coverage.',
    );
  }
  return files;
}

/**
 * Parse an lcov report and return per-metric totals plus the list of files with gaps.
 */
export function parseLcov(content: string): CoverageResult {
  return summarizeCoverageFiles(parseLcovFiles(content));
}

/**
 * The paths the package's own `test` script excludes with `--path-ignore-patterns`.
 *
 * Those are the measurement benchmarks — throughput, latency and memory runs whose numbers
 * swing enough between runs on one machine that they cannot assert a target, which is why
 * `bun run test` leaves them to `test:benchmarks` on demand. The coverage shard runs the same
 * suite under instrumentation and contention, where they swing more, not less: a run of this
 * gate failed twice in ten on `load-growth-memory`'s RSS-slope bound with the tree at 100 %
 * coverage. So the shard applies exactly the exclusion `test` applies, read from the script
 * rather than copied, and the runner modules only those benchmarks exercise are ignored from
 * instrumentation in `bunfig.toml` with their reasons.
 */
export function readTestScriptPathIgnorePatterns(): string[] {
  const script = packageJson.scripts?.test;
  if (typeof script !== 'string') {
    throw new Error(
      'package.json scripts.test must be a string for the coverage shard to mirror its exclusions.',
    );
  }
  return [...script.matchAll(/--path-ignore-patterns='([^']+)'/g)].map((match) => match[1] ?? '');
}

export async function listCoverageTestFiles(): Promise<string[]> {
  // Git supplies the repository ownership boundary that `rg --files` previously
  // provided: tracked files plus untracked, non-ignored files. A root Bun.Glob scan
  // does not honor `.gitignore` and therefore discovers dependency-owned tests under
  // node_modules after `bun install`.
  const repositoryFileOutput = await $`git ls-files --cached --others --exclude-standard`.text();
  const repositoryFiles = repositoryFileOutput.split('\n').filter(Boolean);
  const testFileGlobs = COVERAGE_TEST_FILE_GLOBS.map((pattern) => new Glob(pattern));
  // Matched as globs, as `bun test` matches them: the benchmark entries name single files.
  const excludedByTestScript = readTestScriptPathIgnorePatterns().map(
    (pattern) => new Glob(pattern),
  );

  return repositoryFiles
    .filter((file) => {
      if (excludedByTestScript.some((pattern) => pattern.match(file))) return false;
      const basename = file.slice(file.lastIndexOf('/') + 1);
      return testFileGlobs.some((glob) => glob.match(basename));
    })
    .toSorted();
}

type CoverageShard = {
  name: string;
  coverageDirectory: string;
  testFiles: string[];
  parallelism?: number;
};

type CoverageProcess = {
  exited: Promise<number>;
  stderr: ReadableStream<Uint8Array> | null;
  stdout: ReadableStream<Uint8Array> | null;
  // Present on a real `Bun.spawn` subprocess; optional so a minimal stubbed child
  // (one that never needs to be killed or identified by pid) stays valid in tests.
  pid?: number;
  signalCode?: NodeJS.Signals | null;
  kill?: (signal?: number | NodeJS.Signals) => void;
};

type SpawnCoverageProcess = (
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stderr: 'pipe';
    stdout: 'pipe';
  },
) => CoverageProcess;

type RunCoverageShardDependencies = {
  spawnCoverageProcess?: SpawnCoverageProcess;
  // Test seam for the SIGTERM/SIGINT handler's terminal action, so a unit test can
  // observe "the script would have exited non-zero here" without actually ending
  // the test process. Defaults to the real `process.exit`.
  exitProcess?: (code: number) => void;
};

type CheckCoverageDependencies = {
  listCoverageTestFiles?: () => Promise<string[]>;
  runCoverageShard?: (shard: CoverageShard) => Promise<{ exitCode: number; lcovPath: string }>;
};

type CapturedOutputTail = {
  bytes: Uint8Array;
  truncatedBytes: number;
};

/**
 * Every stage `checkCoverage`/`runCoverageShard` can fail at. Named explicitly so a
 * non-zero exit always prints a one-line reason naming which of these it hit — see
 * COR-1326 (and COR-225, the analogous fix for the retired agent-bureau script): a
 * gate that fails without saying why forces reruns instead of a diagnosis.
 */
export type CoverageFailureStage =
  | 'spawn'
  | 'child exit'
  | 'child signal'
  | 'missing report'
  | 'empty report'
  | 'parse failure'
  | 'coverage gap';

/**
 * Format the one-line, stage-naming reason printed for every non-zero exit. `child`
 * is supplied only when a spawned process was involved, and always reports both its
 * exit code and signal name (`"none"` for whichever did not apply) so a signal-killed
 * child is never misreported as a bare numeric exit code.
 */
export function formatCoverageFailureReason(
  stage: CoverageFailureStage,
  detail: string,
  child?: { exitCode: number | null; signal: string | null },
): string {
  const childSuffix =
    child === undefined
      ? ''
      : ` (child exit code ${child.exitCode ?? 'none'}, signal ${child.signal ?? 'none'})`;
  return `check-coverage: exiting non-zero at stage "${stage}": ${detail}${childSuffix}`;
}

async function captureOutputTail(
  stream: ReadableStream<Uint8Array> | null,
): Promise<CapturedOutputTail> {
  const chunks: Uint8Array[] = [];
  let retainedBytes = 0;
  let discardedBytes = 0;

  if (stream === null) return { bytes: new Uint8Array(), truncatedBytes: 0 };

  for await (const chunk of stream) {
    let retainedChunk = chunk;
    if (retainedChunk.byteLength > COVERAGE_FAILURE_OUTPUT_TAIL_BYTES) {
      discardedBytes += retainedChunk.byteLength - COVERAGE_FAILURE_OUTPUT_TAIL_BYTES;
      retainedChunk = retainedChunk.slice(
        retainedChunk.byteLength - COVERAGE_FAILURE_OUTPUT_TAIL_BYTES,
      );
    }

    chunks.push(retainedChunk);
    retainedBytes += retainedChunk.byteLength;

    while (retainedBytes > COVERAGE_FAILURE_OUTPUT_TAIL_BYTES) {
      const overflowBytes = retainedBytes - COVERAGE_FAILURE_OUTPUT_TAIL_BYTES;
      const firstChunk = chunks[0];
      // `noUncheckedIndexedAccess` (corvidae's stricter tsconfig; upstream does not enable
      // it) types `chunks[0]` as possibly `undefined`. `retainedBytes` was just incremented
      // by a real `chunks.push()` above, so `chunks` is provably non-empty whenever this
      // loop body runs; the guard documents that invariant for the type checker rather than
      // masking a real gap — `retainedBytes` desyncing from `chunks` would be a bug elsewhere.
      if (firstChunk === undefined) {
        throw new Error('captureOutputTail: retainedBytes desynced from chunks (unreachable)');
      }
      if (firstChunk.byteLength <= overflowBytes) {
        discardedBytes += firstChunk.byteLength;
        retainedBytes -= firstChunk.byteLength;
        chunks.shift();
        continue;
      }

      discardedBytes += overflowBytes;
      chunks[0] = firstChunk.slice(overflowBytes);
      retainedBytes -= overflowBytes;
    }
  }

  const output = new Uint8Array(retainedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes: output, truncatedBytes: discardedBytes };
}

function writeFailureOutput(label: string, output: CapturedOutputTail): void {
  if (output.bytes.byteLength === 0 && output.truncatedBytes === 0) return;

  if (output.truncatedBytes > 0) {
    process.stderr.write(
      `[${label}] omitted ${output.truncatedBytes.toLocaleString()} earlier output bytes; ` +
        `showing the final ${output.bytes.byteLength.toLocaleString()} bytes.\n`,
    );
  }

  process.stderr.write(output.bytes);
}

/**
 * Write one diagnostic line on the same `process.stderr` stream {@link writeFailureOutput}
 * uses. Under Bun 1.4.2, a `console.error` issued while an earlier large
 * `process.stderr.write` is still queued on a pipe is dropped outright, so the stage reason
 * that follows a child's output tail vanished from turbo's log (COR-1329). Keeping every
 * line after the tail on one ordered stream delivers it behind the tail instead.
 */
function writeDiagnosticLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

export async function runCoverageShard(
  shard: CoverageShard,
  dependencies: RunCoverageShardDependencies = {},
): Promise<{ exitCode: number; lcovPath: string }> {
  await $`rm -rf ${shard.coverageDirectory}`.quiet().nothrow();

  const args = [
    'bun',
    'test',
    TEST_TIMEOUT_ARGUMENT,
    '--coverage',
    '--coverage-reporter=lcov',
    '--coverage-dir',
    shard.coverageDirectory,
  ];

  if (shard.parallelism !== undefined) {
    args.push(`--parallel=${shard.parallelism}`);
  }

  args.push(...shard.testFiles);

  const lcovPath = `${shard.coverageDirectory}/lcov.info`;
  const spawnCoverageProcess =
    dependencies.spawnCoverageProcess ?? ((spawnArgs, options) => Bun.spawn(spawnArgs, options));
  const exitProcess = dependencies.exitProcess ?? ((code: number) => process.exit(code));

  let coverageProcess: CoverageProcess;
  try {
    coverageProcess = spawnCoverageProcess(args, {
      cwd: globalThis.process.cwd(),
      env: { ...process.env, ...Bun.env, WEFT_COVERAGE_MODE: '1' },
      stderr: 'pipe',
      stdout: 'pipe',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      formatCoverageFailureReason(
        'spawn',
        `${shard.name} coverage shard failed to start: ${message}`,
      ),
    );
    return { exitCode: 1, lcovPath };
  }

  // If this script itself is killed while the child is running, the child would
  // otherwise be silently orphaned and the exit would carry no diagnosis. Report
  // which shard was running and the child's pid, forward the signal, then exit.
  const onTerminationSignal = (signal: NodeJS.Signals) => {
    console.error(
      `check-coverage: received ${signal} while running the "${shard.name}" coverage shard ` +
        `(child pid ${coverageProcess.pid ?? 'unknown'}); terminating child and exiting.`,
    );
    coverageProcess.kill?.(signal);
    exitProcess(1);
  };
  process.on('SIGTERM', onTerminationSignal);
  process.on('SIGINT', onTerminationSignal);

  let stdout: CapturedOutputTail;
  let stderr: CapturedOutputTail;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      captureOutputTail(coverageProcess.stdout),
      captureOutputTail(coverageProcess.stderr),
      coverageProcess.exited,
    ]);
  } finally {
    process.off('SIGTERM', onTerminationSignal);
    process.off('SIGINT', onTerminationSignal);
  }

  if (exitCode !== 0) {
    writeFailureOutput(`${shard.name} stdout`, stdout);
    writeFailureOutput(`${shard.name} stderr`, stderr);
    writeDiagnosticLine(`${shard.name} coverage shard exited with code ${exitCode}.`);

    const signal = coverageProcess.signalCode ?? null;
    if (signal !== null && signal !== undefined) {
      writeDiagnosticLine(
        formatCoverageFailureReason(
          'child signal',
          `${shard.name} coverage shard was terminated by signal ${signal}.`,
          { exitCode, signal },
        ),
      );
    } else {
      writeDiagnosticLine(
        formatCoverageFailureReason(
          'child exit',
          `${shard.name} coverage shard exited with code ${exitCode}.`,
          { exitCode, signal: null },
        ),
      );
    }
  }

  return { exitCode, lcovPath };
}

/**
 * Run the test suite with coverage, parse the lcov report, and return whether
 * every line and function is covered.
 */
export async function checkCoverage(
  dependencies: CheckCoverageDependencies = {},
): Promise<boolean> {
  // Remove the entire coverage directory so we never read a previous run's report.
  await $`rm -rf coverage`.quiet().nothrow();
  const allTestFiles = await (dependencies.listCoverageTestFiles ?? listCoverageTestFiles)();

  const shard = await (dependencies.runCoverageShard ?? runCoverageShard)({
    name: 'coverage',
    coverageDirectory: 'coverage',
    // Let Bun use its default coverage workers. Forcing this repository into one
    // instrumented process can crash Bun before it writes LCOV on large suites.
    testFiles: allTestFiles,
  });

  if (shard.exitCode !== 0) {
    // The spawn/child-exit/child-signal stage reason was already printed inside
    // runCoverageShard, closest to the failure; this line stays for continuity, on the
    // same ordered stream as that reason (see writeDiagnosticLine).
    writeDiagnosticLine('Coverage execution failed.');
    return false;
  }

  if (!(await Bun.file(shard.lcovPath).exists())) {
    console.error(`No coverage report generated for ${shard.lcovPath}.`);
    console.error(
      formatCoverageFailureReason(
        'missing report',
        `expected an lcov report at ${shard.lcovPath} after a successful coverage run.`,
      ),
    );
    return false;
  }

  let coverage: CoverageResult;
  try {
    coverage = parseLcov(await Bun.file(shard.lcovPath).text());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      formatCoverageFailureReason('parse failure', `could not parse ${shard.lcovPath}: ${message}`),
    );
    return false;
  }

  if (coverage.lines.total === 0) {
    console.error('Coverage report is empty — no source files were instrumented.');
    console.error(
      formatCoverageFailureReason(
        'empty report',
        `${shard.lcovPath} contained zero instrumented lines.`,
      ),
    );
    return false;
  }

  const linePct = ((coverage.lines.hit / coverage.lines.total) * 100).toFixed(2);
  const funcPct =
    coverage.functions.total > 0
      ? ((coverage.functions.hit / coverage.functions.total) * 100).toFixed(2)
      : '100.00';

  console.log(`Lines:     ${linePct}% (${coverage.lines.hit}/${coverage.lines.total})`);
  console.log(`Functions: ${funcPct}% (${coverage.functions.hit}/${coverage.functions.total})`);

  if (!coverage.covered) {
    console.log(`\nFiles with gaps (${coverage.uncoveredFiles.length}):`);
    for (const file of coverage.uncoveredFiles) {
      console.log(`  ${file}`);
    }
    console.error(
      formatCoverageFailureReason(
        'coverage gap',
        `${coverage.uncoveredFiles.length} file(s) below the required threshold.`,
      ),
    );
  }

  return coverage.covered;
}

/**
 * The CLI entry point. Sets `process.exitCode` instead of calling `process.exit()`: an
 * explicit exit discards whatever `process.stderr` has not yet flushed to a pipe (under
 * Bun 1.4.2 only part of a 2 MiB write arrived, and how much varied by run and host),
 * which cut a failing run's output tail mid-line and every diagnostic after it out of
 * turbo's log (COR-1329).
 */
export async function runCheckCoverageCli(
  dependencies: CheckCoverageDependencies = {},
): Promise<void> {
  process.exitCode = (await checkCoverage(dependencies)) ? 0 : 1;
}

if (import.meta.main) {
  await runCheckCoverageCli();
}
