/**
 * The validation report (COR-486): a deterministic JSON record of what was checked. It names
 * the exact Cinder base (package version and source digest) and the revision, summarizes the
 * findings, and lists what the checks do not cover. It is a scoped result for one revision,
 * never a certification, and it contains no timestamp so the same revision reports the same.
 */

import { isShippedBase } from './theme-builder-base.ts';
import { reportFindings } from './theme-check-engine.ts';
import { THEME_CONTEXT_IDS } from './theme-draft-types.ts';
import { themeFileSlug } from './theme-envelope.ts';
import type { PortablePlan } from './theme-export-portable.ts';
import type { ExportSnapshot } from './theme-export-snapshot.ts';

export const REPORT_FORMAT = 'com.lostgradient.cinder.theme-report';

/** Limitations that apply to every report, whatever the findings say. */
export const REPORT_LIMITATIONS: readonly string[] = [
  'Results are scoped to the checked scenes and pairings, WCAG 2.2 AA contrast only. This is not an accessibility certification or a conformance claim.',
  'Font availability and glyph metrics depend on the environment that renders the page; font-family stacks are exported as written and no font is fetched or bundled.',
  'CSS parity is promised against the exact Cinder base named here and the fonts available to the browser.',
  'The Cinder Theme v1 source envelope is a Cinder format, not a standard DTCG document.',
  'Portable DTCG documents omit Cinder-only metadata: CSS bindings, trusted CSS recipes and usage categories.',
];

export type ReportFile = { filename: string; mime: string; text: string };

export function buildValidationReport(
  snapshot: ExportSnapshot,
  portable: PortablePlan,
): ReportFile {
  const { envelope, report, counts } = snapshot;
  const body = {
    format: REPORT_FORMAT,
    version: 1,
    theme: { id: envelope.id, name: envelope.name },
    checked: {
      revision: snapshot.revision,
      contexts: [...THEME_CONTEXT_IDS],
      readiness: snapshot.readiness,
    },
    cinderBase: {
      packageVersion: envelope.base.packageVersion,
      sourceDigest: envelope.base.sourceDigest,
      matchesThisBuild: isShippedBase(envelope.base),
    },
    sourceValidity: report.sourceValidity,
    findings: {
      summary: {
        'invalid-source': counts['invalid-source'],
        'accessibility-error': counts['accessibility-error'],
        'needs-review': counts['needs-review'],
        advisory: counts.advisory,
        pass: counts.pass,
        exempt: counts.exempt,
      },
      records: reportFindings(report).map((record) => ({
        id: record.id,
        rule: record.ruleId,
        severity: record.severity,
        context: record.context,
        message: record.message,
        measured: record.measured,
        required: record.required,
        tokenPaths: record.tokenPaths,
      })),
    },
    portability: {
      omittedTokens: portable.omitted,
      recipesNotExported: portable.recipesNotExported.length,
      cinderMetadataBlocksRemoved: portable.metadataStripped,
      sourceTokensIncluded: portable.sourceTokensIncluded,
    },
    limitations: [...REPORT_LIMITATIONS, ...report.untested],
  };
  return {
    filename: `${themeFileSlug(envelope.name)}-${envelope.id.slice(0, 8)}.validation-report.json`,
    mime: 'application/json',
    text: `${JSON.stringify(body, null, 2)}\n`,
  };
}

/** The portability report that accompanies an explicit portable subset export. */
export function buildPortabilityReport(
  snapshot: ExportSnapshot,
  portable: PortablePlan,
): ReportFile {
  const { envelope } = snapshot;
  const body = {
    format: 'com.lostgradient.cinder.portability-report',
    version: 1,
    theme: { id: envelope.id, name: envelope.name },
    revision: snapshot.revision,
    cinderBase: {
      packageVersion: envelope.base.packageVersion,
      sourceDigest: envelope.base.sourceDigest,
    },
    complete: portable.omitted.length === 0,
    summary:
      portable.omitted.length === 0
        ? 'Every token has a faithful DTCG representation.'
        : `${portable.omitted.length} tokens have no faithful DTCG representation and are omitted. No placeholder was written in their place.`,
    omittedTokens: portable.omitted,
    recipesNotExported: portable.recipesNotExported,
    cinderMetadataBlocksRemoved: portable.metadataStripped,
    documents: portable.documents.map((document) => ({
      context: document.context,
      filename: document.filename,
    })),
  };
  return {
    filename: `${themeFileSlug(envelope.name)}-${envelope.id.slice(0, 8)}.portability-report.json`,
    mime: 'application/json',
    text: `${JSON.stringify(body, null, 2)}\n`,
  };
}
