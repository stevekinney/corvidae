import { SCROLLBACK_LINES } from '../components/terminal/terminal-engine-adapter.ts';
import type { TextExport } from './export.ts';
import type { SnapshotView } from './inspection-controller.ts';
import {
  EXPORT_BYTE_LIMIT,
  EXPORT_LINE_LIMIT,
  SEARCH_MATCH_LIMIT,
  SEARCH_QUERY_CODE_POINT_LIMIT,
  SEARCH_TEXT_BYTE_LIMIT,
} from './inspection-types.ts';
import type { SearchView } from './search.ts';

/**
 * The words the inspection surfaces show. They state counts and bounds, never retained output, so
 * they are safe to announce and to log.
 */

const number = (value: number): string => value.toLocaleString('en-US');

/** What the search status line says. */
export function describeSearch(view: SearchView): string {
  let message: string;
  switch (view.status) {
    case 'idle':
      return '';
    case 'too-long':
      return `The search is longer than ${SEARCH_QUERY_CODE_POINT_LIMIT} characters.`;
    case 'unavailable':
      return 'Output unavailable.';
    case 'no-matches':
      message = 'No matches.';
      break;
    case 'matches':
      if (view.index === undefined) {
        message = view.capped
          ? `More than ${number(SEARCH_MATCH_LIMIT)} matches.`
          : `${number(view.count)} ${view.count === 1 ? 'match' : 'matches'}.`;
      } else {
        message = `Match ${number(view.index + 1)} of ${number(view.count)}${
          view.capped ? ' or more' : ''
        }${view.wrapped ? ', wrapped around' : ''}.`;
      }
      break;
  }
  return view.truncated
    ? `${message} Only the most recent ${number(SEARCH_TEXT_BYTE_LIMIT)} bytes were searched.`
    : message;
}

/** The notices above a snapshot: empty, truncated, stale, replaced, and what Download will save. */
export function describeSnapshot(shown: SnapshotView): string[] {
  const notices: string[] = [];
  if (shown.snapshot.text === '') notices.push('No retained output.');
  if (shown.snapshot.truncated) {
    notices.push(
      `Snapshot truncated: earlier output was omitted. The most recent ${number(shown.snapshot.bytes)} bytes are shown. The terminal keeps at most ${number(SCROLLBACK_LINES)} lines.`,
    );
  }
  if (shown.replaced) {
    notices.push('Snapshot stale: the session was replaced, so this snapshot cannot be refreshed.');
  } else if (shown.stale) {
    notices.push('Snapshot stale: the terminal has changed since it was taken.');
  }
  notices.push(describeExport(shown.snapshot.export));
  return notices;
}

/** What Download will save, stated before anything is saved. */
export function describeExport(result: TextExport): string {
  if (!result.truncated) {
    return `Download ready: ${number(result.exportedBytes)} bytes of plain text.`;
  }
  return `Download truncated: earlier output was omitted. The file holds the most recent ${number(result.exportedBytes)} of at least ${number(result.retainedBytes)} retained bytes, within the limit of ${number(EXPORT_BYTE_LIMIT)} bytes or ${number(EXPORT_LINE_LIMIT)} lines, cut at a whole line or character. Nothing is added to the file to mark the cut.`;
}
