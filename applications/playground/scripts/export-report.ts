/**
 * The export report: what one static export built, recorded beside `build/` in
 * `build-report/export-report.json` and read back by the static production gate.
 *
 * Nothing here may block a deployment. A missing `git` yields a `null` SHA and a `null` dirty
 * flag rather than an error; the gate, not the build, decides whether that is acceptable.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { readEnvironmentConfiguration } from '../src/environment-configuration.ts';
import { buildDigestOf, createDigestManifest } from './static-playground-digest.ts';

const PLAYGROUND_ROOT = join(import.meta.dirname, '..');

/** Where the executable export writes its report, and where the gate reads it by default. */
export const EXPORT_REPORT_PATH = join(PLAYGROUND_ROOT, 'build-report', 'export-report.json');

export type ExportReport = {
  version: 1;
  /** Canonical routes, in sitemap order. */
  routes: string[];
  sourceSha: string | null;
  dirty: boolean | null;
  nodeEnv: string | null;
  exportDurationMilliseconds: number;
  peakResidentSetBytes: number;
  buildDigest: string;
};

export type SourceRevision = { sourceSha: string | null; dirty: boolean | null };

/** Runs one `git` command and returns its trimmed stdout, or `null` when git cannot answer. */
export type GitRunner = (args: string[]) => string | null;

export const runGit: GitRunner = (args) => {
  try {
    const result = Bun.spawnSync(['git', ...args], {
      cwd: PLAYGROUND_ROOT,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    return result.exitCode === 0 ? result.stdout.toString().trim() : null;
  } catch {
    return null;
  }
};

/**
 * The source the export was built from. Vercel's checkout names its commit in
 * `VERCEL_GIT_COMMIT_SHA`; anywhere else `git rev-parse HEAD` does. The tree is dirty when
 * `git status --porcelain` prints anything.
 */
export function readSourceRevision(
  vercelGitCommitSha = readEnvironmentConfiguration().vercelGitCommitSha,
  git: GitRunner = runGit,
): SourceRevision {
  const sourceSha =
    vercelGitCommitSha !== undefined && vercelGitCommitSha !== ''
      ? vercelGitCommitSha
      : git(['rev-parse', 'HEAD']) || null;
  const status = git(['status', '--porcelain']);
  return { sourceSha, dirty: status === null ? null : status.length > 0 };
}

/**
 * `process.resourceUsage().maxRSS` is in kibibytes on every platform (Node normalizes the
 * kernel's units), so the report's byte value is that number times 1024.
 */
export function peakResidentSetBytes(maximumResidentSetKibibytes: number): number {
  return maximumResidentSetKibibytes * 1024;
}

export type ExportReportInput = {
  directory: string;
  routes: readonly string[];
  exportDurationMilliseconds: number;
  maximumResidentSetKibibytes: number;
  revision?: SourceRevision;
  nodeEnv?: string | null;
};

export async function createExportReport(input: ExportReportInput): Promise<ExportReport> {
  const revision = input.revision ?? readSourceRevision();
  return {
    version: 1,
    routes: [...input.routes],
    sourceSha: revision.sourceSha,
    dirty: revision.dirty,
    nodeEnv:
      input.nodeEnv === undefined
        ? (readEnvironmentConfiguration().nodeEnv ?? null)
        : input.nodeEnv,
    exportDurationMilliseconds: input.exportDurationMilliseconds,
    peakResidentSetBytes: peakResidentSetBytes(input.maximumResidentSetKibibytes),
    buildDigest: buildDigestOf(await createDigestManifest(input.directory)),
  };
}

export async function writeExportReport(path: string, report: ExportReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Validate a parsed report, or explain which field is wrong. */
export function parseExportReport(value: unknown): ExportReport {
  if (typeof value !== 'object' || value === null) {
    throw new Error('[static-playground] export report is not a JSON object');
  }
  const candidate: Partial<Record<keyof ExportReport, unknown>> = value;
  const problems = [
    candidate.version === 1 ? null : 'version',
    Array.isArray(candidate.routes) &&
    candidate.routes.every((route): route is string => typeof route === 'string')
      ? null
      : 'routes',
    isNullableString(candidate.sourceSha) ? null : 'sourceSha',
    candidate.dirty === null || typeof candidate.dirty === 'boolean' ? null : 'dirty',
    isNullableString(candidate.nodeEnv) ? null : 'nodeEnv',
    isFiniteNonNegative(candidate.exportDurationMilliseconds) ? null : 'exportDurationMilliseconds',
    isFiniteNonNegative(candidate.peakResidentSetBytes) ? null : 'peakResidentSetBytes',
    typeof candidate.buildDigest === 'string' && /^[a-f0-9]{64}$/.test(candidate.buildDigest)
      ? null
      : 'buildDigest',
  ].filter((problem) => problem !== null);
  if (problems.length > 0) {
    throw new Error(`[static-playground] export report has invalid fields: ${problems.join(', ')}`);
  }
  return candidate as ExportReport;
}
