// The schema of a chef worker's report file, `reports/<issue>.json` under the coordinator's
// execution state (`<main checkout>/tmp/chef/execution-state`), never in the worker's worktree. The
// SubagentStop hook (`scripts/chef/session-fences.ts`) refuses a `chef-worker` stop without a report
// that passes `validateReport`, so the worker writes it with `scripts/chef/report.ts write`.
//
// `<issue>` is the brief's file stem: `COR-1` for one issue, `COR-1_COR-2` for a batch.
//
// A criterion's status is the durable per-criterion state (corrections review, section 7), and the
// same four values the ledger committed beside the code records:
//   met-on-main      the criterion already held on `main`;
//   met-on-branch    the branch meets it, with the evidence named;
//   not-met          not met, so the report is BLOCKED;
//   needs-decision   the criteria conflict or the brief is silent, so the report is BLOCKED.
//
// This module is pure: no file system, no clock.

export const criterionStatuses = [
  'met-on-main',
  'met-on-branch',
  'not-met',
  'needs-decision',
] as const;
export type CriterionStatus = (typeof criterionStatuses)[number];

export type ReportCriterion = {
  readonly id: string;
  readonly status: CriterionStatus;
  readonly evidence?: string;
};

export type WorkerReport = {
  /** The brief's file stem: one issue, or the issues of a batch joined by `_`. */
  readonly issue: string;
  /** The brief version the worker read (`Brief version:` in the brief file). */
  readonly briefVersion: string;
  /** The commit the criteria were checked at; committing the ledger moves HEAD past it. */
  readonly head: string;
  /** The focused-checks result line, quoted. */
  readonly checks: string;
  readonly status: 'READY' | 'BLOCKED';
  /** Why the report is BLOCKED. */
  readonly reason?: string;
  readonly criteria: readonly ReportCriterion[];
  /** The ids of the correction entries the worker read (`corrections/<issue>.jsonl`). */
  readonly correctionsRead: readonly string[];
};

export type ReportValidation =
  | { readonly ok: true; readonly report: WorkerReport }
  | { readonly ok: false; readonly errors: string[] };

const issueStem = /^[A-Za-z][A-Za-z0-9]*-\d+(?:_[A-Za-z][A-Za-z0-9]*-\d+)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function criterionErrors(value: unknown, index: number): string[] {
  if (!isRecord(value)) return [`criteria[${index}] is not an object`];
  const errors: string[] = [];
  if (!nonEmptyText(value['id'])) errors.push(`criteria[${index}].id is missing`);
  if (!criterionStatuses.some((status) => status === value['status']))
    errors.push(`criteria[${index}].status is one of ${criterionStatuses.join(', ')}`);
  if (value['evidence'] !== undefined && typeof value['evidence'] !== 'string')
    errors.push(`criteria[${index}].evidence is text`);
  return errors;
}

/** Checks an untrusted parsed report against the schema; every problem is named. */
export function validateReport(value: unknown): ReportValidation {
  if (!isRecord(value)) return { ok: false, errors: ['the report is not a JSON object'] };
  const errors: string[] = [];
  if (typeof value['issue'] !== 'string' || !issueStem.test(value['issue']))
    errors.push('issue is the brief file stem, such as COR-123 or COR-123_COR-124');
  if (!nonEmptyText(value['briefVersion'])) errors.push('briefVersion is missing');
  if (typeof value['head'] !== 'string' || !/^[0-9a-f]{7,40}$/.test(value['head']))
    errors.push('head is a commit SHA (7 to 40 lowercase hex characters)');
  if (!nonEmptyText(value['checks'])) errors.push('checks is the focused-checks result line');
  const status = value['status'];
  if (status !== 'READY' && status !== 'BLOCKED') errors.push('status is READY or BLOCKED');
  if (status === 'BLOCKED' && !nonEmptyText(value['reason']))
    errors.push('a BLOCKED report names its reason');
  if (value['reason'] !== undefined && typeof value['reason'] !== 'string')
    errors.push('reason is text');
  const criteria = value['criteria'];
  if (!Array.isArray(criteria) || criteria.length === 0)
    errors.push('criteria lists every acceptance criterion with a status');
  else {
    criteria.forEach((criterion, index) => errors.push(...criterionErrors(criterion, index)));
    const ids = criteria.map((criterion) => (isRecord(criterion) ? criterion['id'] : undefined));
    if (new Set(ids).size !== ids.length) errors.push('criteria ids are unique');
    if (
      status === 'READY' &&
      criteria.some(
        (criterion) =>
          isRecord(criterion) &&
          (criterion['status'] === 'not-met' || criterion['status'] === 'needs-decision'),
      )
    )
      errors.push('a READY report has no not-met or needs-decision criterion; report BLOCKED');
  }
  const read = value['correctionsRead'];
  if (!Array.isArray(read) || read.some((id) => typeof id !== 'string'))
    errors.push('correctionsRead lists the ids of the corrections read (an empty list if none)');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, report: value as unknown as WorkerReport };
}

/** The brief version a brief's text carries: its `Brief version:` line, if it has one. */
export function briefVersionIn(briefText: string): string | undefined {
  return /^Brief version: ([0-9a-f]+)$/m.exec(briefText)?.[1];
}

/** The brief's file stem named by a dispatch prompt (the first `tmp/chef/briefs/<stem>.md`). */
export function briefStemIn(prompt: string): string | undefined {
  return /tmp\/chef\/briefs\/([A-Za-z0-9_-]+)\.md/.exec(prompt)?.[1];
}

export type CorrectionEntry = {
  readonly id: string;
  readonly at: string;
  /** The branch the amendment is tied to. */
  readonly branch: string;
  readonly text: string;
};

/** The ids of corrections the report has not read. */
export function unreadCorrections(
  corrections: readonly CorrectionEntry[],
  report: WorkerReport,
): CorrectionEntry[] {
  return corrections.filter((entry) => !report.correctionsRead.includes(entry.id));
}

/**
 * Image paths in a volatile place: a session's temporary folder, `/tmp` or `/private/tmp`, which a
 * reboot clears. Owner screenshots are stored with the run (`report.ts attach`) instead.
 */
export function volatileImagePaths(text: string): string[] {
  return [
    ...text.matchAll(
      /(?:\/private)?\/(?:tmp|var\/folders)\/[^\s`'")\]]*\.(?:png|jpe?g|gif|webp|heic)\b/gi,
    ),
  ].map((match) => match[0]);
}

/** The durable per-criterion ledger, one file per issue so a merge never conflicts on a shared one. */
export type CriteriaLedger = {
  readonly issue: string;
  readonly branch: string;
  /** The commit the criteria were checked at; never required to equal the branch tip. */
  readonly checkedAt: string;
  readonly briefVersion: string;
  readonly status: 'READY' | 'BLOCKED';
  readonly criteria: readonly ReportCriterion[];
};

/** The ledger a report writes. */
export function ledgerOf(report: WorkerReport, branch: string): CriteriaLedger {
  return {
    issue: report.issue,
    branch,
    checkedAt: report.head,
    briefVersion: report.briefVersion,
    status: report.status,
    criteria: report.criteria,
  };
}
