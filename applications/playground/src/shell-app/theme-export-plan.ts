/**
 * The export menu's contents and gates (COR-486). Each artifact says exactly what it is, is
 * built only from the checked snapshot, and is blocked with a reason rather than hidden.
 *
 * Gates, per the spec: an invalid source or an accessibility error blocks the normal CSS and
 * portable exports; Needs review and advisory findings hold them until acknowledged (an
 * acknowledgement never turns a finding into a pass); the source envelope and the validation
 * report are always available, and the source is labeled unvalidated when it is. A base this
 * build does not ship cannot be evaluated, so only its source can leave.
 */

import { renderThemeStylesheet, StylesheetError } from '@lostgradient/cinder/tokens/runtime';

import { THEME_CONTEXT_IDS, type ThemeContextId } from './theme-draft-types.ts';
import { envelopeDownload, themeFileSlug } from './theme-envelope.ts';
import { planPortable, type PortablePlan } from './theme-export-portable.ts';
import {
  buildPortabilityReport,
  buildValidationReport,
  type ReportFile,
} from './theme-export-report.ts';
import type { ExportSnapshot } from './theme-export-snapshot.ts';

export type ExportKind = 'source' | 'css' | 'portable' | 'portable-subset' | 'report';

export type ExportArtifact = {
  kind: ExportKind;
  /** The menu label: what the file is, in plain words. */
  title: string;
  description: string;
  /** A short badge such as `Unvalidated`, or `null`. */
  caveat: string | null;
  files: ReportFile[];
  available: boolean;
  /** Why it is blocked, or `null` when available. */
  blockedReason: string | null;
};

export type ExportPlan = {
  artifacts: ExportArtifact[];
  portable: PortablePlan;
  /** Needs-review plus advisory findings the user may acknowledge to release CSS and DTCG. */
  acknowledgeable: number;
};

type Block = string | null;

function normalBlock(
  snapshot: ExportSnapshot,
  acknowledged: boolean,
  acknowledgeable: number,
): Block {
  if (!snapshot.baseIsCurrent) {
    return 'This theme was written against a different Cinder base than this build ships, so it cannot be evaluated here. Download its source instead.';
  }
  if (!snapshot.sourceIsValid)
    return 'The theme source is invalid. Fix it, or download the unvalidated source.';
  if (snapshot.readiness === 'blocked-accessibility-errors') {
    const n = snapshot.counts['accessibility-error'];
    return `${n} accessibility ${n === 1 ? 'error blocks' : 'errors block'} this export. Fix ${n === 1 ? 'it' : 'them'} in Checks, or download the source.`;
  }
  if (acknowledgeable > 0 && !acknowledged) {
    return `${acknowledgeable} ${acknowledgeable === 1 ? 'item needs' : 'items need'} your acknowledgement first. Acknowledging does not make a finding pass.`;
  }
  return null;
}

function cssFile(snapshot: ExportSnapshot): ReportFile {
  const maps = Object.fromEntries(
    THEME_CONTEXT_IDS.map((context: ThemeContextId) => {
      const evaluation = snapshot.evaluations[context];
      if (!evaluation.ok) throw new StylesheetError(`${context} did not evaluate.`);
      return [context, Object.fromEntries(evaluation.properties.map((p) => [p.name, p.value]))];
    }),
  ) as Record<ThemeContextId, Record<string, string>>;
  const { envelope } = snapshot;
  return {
    filename: `${themeFileSlug(envelope.name)}-${envelope.id.slice(0, 8)}.cinder-theme.css`,
    mime: 'text/css',
    text: renderThemeStylesheet(maps, {
      identity: `${envelope.name}, revision ${snapshot.revision}, Cinder ${envelope.base.packageVersion} ${envelope.base.sourceDigest}`,
    }),
  };
}

/** Build every artifact for a snapshot. Blocked artifacts carry no files. */
export function planExports(snapshot: ExportSnapshot, acknowledged: boolean): ExportPlan {
  const acknowledgeable = snapshot.counts['needs-review'] + snapshot.counts.advisory;
  const normal = normalBlock(snapshot, acknowledged, acknowledgeable);
  const portable: PortablePlan =
    snapshot.baseIsCurrent && snapshot.sourceIsValid
      ? planPortable(snapshot)
      : {
          documents: [],
          omitted: [],
          recipesNotExported: [],
          metadataStripped: 0,
          sourceTokensIncluded: 0,
        };
  const validated = snapshot.sourceIsValid && snapshot.baseIsCurrent;

  const complete: Block =
    normal ??
    (portable.omitted.length > 0
      ? `${portable.omitted.length} tokens have no faithful DTCG representation (${portable.omitted
          .slice(0, 4)
          .map((o) => o.path)
          .join(
            ', ',
          )}${portable.omitted.length > 4 ? ', ...' : ''}). Export the portable subset to see them listed.`
      : null);

  let cssResult: ReportFile[] = [];
  let cssBlock: Block = normal;
  if (normal === null) {
    try {
      cssResult = [cssFile(snapshot)];
    } catch (error) {
      cssBlock = error instanceof Error ? error.message : 'The stylesheet could not be written.';
    }
  }

  const artifacts: ExportArtifact[] = [
    {
      kind: 'source',
      title: 'Cinder Theme v1 source (JSON)',
      description:
        'Lossless: the embedded Cinder base, your overrides and CSS-only edits, aliases intact. A Cinder format, not a standard DTCG document. Re-import it to get this theme back exactly.',
      caveat: validated ? null : 'Unvalidated',
      files: [envelopeDownload(snapshot.envelope)],
      available: true,
      blockedReason: null,
    },
    {
      kind: 'css',
      title: 'Deployment CSS',
      description:
        'A standalone stylesheet in the cinder-theme layer for all six contexts: root and descendant [data-theme], reduced motion and forced reduced motion. No reset or component rules. Font availability is environment-dependent.',
      caveat: null,
      files: cssResult,
      available: cssBlock === null,
      blockedReason: cssBlock,
    },
    {
      kind: 'portable',
      title: 'Portable DTCG documents (complete, 6 files)',
      description:
        'One DTCG 2025.10 token document per concrete context, named <theme>-<light|dark>-<default|reduced|forced-reduced-motion>.tokens.json. Blocked when any value has no faithful DTCG form.',
      caveat: null,
      files:
        complete === null
          ? portable.documents.map(({ filename, text }) => ({
              filename,
              mime: 'application/json',
              text,
            }))
          : [],
      available: complete === null,
      blockedReason: complete,
    },
    {
      kind: 'portable-subset',
      title: 'Portable subset (6 files and a portability report)',
      description: `The same documents without the tokens that have no faithful DTCG form${
        portable.omitted.length > 0
          ? ` (${portable.omitted.length} omitted, listed in the report)`
          : ''
      }. Nothing stands in for an omitted value.`,
      caveat: 'Subset',
      files:
        normal === null
          ? [
              ...portable.documents.map(({ filename, text }) => ({
                filename,
                mime: 'application/json',
                text,
              })),
              buildPortabilityReport(snapshot, portable),
            ]
          : [],
      available: normal === null,
      blockedReason: normal,
    },
    {
      kind: 'report',
      title: 'Validation report (JSON)',
      description:
        'The exact Cinder base and revision checked, a findings summary, and the limitations that remain.',
      caveat: null,
      files: [buildValidationReport(snapshot, portable)],
      available: true,
      blockedReason: null,
    },
  ];
  return { artifacts, portable, acknowledgeable };
}
