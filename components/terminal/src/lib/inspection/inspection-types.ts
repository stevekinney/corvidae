import type { ClearScope } from '../components/terminal/terminal-engine-adapter.ts';
import {
  DEFAULT_PROJECTION_BYTE_LIMIT,
  type TerminalProjection,
} from '../components/terminal/terminal-projection.ts';

/**
 * The bounds for searching, reading and exporting retained terminal output. The byte and line
 * figures come from `documentation/terminal/security-and-budgets.md`: the accessible snapshot is
 * 64 KiB and the export is 1 MiB, and the scrollback is 10,000 lines. Nothing here is configurable
 * by output, and none of it is raised to make a test pass.
 */

/** The longest search query, in code points. A longer query is refused, never cut. */
export const SEARCH_QUERY_CODE_POINT_LIMIT = 256;
/** The most matches kept for one query. */
export const SEARCH_MATCH_LIMIT = 10_000;
/** The retained text a search reads: the export budget, 1 MiB. */
export const SEARCH_TEXT_BYTE_LIMIT = 1024 * 1024;
/** The pause after the last key before a query is searched, in milliseconds. */
export const SEARCH_TYPING_DELAY_MS = 150;
/** The shortest interval between re-searches while output arrives, in milliseconds. */
export const SEARCH_REFRESH_DELAY_MS = 500;
/** The accessible snapshot budget: 64 KiB. */
export const SNAPSHOT_BYTE_LIMIT = DEFAULT_PROJECTION_BYTE_LIMIT;
/** The export budget: 1 MiB. */
export const EXPORT_BYTE_LIMIT = 1024 * 1024;
/** The export line budget: the scrollback, 10,000 lines. */
export const EXPORT_LINE_LIMIT = 10_000;
/**
 * The most retained text read to report how much there is, the top of the permitted export range:
 * 16 MiB. `retainedBytes` never counts past it, so it is a lower bound once it reaches it.
 */
export const RETAINED_READ_CEILING = 16 * 1024 * 1024;
/** The most addresses the snapshot offers. */
export const SNAPSHOT_LINK_LIMIT = 50;
/** The file name an export is saved under. It carries nothing from the session. */
export const EXPORT_FILE_NAME = 'terminal-output.txt';

/** Reads the retained output of the live engine. */
export type InspectionSource = {
  /**
   * Which attachment this is. A new session, controller or engine is a new generation, and
   * nothing captured from an earlier one is refreshed from a later one.
   */
  readonly generation: number;
  readProjection(maximumBytes: number): TerminalProjection | undefined;
  /** Select a search match in the terminal without scrolling or moving focus. */
  selectMatch(match: { start: number; end: number; text: string }, maximumBytes: number): boolean;
  /** Drop the selection a search made. */
  clearMatchSelection(): void;
  /** Clear the local buffer in order behind received output. `false` when there is no engine. */
  clear(scope: ClearScope, done: () => void): boolean;
};

/**
 * What the host may observe about inspection. Every field is a number, a boolean or one of a few
 * fixed words, so no output, query, keystroke, argument, environment or credential can be in one.
 */
export type InspectionEvent =
  | { kind: 'search'; matches: number; capped: boolean; truncated: boolean }
  | { kind: 'navigate'; direction: 'next' | 'previous'; wrapped: boolean; matches: number }
  | { kind: 'clear'; scope: ClearScope }
  | {
      kind: 'snapshot';
      action: 'open' | 'refresh' | 'close';
      bytes: number;
      truncated: boolean;
      stale: boolean;
    }
  | {
      kind: 'export';
      action: 'download';
      exportedBytes: number;
      retainedBytes: number;
      truncated: boolean;
    }
  | { kind: 'link'; action: 'activate' | 'refuse' };

export type InspectionEventListener = (event: InspectionEvent) => void;
