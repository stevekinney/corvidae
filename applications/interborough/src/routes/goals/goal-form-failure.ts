/**
 * What the goal form says when a request fails (COR-2017, rows 68r and 68s): a sentence for the
 * alert above the footer's buttons, built from the fault the Bureau answered with. The pages put
 * what failed first and what is kept after it, so the person reads that nothing was lost.
 */
import { HttpClientError } from '@lostgradient/weft/client';

import { GOALS_COPY } from '../../app/copy/goals.ts';
import { wireCodeOf } from '../../lib/bureau-client.ts';
import { faultTreatment } from '../../lib/faults.ts';

const copy = GOALS_COPY.form;

/** The leading path of an issue the Bureau names inside a check's configuration (`bureau.goals.create`, COR-2117). */
const CONFIGURATION_PATH = ['validator', 'configuration'] as const;

/**
 * The fields of a check's configuration an `InvalidParams` fault names, each by its path inside the
 * configuration, for the form to show on the field. An issue about the goal rather than the
 * configuration, and any other fault, names none.
 */
export function configurationIssuesOf(
  error: unknown,
): { readonly path: readonly (string | number)[]; readonly message: string }[] {
  if (!(error instanceof HttpClientError) || wireCodeOf(error) !== 'InvalidParams') return [];
  const issues: unknown = error.data?.['issues'];
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue: unknown) => {
    if (typeof issue !== 'object' || issue === null) return [];
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (
      !Array.isArray(path) ||
      typeof message !== 'string' ||
      !path.every((segment) => typeof segment === 'string' || typeof segment === 'number') ||
      !CONFIGURATION_PATH.every((segment, index) => path[index] === segment)
    ) {
      return [];
    }
    return [{ path: path.slice(CONFIGURATION_PATH.length), message }];
  });
}

/** What a request that failed says: the title and sentence for the alert, and the Bureau's code for tests and tooling. */
export type GoalFormFailure = {
  readonly title: string;
  readonly message: string;
  readonly code: string;
};

/** `message` ended with one full stop, so a sentence can follow it. */
function sentence(message: string): string {
  const trimmed = message.trim().replace(/[.\s]+$/, '');
  return trimmed === '' ? '' : `${trimmed}.`;
}

/**
 * The words for a fault: "Interborough didn't answer." when no answer came, else what the Bureau
 * said, followed by what is kept.
 */
function failureOf(title: string, error: unknown, kept: string): GoalFormFailure {
  const treatment = faultTreatment(error);
  const said =
    treatment.kind === 'unreachable' || treatment.kind === 'internal'
      ? copy.unreachable
      : sentence(treatment.message);
  return {
    title,
    message: [said, kept].filter((part) => part !== '').join(' '),
    code: wireCodeOf(error) ?? '',
  };
}

/** A create that did not go through. Nothing was saved, and what was typed is still on the page. */
export function createFailure(error: unknown): GoalFormFailure {
  return failureOf(copy.failedTitle, error, copy.kept);
}

/**
 * A save that did not go through. A goal that moved since it was read (`StaleRevision`) says so, and
 * every other fault says what the Bureau did, then that nothing was changed.
 */
export function saveFailure(error: unknown): GoalFormFailure {
  if (wireCodeOf(error) === 'StaleRevision') {
    return {
      title: copy.edit.failedTitle,
      message: `${copy.edit.changed} ${copy.edit.kept}`,
      code: 'StaleRevision',
    };
  }
  const failure = failureOf(copy.edit.failedTitle, error, copy.edit.kept);
  // The design's own sentence for a save is "Nothing was changed.", with no word on who did not answer.
  return failure.message.startsWith(copy.unreachable)
    ? { ...failure, message: copy.edit.kept }
    : failure;
}
