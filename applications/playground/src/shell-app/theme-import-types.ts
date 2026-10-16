/**
 * The shapes of the import preflight (COR-486). An import always ends in exactly one of four
 * outcomes before anything is allowed to touch the draft; the result carries what the dialog
 * shows (axes, unsupported features, findings) and the candidate an Apply would commit.
 */

import type { LimitCode } from './theme-draft-limits.ts';
import type { EditableState, ThemeEnvelope } from './theme-draft-types.ts';

export type PreflightOutcome =
  'cinder-envelope' | 'dtcg-document' | 'unsupported-profile' | 'invalid';

export type ImportFindingCode =
  | LimitCode
  | 'invalid-json'
  | 'not-an-object'
  | 'unrecognized'
  | 'path-traversal'
  | 'duplicate-path'
  | 'prototype-key'
  | 'foreign-css-binding'
  | 'resource-bearing-css'
  | 'unresolved-reference'
  | 'public-type-change'
  | 'css-only-target'
  | 'invalid-source'
  | 'bad-base-digest'
  | 'bad-envelope'
  | 'unknown-context';

export type ImportFinding = { code: ImportFindingCode; path: string; message: string };

/** What an Apply would commit. */
export type ImportCandidate =
  /** A self-contained envelope whose Cinder base is the one this build ships. */
  | { kind: 'envelope'; envelope: ThemeEnvelope }
  /** One DTCG document laid over the open theme's shared overrides. */
  | { kind: 'overlay'; state: EditableState; envelope: ThemeEnvelope };

/** The unchanged input, kept so it can be downloaded after any outcome. */
export type ImportSource = { filename: string; mime: string; text: string } | { file: File };

export type PreflightFact = { label: string; value: string };

export type BaseComparison = {
  packageVersion: string;
  sourceDigest: string;
  currentPackageVersion: string;
  currentSourceDigest: string;
};

export type PreflightResult = {
  outcome: PreflightOutcome;
  headline: string;
  detail: string;
  /** Resolver axes or theme contexts the input declares. */
  axes: string[];
  /** Features recognized but not imported. */
  unsupported: string[];
  findings: ImportFinding[];
  facts: PreflightFact[];
  /** Present on a Cinder envelope: whether it was written against this build's base. */
  base: (BaseComparison & { compatible: boolean }) | null;
  /** The candidate an Apply commits; `null` unless the outcome is a supported one. */
  candidate: ImportCandidate | null;
  source: ImportSource;
};

/** Apply needs a supported outcome and a base this build can evaluate. */
export function canApply(result: PreflightResult): boolean {
  return result.candidate !== null && (result.base === null || result.base.compatible);
}
