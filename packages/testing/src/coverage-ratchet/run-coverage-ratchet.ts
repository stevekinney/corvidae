import { resolve } from 'node:path';

import {
  computeCoverageAverages,
  coverageFailures,
  formatCoverageSummary,
  formatLineRanges,
  parseCoverageThresholds,
  parseRuntimeLcovRecords,
  parseSvelteLcovRecords,
  parseSvelteMeasurementPlatform,
  runtimeImportsOfTestSupport,
  svelteCoveragePlatformNotice,
  uncoveredLineReport,
  type CoverageScope,
  type SvelteMeasurementPlatform,
} from './coverage-ratchet.ts';

export type CoverageRatchetMessage = {
  stream: 'log' | 'warn' | 'error';
  text: string;
};

export type CoverageRatchetResult = {
  /** `0` when every threshold held, `1` when a threshold was missed or test support leaked. */
  exitCode: 0 | 1;
  /** What the check prints, in print order, tagged with the console stream it belongs to. */
  messages: CoverageRatchetMessage[];
};

export type CoverageRatchetOptions = {
  /** The package whose `coverage-ratchet.json` and `coverage/lcov.info` are checked. */
  packageRoot: string;
  /** Overrides the running platform when comparing it with `svelteMeasuredOn`. */
  platform?: SvelteMeasurementPlatform;
};

/**
 * Check `<packageRoot>/coverage/lcov.info` against `<packageRoot>/coverage-ratchet.json`, a flat
 * `{ lines, functions, svelte? }` ratchet. TypeScript runtime source is measured against the flat
 * thresholds; `.svelte` and `.svelte.ts` modules are measured against `svelte` when it is present.
 * Returns the outcome instead of exiting so a caller decides how to surface it.
 */
export async function runCoverageRatchet(
  options: CoverageRatchetOptions,
): Promise<CoverageRatchetResult> {
  const packageRoot = resolve(options.packageRoot);
  const platform = options.platform ?? {
    platform: process.platform,
    architecture: process.arch,
  };
  const thresholdsSource = await Bun.file(resolve(packageRoot, 'coverage-ratchet.json')).text();
  const thresholds = parseCoverageThresholds(thresholdsSource);
  const coverageSource = await Bun.file(resolve(packageRoot, 'coverage/lcov.info')).text();
  const averages = computeCoverageAverages(parseRuntimeLcovRecords(coverageSource, packageRoot));
  const summaries = [formatCoverageSummary(averages, thresholds)];
  const failures = coverageFailures(averages, thresholds).map((failure) => `runtime ${failure}`);
  const messages: CoverageRatchetMessage[] = [];

  if (thresholds.svelte) {
    const svelteAverages = computeCoverageAverages(
      parseSvelteLcovRecords(coverageSource, packageRoot),
    );
    summaries.push(
      formatCoverageSummary(svelteAverages, thresholds.svelte, 'Svelte coverage ratchet'),
    );
    failures.push(
      ...coverageFailures(svelteAverages, thresholds.svelte).map((failure) => `svelte ${failure}`),
    );

    // Platform measurement advisories do not change the coverage result.
    const platformNotice = svelteCoveragePlatformNotice(
      parseSvelteMeasurementPlatform(thresholdsSource),
      platform,
    );
    if (platformNotice) messages.push({ stream: 'warn', text: platformNotice });
  }

  const supportImports = runtimeImportsOfTestSupport(packageRoot);
  if (supportImports.length > 0) {
    failures.push(`${supportImports.length} runtime import(s) of test support modules`);
    messages.push({
      stream: 'error',
      text: 'Runtime source imports test support modules the ratchet excludes:',
    });
    for (const { file, specifier } of supportImports) {
      messages.push({ stream: 'error', text: `  ${file} imports ${specifier}` });
    }
  }

  if (failures.length === 0) {
    messages.push({ stream: 'log', text: summaries.join('\n') });
    return { exitCode: 0, messages };
  }

  messages.push({
    stream: 'error',
    text: `${summaries.join('\n')} Failed: ${failures.join(', ')}.`,
  });
  const scopesToReport: CoverageScope[] = [];
  if (failures.some((failure) => failure.startsWith('runtime lines'))) {
    scopesToReport.push('runtime');
  }
  if (failures.some((failure) => failure.startsWith('svelte lines'))) {
    scopesToReport.push('svelte');
  }
  for (const scope of scopesToReport) {
    const gaps = uncoveredLineReport(coverageSource, scope, packageRoot);
    if (gaps.length === 0) continue;
    const lines = gaps.map(({ file, unhitLines }) => `  ${file}: ${formatLineRanges(unhitLines)}`);
    messages.push({
      stream: 'error',
      text: [`\nUncovered ${scope} lines (${gaps.length} file(s)):`, ...lines].join('\n'),
    });
  }
  return { exitCode: 1, messages };
}

/**
 * Run {@link runCoverageRatchet}, print its messages, and record the outcome on
 * `process.exitCode`. `process.exit` is avoided because Bun can truncate piped stderr when it
 * exits with output still queued.
 */
export async function checkCoverageRatchet(options: CoverageRatchetOptions): Promise<void> {
  const result = await runCoverageRatchet(options);
  for (const { stream, text } of result.messages) console[stream](text);
  process.exitCode = result.exitCode;
}
