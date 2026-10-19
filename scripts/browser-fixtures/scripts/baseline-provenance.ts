/**
 * Provenance and version pins for the committed Linux visual baselines.
 *
 * Ported from cinder's `testing/testing/scripts/baseline-provenance.ts` and
 * adapted for corvidae (COR-1512): the authoritative renderer is native
 * `linux/arm64` inside `mcr.microsoft.com/playwright:v<version>-jammy`, the
 * Playwright version comes from `bun.lock`, and Bun from the root
 * `packageManager`. See `scripts/browser-fixtures/visual-baselines.md`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { parseComponentScopeValue } from '@lostgradient/testing';

/**
 * Version 2 adds `suiteExitCode` (COR-1512): an update may complete with accepted
 * behavioural failures, and provenance records how the suite exited.
 */
export const BASELINE_PROVENANCE_SCHEMA_VERSION = 2;

/**
 * Every committed baseline is rendered on this architecture. Cinder required x64
 * to match its `ubuntu-latest` CI; corvidae has no CI and this Apple Silicon host
 * has no native amd64, where emulation ran about 17 tests a minute and timed out
 * behavioural specs. So native arm64 is authoritative (COR-1512).
 */
export const REQUIRED_BASELINE_ARCHITECTURE = 'arm64';

/** The Ubuntu release of the Playwright base image, and of every committed baseline. */
export const REQUIRED_OS_CODENAME = 'jammy';

export const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../..');
export const BROWSER_FIXTURES_ROOT = resolve(import.meta.dirname, '..');
/** Repository-relative directory holding the committed Linux baselines. */
export const LINUX_BASELINE_DIRECTORY = 'scripts/browser-fixtures/snapshots/chromium/linux';
export const PROVENANCE_FILE_NAME = 'provenance.json';

export type BaselineComponentScope = 'all' | string[];

/**
 * One component's baselines as a scoped refresh last rendered them (COR-1574). The
 * renderer pins are the full-run record's: a scoped render under any other renderer
 * is refused, so only the commit and the suite's exit code can differ.
 */
export type ComponentRender = { renderedSourceSha: string; suiteExitCode: number };

export type BaselineProvenance = {
  schemaVersion: typeof BASELINE_PROVENANCE_SCHEMA_VERSION;
  componentScope: BaselineComponentScope;
  renderedSourceSha: string;
  playwrightVersion: string;
  osCodename: string;
  architecture: string;
  dockerImageTag: string;
  /** 0 when every case passed; 1 when the suite completed with failures. */
  suiteExitCode: number;
  /**
   * Components a scoped refresh re-rendered since the full run this record describes, by
   * slug. Only the host wrapper writes it, and a full run's record has none (COR-1574).
   */
  componentRenders?: Record<string, ComponentRender>;
};

export type BaselineProvenanceInput = Omit<
  BaselineProvenance,
  'schemaVersion' | 'componentScope' | 'componentRenders'
> & {
  componentScope: string | string[] | undefined;
};

/** The renderer image tag. Neutral corvidae name; the version always comes from bun.lock. */
export function dockerImageTagForPlaywrightVersion(playwrightVersion: string): string {
  return `corvidae-browser-fixtures:${playwrightVersion}-${REQUIRED_OS_CODENAME}-${REQUIRED_BASELINE_ARCHITECTURE}`;
}

/** The Playwright base image the Dockerfile builds from for a version. */
export function playwrightBaseImage(playwrightVersion: string): string {
  return `mcr.microsoft.com/playwright:v${playwrightVersion}-${REQUIRED_OS_CODENAME}`;
}

/**
 * The resolved `@playwright/test` version recorded in `bun.lock`. `package.json`
 * holds a range, so the lockfile is the only exact pin the renderer can match.
 */
