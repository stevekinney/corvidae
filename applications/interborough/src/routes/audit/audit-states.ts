/**
 * What the audit log says when it has no event to list (rows 82t, 82w, 83e and 83h): why a read
 * failed, what filters that match nothing did not find, and why an export did not finish. Each is
 * worded from the facts, so the sentence names the status the server answered with, and the empty
 * state says "Nothing by agents was recorded today." for the filters it was asked with.
 */
import { HttpClientError } from '@lostgradient/weft';

import { AUDIT_COPY } from '../../app/copy.ts';
import { classifyFault, isNetworkFailure } from '../../lib/faults.ts';
import type { AuditDraft } from './audit-filter.ts';

/** A search title longer than this ends with an ellipsis, so a pasted paragraph is not a heading. */
const SEARCH_TITLE_LENGTH = 80;

/** The title and sentence of a read that did not give the page its events. */
export interface AuditLoadFailure {
  readonly title: string;
  readonly description: string;
}

/**
 * What a failed read says. A server error reads "The server answered with an error (500)", a
 * refusal also carries the server's own words, since it is something to fix and not something that
 * "nothing you did caused", and a read that got no answer says so.
 */
export function auditLoadFailure(error: unknown): AuditLoadFailure {
  const copy = AUDIT_COPY.failed;
  if (isNetworkFailure(error)) return { title: copy.title, description: copy.noAnswer };
  if (error instanceof HttpClientError) {
    return {
      title: copy.title,
      description:
        classifyFault(error)?.kind === 'unauthorized'
          ? copy.refused(error.status, error.message)
          : copy.answered(error.status),
    };
  }
  return { title: copy.title, description: copy.unknown };
}

/** The sentence that says an export did not finish: the server stopped, or never answered. */
export function auditExportFailure(error: unknown): string {
  return isNetworkFailure(error)
    ? AUDIT_COPY.exportFailed.noAnswer
    : AUDIT_COPY.exportFailed.answered;
}

/** The title and sentence of the empty state for filters that match nothing. */
export interface AuditNoMatches {
  readonly title: string;
  readonly description: string;
}

/** The search text as a title names it: trimmed, and cut where it would not fit a heading. */
function searchTitleText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > SEARCH_TITLE_LENGTH
    ? `${trimmed.slice(0, SEARCH_TITLE_LENGTH).trimEnd()}…`
    : trimmed;
}

/**
 * What filters that match nothing say. A search names itself in the title and says how to search.
 * Without one, the sentence says what was not recorded, in the words of the filters that are set:
 * "Nothing approved by you was recorded in the last 30 days. Try a longer period."
 */
export function auditNoMatches(draft: AuditDraft): AuditNoMatches {
  const copy = AUDIT_COPY.noMatches;
  if (draft.text.trim() !== '') {
    return {
      title: copy.titleForSearch(searchTitleText(draft.text)),
      description: copy.searchHint,
    };
  }
  const subject = [
    copy.nothing,
    ...(draft.action === '' ? [] : [copy.actionWords[draft.action]]),
    ...(draft.actor === '' ? [] : [copy.byActor[draft.actor]]),
    copy.wasRecorded[draft.period],
  ].join(' ');
  const suggestion =
    draft.period === 'all'
      ? copy.tryAnotherFilter
      : draft.period === '90d'
        ? copy.tryAllTime
        : copy.tryLongerPeriod;
  return { title: copy.title, description: `${subject} ${suggestion}` };
}
