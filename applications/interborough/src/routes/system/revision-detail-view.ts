/**
 * Render-ready mapping for one `weft.workflows.revisions.get` response
 * (COR-1464). Framework-free, like `workflow-revisions-view.ts`, whose
 * structural guard it reuses: a response that fails the guard is a malformed
 * response, never a partial record.
 */
import { isWorkflowRevisionRecordLike } from './workflow-revisions-view.ts';

/** One `<dt>`/`<dd>` pair in the detail's description list. */
export interface RevisionDetailField {
  readonly term: string;
  readonly value: string;
}

/** An installed revision's full record, ready to render. */
export interface RevisionDetail {
  readonly fields: readonly RevisionDetailField[];
  /** The manifest's `contract`, as indented JSON. */
  readonly contractJson: string;
}

/** The detail for `raw`, or `undefined` when it is not a revision record. */
export function revisionDetail(raw: unknown): RevisionDetail | undefined {
  if (!isWorkflowRevisionRecordLike(raw)) return undefined;
  const { manifest, installedAt } = raw;
  return {
    fields: [
      { term: 'Revision', value: manifest.revision },
      { term: 'Workflow name', value: manifest.name },
      { term: 'Workflow version', value: manifest.workflowVersion },
      { term: 'Manifest version', value: String(manifest.manifestVersion) },
      { term: 'Contract hash', value: manifest.contractHash },
      { term: 'Installed at', value: new Date(installedAt).toISOString() },
    ],
    contractJson: JSON.stringify(manifest.contract, null, 2),
  };
}

/** What a successful `weft.workflows.revisions.install` response names: the installed `(name, revision)`. */
export interface InstalledRevisionSummary {
  readonly name: string;
  readonly revision: string;
}

/** The installed `(name, revision)` of an install response, or `undefined` when it is not a revision record. */
export function installedRevisionSummary(raw: unknown): InstalledRevisionSummary | undefined {
  if (!isWorkflowRevisionRecordLike(raw)) return undefined;
  return { name: raw.manifest.name, revision: raw.manifest.revision };
}
