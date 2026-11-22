/**
 * How a failure's category is drawn on a badge: its label and its tone (COR-2533). The category is
 * one of the engine's five (`application`, `timeout`, `cancellation`, `resource`, `system`), `null`
 * for a failure it could not sort, and `undefined` for a run that never failed.
 *
 * Nothing here says why a run failed. The sentence, the cause, the step and what to do next come
 * from `bureau.tasks.explain`, so the Run page, Chat, the CLI and the failure explanation panel give
 * one answer and the browser holds no explanation text per category. `run-failure-explanation.svelte`
 * draws that answer, with this badge beside it.
 */
import type { BadgeVariant } from '@lostgradient/cinder';
import type { FailureCategory } from '@lostgradient/weft';

const CATEGORY_LABEL: Readonly<Record<FailureCategory, string>> = {
  application: 'application',
  timeout: 'timeout',
  cancellation: 'cancellation',
  resource: 'resource',
  system: 'system',
};

/** Sentence-case-safe badge label for a failure category; `'uncategorized'` for `null`. */
export function failureCategoryLabel(category: FailureCategory | null | undefined): string {
  if (category === undefined) return '';
  if (category === null) return 'uncategorized';
  return CATEGORY_LABEL[category];
}

const CATEGORY_TONE: Readonly<Record<FailureCategory, BadgeVariant>> = {
  application: 'danger',
  timeout: 'warning',
  cancellation: 'neutral',
  resource: 'warning',
  system: 'danger',
};

/**
 * The badge's tone. A cancellation is a person's doing and reads quietly; a deadline or a spent
 * limit is a warning; a fault in the code or the server, and a failure nothing classifies, is
 * danger.
 */
export function failureCategoryTone(category: FailureCategory | null | undefined): BadgeVariant {
  if (category === undefined || category === null) return 'danger';
  return CATEGORY_TONE[category];
}
