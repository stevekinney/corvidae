import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/**
 * Where one tool call stands, which picks its dot and its words:
 *
 * - `done`: finished; a neutral grey dot.
 * - `approved`: finished after a person approved it; a green dot, because the approval is what the
 *   row is about ("Approved by you 10:33 AM · $18.50 refunded").
 * - `running`: under way; a spinner in place of the dot and "Running…" in place of a result.
 * - `waiting`: parked on a person's decision; an amber shield and "Waiting on you". It never folds.
 * - `denied`: a person refused it; a neutral prohibition glyph and neutral words, never red and
 *   never called failed. It never folds.
 * - `failed`: it ended in an error; a red cross and the result in red. It never folds.
 */
export type ToolCallRailStatus = 'done' | 'approved' | 'running' | 'waiting' | 'denied' | 'failed';

/** One tool call of a turn. */
export type ToolCallRailCall = {
  /** Stable identity of the call; used as the keyed row identity and passed to `onSelect`. */
  id: string;
  /** The tool's name as a person reads it ("Lookup order"). It never wraps. */
  name: string;
  /** The tool's identifier ("lookup-order"), shown in a tooltip on the name. */
  identifier?: string | undefined;
  /** The key input of the call, muted and cut with an ellipsis ("4471", "carrier Parcelly, damaged"). */
  input?: string | undefined;
  /**
   * What came back, in one line. A `done`, `approved` or `failed` call shows it after an arrow
   * ("→ $42.00, delivered Mon"); a `denied` call shows it as its own words ("Denied by you 10:40 AM ·
   * nothing refunded"); a `running` or `waiting` call has none and reads "Running…" or "Waiting on
   * you", unless this is set.
   */
  result?: string | undefined;
  /** How long the call took, formatted by the caller ("0.2s"), at the end of the row. Elapsed while `running`. */
  duration?: string | undefined;
  /** Where the call stands. */
  status: ToolCallRailStatus;
  /**
   * For a `failed` call: the consequence in one danger-text line under the row ("Mail server didn't
   * reply within 10s. The refund notice for 4471 wasn't sent."). The row shows no filled error
   * block.
   */
  failure?: string | undefined;
  /**
   * Whether the `children` snippet draws content under this call's row, such as the approval that
   * a `waiting` call is waiting on, or the approved one under a call that has been decided.
   */
  nested?: boolean | undefined;
};

/** The words the rail speaks, for a caller that is not writing English. */
export type ToolCallRailLabels = {
  /** The summary line. Defaults to "Used 30 tools", or "Used 12 tools so far…" while the turn runs. */
  used?: ((count: number, running: boolean) => string) | undefined;
  /** The summary line's failed count. Defaults to "1 failed". */
  failed?: ((count: number) => string) | undefined;
  /** The summary line's waiting count. Defaults to "1 waiting on you". */
  waiting?: ((count: number) => string) | undefined;
  /** The button over a folded group. Defaults to "Show 24 more". */
  showMore?: ((count: number) => string) | undefined;
  /** The summary beside the group button. Defaults to "24 done: Lookup order ×10, 6 others". */
  folded?: ((count: number, names: string) => string) | undefined;
  /** The summary beside the group button in a narrow container. Defaults to "24 done". */
  foldedShort?: ((count: number) => string) | undefined;
  /** The button that folds every open group again. Defaults to "Show fewer". */
  showFewer?: string | undefined;
  /** The result of a `running` call. Defaults to "Running…". */
  running?: string | undefined;
  /** The result of a `waiting` call. Defaults to "Waiting on you". */
  waitingResult?: string | undefined;
  /** The result of a `denied` call that has none. Defaults to "Denied". */
  denied?: string | undefined;
  /** The link on a failed call that opens its details. Defaults to "Details". */
  details?: string | undefined;
  /** The link on a failed call that asks the agent to retry. Defaults to "Ask the agent to retry". */
  retry?: string | undefined;
  /** The link on a failed call that copies its input. Defaults to "Copy input". */
  copyInput?: string | undefined;
};

/** Props for the ToolCallRail component. */
export type ToolCallRailProps = Omit<
  HTMLAttributes<HTMLElement>,
  'class' | 'children' | 'role' | 'onselect'
> & {
  /**
   * The calls of one turn, in the order they were made. One or two calls draw as plain rows with no
   * summary and no rail; from three the summary line and the rail appear; from eight the middle
   * folds, when at least two calls would hide.
   */
  calls: readonly ToolCallRailCall[];
  /**
   * Whether the turn is still running. The summary reads "Used 12 tools so far…" with a spinner and
   * no failed or waiting counts, and the rail keeps the first calls and the ones under way rather
   * than the last three. @default false
   */
  running?: boolean | undefined;
  /** How long the whole turn took, formatted by the caller ("18s"), at the end of the summary line. Left out in a narrow container. */
  duration?: string | undefined;
  /**
   * Whether the rail is open. Closed, the summary line alone shows, with the calls that failed,
   * were denied or need a person still under it. Bindable. @default true
   */
  open?: boolean | undefined;
  /** The call whose panel is open: its row is tinted and keeps the quiet focus ring. */
  selectedId?: string | undefined;
  /** Fired with a call's id when its row is chosen. Rows are buttons only when this is set. */
  onSelect?: ((id: string) => void) | undefined;
  /** Fired when the person asks the agent to retry a failed call. The link shows only when this is set. */
  onRetry?: ((id: string) => void) | undefined;
  /** Fired when the person copies a failed call's input. The link shows only when this is set. */
  onCopyInput?: ((id: string) => void) | undefined;
  /**
   * The run's end state, on its own line after the last row, in neutral text with a check glyph
   * ("Run finished · no reply"). Set it when the turn ends on a tool call, so it does not look hung.
   */
  endLabel?: string | undefined;
  /** A muted line under the rail ("Failures and calls that need you stay visible wherever they fall."). */
  footnote?: string | undefined;
  /** An accessible name for the rail. @default "Tool calls" */
  label?: string | undefined;
  /** The rail's words. */
  labels?: ToolCallRailLabels | undefined;
  /** Additional class names merged with `.cinder-tool-call-rail`. */
  class?: string | undefined;
  /** Content under a call's row: the approval a `waiting` call is waiting on. Drawn for the calls that set `nested`. */
  children?: Snippet<[ToolCallRailCall]> | undefined;
};

/** Schema generator surface for ToolCallRail: excludes snippet and function props. */
export interface ToolCallRailSchemaProps {
  /**
   * The calls of one turn, in the order they were made.
   * @schemaObject
   */
  calls: readonly ToolCallRailCall[];
  /** Whether the turn is still running. @default false */
  running?: boolean | undefined;
  /** How long the whole turn took, formatted by the caller. */
  duration?: string | undefined;
  /** Whether the rail is open. @default true */
  open?: boolean | undefined;
  /** The call whose panel is open. */
  selectedId?: string | undefined;
  /** The run's end state, on its own line after the last row. */
  endLabel?: string | undefined;
  /** A muted line under the rail. */
  footnote?: string | undefined;
  /** An accessible name for the rail. @default "Tool calls" */
  label?: string | undefined;
  /** Additional class names merged with `.cinder-tool-call-rail`. */
  class?: string | undefined;
}