export function readLockedPlaywrightVersion(lockfileText: string): string {
  const match = /"@playwright\/test": \["@playwright\/test@(\d+\.\d+\.\d+)"/.exec(lockfileText);
  if (!match?.[1]) {
    throw new Error('bun.lock does not resolve @playwright/test to an exact version.');
  }
  return match[1];
}

/** The exact Bun version pinned by the root `packageManager` field. */
export function readPinnedBunVersion(packageManifestText: string): string {
  const parsed: unknown = JSON.parse(packageManifestText);
  const field =
    typeof parsed === 'object' && parsed !== null && 'packageManager' in parsed
      ? parsed.packageManager
      : undefined;
  const match = typeof field === 'string' ? /^bun@(\d+\.\d+\.\d+)$/.exec(field) : null;
  if (!match?.[1]) {
    throw new Error(
      `packageManager must pin an exact Bun version (bun@x.y.z); got ${String(field)}`,
    );
  }
  return match[1];
}

export type RepositoryPins = { playwrightVersion: string; bunVersion: string };

/** Read both pins from the repository at `root`. */
export function readRepositoryPins(root: string = REPOSITORY_ROOT): RepositoryPins {
  return {
    playwrightVersion: readLockedPlaywrightVersion(readFileSync(resolve(root, 'bun.lock'), 'utf8')),
    bunVersion: readPinnedBunVersion(readFileSync(resolve(root, 'package.json'), 'utf8')),
  };
}

export function readOsCodename(path = '/etc/os-release'): string | undefined {
  if (!existsSync(path)) return undefined;
  const match = /^VERSION_CODENAME=(.+)$/m.exec(readFileSync(path, 'utf8'));
  return match?.[1]?.replace(/['"]/g, '').trim();
}

export function normalizeProvenanceComponentScope(
  componentScope: string | string[] | undefined,
): BaselineComponentScope {
  if (componentScope === 'all') return 'all';
  if (Array.isArray(componentScope)) {
    return [...new Set(componentScope.map((slug) => slug.trim()).filter(Boolean))].toSorted();
  }
  return parseComponentScopeValue(componentScope);
}

export function createBaselineProvenance(input: BaselineProvenanceInput): BaselineProvenance {
  const componentScope = normalizeProvenanceComponentScope(input.componentScope);
  if (componentScope !== 'all' && componentScope.length === 0) {
    throw new Error('baseline provenance requires an explicit component scope');
  }
  return {
    schemaVersion: BASELINE_PROVENANCE_SCHEMA_VERSION,
    componentScope,
    renderedSourceSha: input.renderedSourceSha,
    playwrightVersion: input.playwrightVersion,
    osCodename: input.osCodename,
    architecture: input.architecture,
    dockerImageTag: input.dockerImageTag,
    suiteExitCode: input.suiteExitCode,
  };
}

/** Parse a committed `provenance.json`, rejecting anything that is not the current schema. */
export function parseBaselineProvenance(text: string): BaselineProvenance {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('provenance.json must contain an object');
  }
  const record = parsed as Record<string, unknown>;
  for (const key of [
    'renderedSourceSha',
    'playwrightVersion',
    'osCodename',
    'architecture',
    'dockerImageTag',
  ]) {
    if (typeof record[key] !== 'string') throw new Error(`provenance.json is missing "${key}"`);
  }
  if (typeof record['suiteExitCode'] !== 'number') {
    throw new Error('provenance.json is missing "suiteExitCode"');
  }
  if (record['schemaVersion'] !== BASELINE_PROVENANCE_SCHEMA_VERSION) {
    throw new Error(`provenance.json schemaVersion must be ${BASELINE_PROVENANCE_SCHEMA_VERSION}`);
  }
  const renders = record['componentRenders'];
  if (renders !== undefined) {
    if (typeof renders !== 'object' || renders === null || Array.isArray(renders)) {
      throw new Error('provenance.json "componentRenders" must be an object keyed by component');
    }
    for (const [slug, render] of Object.entries(renders as Record<string, unknown>)) {
      const entry = (typeof render === 'object' && render !== null ? render : {}) as Record<
        string,
        unknown
      >;
      if (
        typeof entry['renderedSourceSha'] !== 'string' ||
        typeof entry['suiteExitCode'] !== 'number'
      ) {
        throw new Error(
          `provenance.json "componentRenders.${slug}" needs "renderedSourceSha" and "suiteExitCode"`,
        );
      }
    }
  }
  return parsed as BaselineProvenance;
}

const RENDERER_PINS = [
  'playwrightVersion',
  'osCodename',
  'architecture',
  'dockerImageTag',
] as const;

/**
 * The record a scoped refresh writes (COR-1574): the working tree's full-run record,
 * unchanged, plus a `componentRenders` entry for each component the scoped render
 * covered. Refuses a committed record that is not a full run and a scoped render under
 * another renderer, because neither can be described by one full-run record.
 */
export function mergeScopedProvenance(
  committed: BaselineProvenance,
  scoped: BaselineProvenance,
): BaselineProvenance {
  if (scoped.componentScope === 'all') {
    throw new Error('A full run replaces provenance.json; it is not merged.');
  }
  if (committed.componentScope !== 'all') {
    throw new Error(
      `The working tree's provenance.json describes a scoped run (${JSON.stringify(committed.componentScope)}), not a full one; refresh the full set first.`,
    );
  }
  for (const pin of RENDERER_PINS) {
    if (committed[pin] !== scoped[pin]) {
      throw new Error(
        `The scoped render's ${pin} (${scoped[pin]}) differs from the full-run record's (${committed[pin]}); refresh the full set instead.`,
      );
    }
  }
  const renders: Record<string, ComponentRender> = { ...committed.componentRenders };
  for (const slug of scoped.componentScope) {
    renders[slug] = {
      renderedSourceSha: scoped.renderedSourceSha,
      suiteExitCode: scoped.suiteExitCode,
    };
  }
  return {
    ...committed,
    componentRenders: Object.fromEntries(
      Object.entries(renders).toSorted(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * Why a committed `provenance.json` does not describe the authoritative renderer the
 * lockfile pins; empty when it does. The record must be a full run (`componentScope`
 * `'all'`), and every scoped component render it carries must name a commit and a
 * completed suite (COR-1574).
 */
export function committedProvenanceProblems(
  provenance: BaselineProvenance,
  playwrightVersion: string,
): string[] {
  const problems: string[] = [];
  const expect = (field: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) {
      problems.push(`${field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  };
  expect('playwrightVersion', provenance.playwrightVersion, playwrightVersion);
  expect('osCodename', provenance.osCodename, REQUIRED_OS_CODENAME);
  expect('architecture', provenance.architecture, REQUIRED_BASELINE_ARCHITECTURE);
  expect(
    'dockerImageTag',
    provenance.dockerImageTag,
    dockerImageTagForPlaywrightVersion(playwrightVersion),
  );
  expect('componentScope', provenance.componentScope, 'all');
  const completed = (label: string, sha: string, exitCode: number) => {
    if (!COMMIT_SHA.test(sha)) problems.push(`${label} renderedSourceSha is not a commit: ${sha}`);
    if (exitCode !== 0 && exitCode !== 1) {
      problems.push(`${label} suiteExitCode is ${exitCode}, expected 0 or 1`);
    }
  };
  completed('the full run', provenance.renderedSourceSha, provenance.suiteExitCode);
  for (const [slug, render] of Object.entries(provenance.componentRenders ?? {})) {
    completed(`component ${slug}`, render.renderedSourceSha, render.suiteExitCode);
  }
  return problems;
}

export async function writeBaselineProvenance(
  path: string,
  provenance: BaselineProvenance,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(provenance, null, 2)}\n`);
}
