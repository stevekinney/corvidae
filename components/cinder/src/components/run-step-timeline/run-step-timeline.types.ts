import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/**
 * Generic execution state of a single run step.
 *
 * These names are intentionally domain-agnostic. Consumers map their
 * own domain state (e.g. Weft, CI, queue) onto this union; the
 * component does not encode product-specific status vocabulary.
 *
 * - `pending`   — not yet started; waiting in the queue.
 * - `running`   — currently executing within its lane.
 * - `succeeded` — completed successfully.
 * - `failed`    — completed with a terminal error.
 * - `timed-out` — exceeded its allowed execution time.
 * - `cancelled` — was stopped before it could complete.
 * - `skipped`   — bypassed intentionally (e.g. conditional branch).
 * - `retrying`  — a prior attempt ended unsuccessfully; a new attempt is in progress.
 * - `waiting_approval` — paused on required approval; can continue afterward.
 * - `waiting`  — paused on something that is not a person's approval, such as an external signal;
 *                it starts again by itself when that arrives.
 * - `recorded` — an event that happened and has no outcome of its own, such as the run's start or
 *                its end; drawn as a plain neutral dot.
 */
export type RunStepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed-out'
  | 'cancelled'
  | 'skipped'
  | 'retrying'
  | 'waiting_approval'
  | 'waiting'
  | 'recorded';

type RunStepDetailBase = {
  /** Stable identity for this detail panel. */
  id: string;
  /** Trigger label rendered on the Collapsible header. */
  label: string;
  /** Controlled initial/current disclosure state. */
  open?: boolean | undefined;
  /** Fired when this detail panel is toggled. */
  onToggle?: ((open: boolean) => void) | undefined;
};

/**
 * A single expandable text detail section attached to a step.
 * Rendered inside a Collapsible panel.
 */
export type RunStepTextDetail = RunStepDetailBase & {
  /** Text details preserve the existing preformatted rendering behavior. */
  type: 'text';
  /** Pre-formatted content shown inside the panel. */
  content: string;
};

/**
 * A single expandable code detail section attached to a step.
 * Rendered through Cinder CodeBlock.
 */
export type RunStepCodeDetail = RunStepDetailBase & {
  /** Code details render with Cinder CodeBlock. */
  type: 'code';
  /** Code content shown inside the panel. */
  code: string;
  /** Optional CodeBlock language. */
  language?: string | undefined;
  /** Whether the CodeBlock language label is visible. */
  languageLabelVisible?: boolean | undefined;
};

/**
 * A single expandable detail section attached to a step.
 * Rendered inside a Collapsible panel.
 */
export type RunStepDetail = RunStepTextDetail | RunStepCodeDetail;

/**
 * A block shown open under a step, beside its description: output that is arriving, or the cause
 * of a failure. Unlike a detail it has no disclosure, so it is always read.
 * @schemaObject
 */
export type RunStepNote = {
  /** Bold first line of the block, such as "Merged since Oct 23, so far" or "Why it failed". */
  title?: string | undefined;
  /** The lines of the block, one per line. */
  lines: string[];
  /** `danger` tints the block for a failure. Default `neutral`. */
  tone?: 'neutral' | 'danger' | undefined;
  /**
   * A muted word before the first line, joined to it by a middle dot: `Your note` reads "Your note
   * · The customer already got a replacement." Use it when the block is somebody's words rather
   * than a titled block.
   */
  label?: string | undefined;
  /**
   * Whether the lines are still arriving. A text cursor follows the last line, so the block reads as
   * partial and growing.
   */
  streaming?: boolean | undefined;
};

/**
 * Navigable reference attached to a step.
 * Rendered with cinder's Link component.
 */
export type RunStepLink = {
  /** Destination URL for the step link. */
  href: string;
  /** Visible text for the step link. */
  label: string;
};

/**
 * One step in a RunStepTimeline.
 */
export type RunStep = {
  /** Stable identity; used as the keyed list identity. */
  id: string;
  /** Display label for this step. */
  label: string;
  /** Optional decorative icon rendered beside the label. */
  icon?: Snippet | undefined;
  /** Generic execution state. */
  status: RunStepStatus;
  /**
   * One muted line under the label saying what happened or what is waiting, such as "Found the
   * last release, 1.4.2, on Oct 23". Text between backticks renders as inline code, so a signal
   * name reads as an identifier.
   */
  description?: string | undefined;
  /**
   * Short time label at the end of the label line, formatted by the caller: "10:45:20 AM", "+1.2 s",
   * "now", "last update 40 s ago". Leave it out for a step that has no time yet.
   */
  time?: string | undefined;
  /** A block shown open under the description. */
  note?: RunStepNote | undefined;
  /**
   * ISO datetime string for when this step started.
   * Absent for pending steps.
   */
  startTime?: string | undefined;
  /**
   * ISO datetime string for when this step ended.
   * Absent for pending and running steps.
   */
  endTime?: string | undefined;
  /**
   * Human-readable duration string, e.g. "1m 23s".
   * Absent for pending steps.
   */
  duration?: string | undefined;
  /**
   * Number of attempts made so far, including any retries.
   * Displayed when greater than 1.
   */
  attemptCount?: number | undefined;
  /**
   * Number of actions associated with this step.
   * Displayed when greater than 0.
   */
  actionsCount?: number | undefined;
  /**
   * Optional determinate progress value between 0 and `progressMax`.
   * When supplied, a Progress bar is rendered for the step.
   */
  progress?: number | undefined;
  /**
   * Maximum value for the progress bar. Defaults to 100.
   */
  progressMax?: number | undefined;
  /**
   * Expandable detail panels (logs, payloads, errors) shown inline.
   */
  details?: RunStepDetail[] | undefined;
  /**
   * Optional link to logs, traces, or a step detail route.
   */
  link?: RunStepLink | undefined;
  /**
   * Marks a step that was speculatively executed and then unwound (rolled
   * back). Orthogonal to `status`: the step keeps its real terminal status
   * underneath, but renders struck-through and de-emphasized while staying
   * inspectable. A rewound step announces its unwound state to assistive
   * technology in addition to its status.
   */
  rewound?: boolean | undefined;
  /**
   * Id of the forward step that this step compensates (reverses), as in a
   * saga rollback. When set, the step renders inset beneath its forward step
   * with a dashed reversal connector. The referenced id should be a sibling
   * step's `id`; an unmatched id renders the step in place without inset.
   */
  compensates?: string | undefined;
  /**
   * Nested child-workflow steps rendered as indented lanes.
   */
  children?: RunStep[] | undefined;
};

/**
 * Outcome of a single sub-lane within a {@link RunStepBranchGroup}.
 *
 * - `won`     — this lane produced the committed result; emphasized.
 * - `lost`    — this lane was superseded by the winner; muted.
 * - `settled` — this lane completed without a competitive winner/loser
 *               distinction (e.g. all lanes were kept). Neutral emphasis.
 *
 * Omit the outcome entirely while a race is still in flight.
 */
export type RunStepBranchLaneOutcome = 'won' | 'lost' | 'settled';

/**
 * One parallel sub-lane inside a {@link RunStepBranchGroup}. Each lane is an
 * ordered sequence of steps that executed concurrently with its siblings.
 */
export type RunStepBranchLane = {
  /** Stable identity; used as the keyed list identity within the group. */
  id: string;
  /** Optional display label for the lane (e.g. the candidate or strategy name). */
  label?: string | undefined;
  /**
   * Competitive outcome for the lane. Drives winner emphasis / loser muting.
   * Omit while the branch is still racing.
   */
  outcome?: RunStepBranchLaneOutcome | undefined;
  /** Ordered steps that ran within this lane. */
  steps: RunStep[];
};

/**
 * A branch/coordination group: a single timeline entry that fans out into N
 * parallel sub-lanes (e.g. a speculative race or a scatter/gather). Rendered
 * with the lanes side by side conceptually — the winning lane emphasized and
 * the losers muted — and collapsible. Distinguished from a plain {@link RunStep}
 * by its `kind` discriminator, mirroring the additive-entry pattern used by
 * other cinder timelines.
 *
 * @schemaObject
 */
export type RunStepBranchGroup = {
  /** Discriminator identifying a branch-group entry. */
  kind: 'branch';
  /** Stable identity; used as the keyed list identity. */
  id: string;
  /** Display label for the branch group (e.g. "Race deploy candidates"). */
  label: string;
  /** The parallel sub-lanes. Order is presentational only. */
  lanes: RunStepBranchLane[];
  /**
   * Collapse the group by default once the lane count reaches this threshold.
   * Defaults to 3. Set to a large number to effectively disable auto-collapse.
   */
  collapseThreshold?: number | undefined;
  /**
   * Force the initial collapsed (`true`) or expanded (`false`) state,
   * overriding `collapseThreshold`. The group remains user-togglable.
   */
  collapsed?: boolean | undefined;
};

/**
 * A single top-level entry in a RunStepTimeline: either a normal step or a
 * branch/coordination group. Existing `RunStep[]` arrays remain valid because
 * the union is additive and branch groups are opt-in via the `kind`
 * discriminator.
 */
export type RunStepTimelineEntry = RunStep | RunStepBranchGroup;

/**
 * Schema generator surface for one top-level step.
 * Public `RunStep` stays recursive; this finite shape keeps JSON Schema generation bounded.
 * @schemaObject
 */
export type RunStepTimelineSchemaStep = {
  /** Stable identity; used as the keyed list identity. */
  id: string;
  /** Display label for this step. */
  label: string;
  /** Optional decorative icon rendered beside the label. */
  icon?: Snippet | undefined;
  /** Generic execution state. */
  status: RunStepStatus;
  /** One muted line under the label; text between backticks renders as inline code. */
  description?: string | undefined;
  /** Short time label at the end of the label line, formatted by the caller. */
  time?: string | undefined;
  /** A block shown open under the description. */
  note?: RunStepNote | undefined;
  /**
   * ISO datetime string for when this step started.
   * Absent for pending steps.
   */
  startTime?: string | undefined;
  /**
   * ISO datetime string for when this step ended.
   * Absent for pending and running steps.
   */
  endTime?: string | undefined;
  /**
   * Human-readable duration string, e.g. "1m 23s".
   * Absent for pending steps.
   */
  duration?: string | undefined;
  /**
   * Number of attempts made so far, including any retries.
   * Displayed when greater than 1.
   */
  attemptCount?: number | undefined;
  /**
   * Number of actions associated with this step.
   * Displayed when greater than 0.
   */
  actionsCount?: number | undefined;
  /**
   * Optional determinate progress value between 0 and `progressMax`.
   * When supplied, a Progress bar is rendered for the step.
   */
  progress?: number | undefined;
  /**
   * Maximum value for the progress bar. Defaults to 100.
   */
  progressMax?: number | undefined;
  /**
   * Expandable detail panels (logs, payloads, errors) shown inline.
   */
  details?: RunStepDetail[] | undefined;
  /**
   * Optional link to logs, traces, or a step detail route.
   */
  link?: RunStepLink | undefined;
  /** Marks a step that was speculatively executed and then unwound (rolled back). */
  rewound?: boolean | undefined;
  /** Id of the forward step that this step compensates (reverses). */
  compensates?: string | undefined;
  /**
   * Schema-bounded nested child-workflow steps.
   */
  children?: RunStepTimelineSchemaChildStep[] | undefined;
};

/**
 * Schema generator surface for one nested child step rendered at depth 1.
 * @schemaObject
 */
export type RunStepTimelineSchemaChildStep = {
  /** Stable identity; used as the keyed list identity. */
  id: string;
  /** Display label for this step. */
  label: string;
  /** Optional decorative icon rendered beside the label. */
  icon?: Snippet | undefined;
  /** Generic execution state. */
  status: RunStepStatus;
  /** One muted line under the label; text between backticks renders as inline code. */
  description?: string | undefined;
  /** Short time label at the end of the label line, formatted by the caller. */
  time?: string | undefined;
  /** A block shown open under the description. */
  note?: RunStepNote | undefined;
  /** ISO datetime string for when this step started. */
  startTime?: string | undefined;
  /** ISO datetime string for when this step ended. */
  endTime?: string | undefined;
  /** Human-readable duration string, e.g. "1m 23s". */
  duration?: string | undefined;
  /** Number of attempts made so far, including any retries. */
  attemptCount?: number | undefined;
  /** Number of actions associated with this step. */
  actionsCount?: number | undefined;
  /** Optional determinate progress value between 0 and `progressMax`. */
  progress?: number | undefined;
  /** Maximum value for the progress bar. Defaults to 100. */
  progressMax?: number | undefined;
  /** Expandable detail panels (logs, payloads, errors) shown inline. */
  details?: RunStepDetail[] | undefined;
  /** Optional link to logs, traces, or a step detail route. */
  link?: RunStepLink | undefined;
  /** Marks a step that was speculatively executed and then unwound (rolled back). */
  rewound?: boolean | undefined;
  /** Id of the forward step that this step compensates (reverses). */
  compensates?: string | undefined;
  /**
   * Nested child-workflow steps rendered at depth 2.
   */
  children?: RunStepTimelineSchemaGrandchildStep[] | undefined;
};

/**
 * Schema generator surface for one nested child step rendered at depth 2.
 * @schemaObject
 */
export type RunStepTimelineSchemaGrandchildStep = {
  /** Stable identity; used as the keyed list identity. */
  id: string;
  /** Display label for this step. */
  label: string;
  /** Optional decorative icon rendered beside the label. */
  icon?: Snippet | undefined;
  /** Generic execution state. */
  status: RunStepStatus;
  /** One muted line under the label; text between backticks renders as inline code. */
  description?: string | undefined;
  /** Short time label at the end of the label line, formatted by the caller. */
  time?: string | undefined;
  /** A block shown open under the description. */
  note?: RunStepNote | undefined;
  /** ISO datetime string for when this step started. */
  startTime?: string | undefined;
  /** ISO datetime string for when this step ended. */
  endTime?: string | undefined;
  /** Human-readable duration string, e.g. "1m 23s". */
  duration?: string | undefined;
  /** Number of attempts made so far, including any retries. */
  attemptCount?: number | undefined;
  /** Number of actions associated with this step. */
  actionsCount?: number | undefined;
  /** Optional determinate progress value between 0 and `progressMax`. */
  progress?: number | undefined;
  /** Maximum value for the progress bar. Defaults to 100. */
  progressMax?: number | undefined;
  /** Expandable detail panels (logs, payloads, errors) shown inline. */
  details?: RunStepDetail[] | undefined;
  /** Optional link to logs, traces, or a step detail route. */
  link?: RunStepLink | undefined;
  /** Marks a step that was speculatively executed and then unwound (rolled back). */
  rewound?: boolean | undefined;
  /** Id of the forward step that this step compensates (reverses). */
  compensates?: string | undefined;
  /**
   * Nested child-workflow steps rendered at depth 3.
   */
  children?: RunStepTimelineSchemaGreatGrandchildStep[] | undefined;
};

/**
 * Schema generator surface for one nested child step rendered at depth 3.
 * @schemaObject
 */
export type RunStepTimelineSchemaGreatGrandchildStep = {
  /** Stable identity; used as the keyed list identity. */
  id: string;
  /** Display label for this step. */
  label: string;
  /** Optional decorative icon rendered beside the label. */
  icon?: Snippet | undefined;
  /** Generic execution state. */
  status: RunStepStatus;
  /** One muted line under the label; text between backticks renders as inline code. */
  description?: string | undefined;
  /** Short time label at the end of the label line, formatted by the caller. */
  time?: string | undefined;
  /** A block shown open under the description. */
  note?: RunStepNote | undefined;
  /** ISO datetime string for when this step started. */
  startTime?: string | undefined;
  /** ISO datetime string for when this step ended. */
  endTime?: string | undefined;
  /** Human-readable duration string, e.g. "1m 23s". */
  duration?: string | undefined;
  /** Number of attempts made so far, including any retries. */
  attemptCount?: number | undefined;
  /** Number of actions associated with this step. */
  actionsCount?: number | undefined;
  /** Optional determinate progress value between 0 and `progressMax`. */
  progress?: number | undefined;
  /** Maximum value for the progress bar. Defaults to 100. */
  progressMax?: number | undefined;
  /** Expandable detail panels (logs, payloads, errors) shown inline. */
  details?: RunStepDetail[] | undefined;
  /** Optional link to logs, traces, or a step detail route. */
  link?: RunStepLink | undefined;
  /** Marks a step that was speculatively executed and then unwound (rolled back). */
  rewound?: boolean | undefined;
  /** Id of the forward step that this step compensates (reverses). */
  compensates?: string | undefined;
};

/**
 * Schema-facing step used for branch-lane sequences. Lane steps are
 * `RunStep[]` at runtime and can nest, so this type carries an optional
 * `children` array of the same shape (recursive at the type level, for
 * consumer-typing convenience) that validates lane-step children as steps.
 * The generated JSON Schema depth-caps this nesting to the same rendered depth
 * as the main rail; the recursive TYPE is the ergonomic mirror of that
 * depth-capped schema, not an assertion that arbitrary depth is rendered.
 * @schemaObject
 */
export type RunStepTimelineSchemaLaneStep = {
  /** Stable identity; used as the keyed list identity. */
  id: string;
  /** Display label for this step. */
  label: string;
  /** Optional decorative icon rendered beside the label. */
  icon?: Snippet | undefined;
  /** Generic execution state. */
  status: RunStepStatus;
  /** One muted line under the label; text between backticks renders as inline code. */
  description?: string | undefined;
  /** Short time label at the end of the label line, formatted by the caller. */
  time?: string | undefined;
  /** A block shown open under the description. */
  note?: RunStepNote | undefined;
  /** ISO datetime string for when this step started. */
  startTime?: string | undefined;
  /** ISO datetime string for when this step ended. */
  endTime?: string | undefined;
  /** Human-readable duration string, e.g. "1m 23s". */
  duration?: string | undefined;
  /** Number of attempts made so far, including any retries. */
  attemptCount?: number | undefined;
  /** Number of actions associated with this step. */
  actionsCount?: number | undefined;
  /** Optional determinate progress value between 0 and `progressMax`. */
  progress?: number | undefined;
  /** Maximum value for the progress bar. Defaults to 100. */
  progressMax?: number | undefined;
  /** Expandable detail panels (logs, payloads, errors) shown inline. */
  details?: RunStepDetail[] | undefined;
  /** Optional link to logs, traces, or a step detail route. */
  link?: RunStepLink | undefined;
  /** Marks a step that was speculatively executed and then unwound (rolled back). */
  rewound?: boolean | undefined;
  /** Id of the forward step that this step compensates (reverses). */
  compensates?: string | undefined;
  /** Nested steps within a branch lane. */
  children?: RunStepTimelineSchemaLaneStep[] | undefined;
};

/**
 * Schema-bounded sub-lane inside a {@link RunStepTimelineSchemaBranchGroup}.
 * Lane steps are bounded to a leaf surface so JSON Schema generation stays
 * finite.
 * @schemaObject
 */
export type RunStepTimelineSchemaBranchLane = {
  /** Stable identity; used as the keyed list identity within the group. */
  id: string;
  /** Optional display label for the lane. */
  label?: string | undefined;
  /** Competitive outcome for the lane. Omit while the branch is still racing. */
  outcome?: RunStepBranchLaneOutcome | undefined;
  /** Ordered steps that ran within this lane. */
  steps: RunStepTimelineSchemaLaneStep[];
};

/**
 * Schema generator surface for one top-level branch/coordination group.
 * @schemaObject
 */
export type RunStepTimelineSchemaBranchGroup = {
  /** Discriminator identifying a branch-group entry. */
  kind: 'branch';
  /** Stable identity; used as the keyed list identity. */
  id: string;
  /** Display label for the branch group. */
  label: string;
  /** The parallel sub-lanes. */
  lanes: RunStepTimelineSchemaBranchLane[];
  /** Collapse the group by default once the lane count reaches this threshold. Defaults to 3. */
  collapseThreshold?: number | undefined;
  /** Force the initial collapsed (`true`) or expanded (`false`) state. */
  collapsed?: boolean | undefined;
};

/**
 * A single schema-bounded top-level entry: either a step or a branch group.
 */
export type RunStepTimelineSchemaEntry =
  RunStepTimelineSchemaStep | RunStepTimelineSchemaBranchGroup;

/** How a RunStepTimeline draws its steps: `detailed` for operators, `narrative` for a run's story. */
export type RunStepTimelineVariant = 'detailed' | 'narrative';

/**
 * Folds the middle of a long narrative timeline behind one row ("3 more calls", with a "Show all 9"
 * action), so a run of many entries keeps the shape of the page. The first and last few entries
 * stay; a step that failed, timed out, is waiting or is under way is never folded, and splits the
 * folded middle into separate rows that each count what they hide. A fold hides at least two
 * entries, because hiding one saves nothing. "Show all" opens every fold in place. Only the
 * `narrative` variant folds.
 */
export type RunStepTimelineFold = {
  /** How many entries stay visible at the start. @default 3 */
  first?: number | undefined;
  /** How many entries stay visible at the end. @default 3 */
  last?: number | undefined;
  /** The fold row's label for how many entries it hides. Defaults to "3 more steps". */
  label?: ((hidden: number) => string) | undefined;
  /** The fold row's action, given how many entries the timeline holds. Defaults to "Show all 9". */
  actionLabel?: ((total: number) => string) | undefined;
};

/**
 * Props for the RunStepTimeline component.
 *
 * Renders an ordered list of execution steps with per-step status,
 * durations, retry counts, optional progress indicators, and expandable
 * detail panels for logs, payloads, and errors.
 */
export type RunStepTimelineProps = Omit<HTMLAttributes<HTMLOListElement>, 'class' | 'children'> & {
  /**
   * Ordered list of timeline entries to render. Each entry is either a
   * {@link RunStep} or a {@link RunStepBranchGroup}. Plain `RunStep[]` arrays
   * remain valid — branch groups are opt-in via the `kind` discriminator.
   * @schemaObject
   */
  steps: RunStepTimelineEntry[];
  /**
   * Accessible label for the timeline list.
   * Used as `aria-label` when `aria-labelledby` is absent.
   */
  label?: string | undefined;
  /**
   * Rendered step path key to visually mark as selected.
   * Accepts `null` so consumers can clear linked selection without omitting
   * the prop. Use the value passed to `onStepSelect`, or a row's
   * `data-cinder-path` attribute, for nested or branch-lane steps.
   */
  selectedStepId?: string | null | undefined;
  /**
   * Fired when the user activates a rendered step row.
   * Receives that row's rendered path key.
   */
  onStepSelect?: ((pathKey: string) => void) | undefined;
  /**
   * How a step reads. `detailed` (the default) marks each step with a status dot and a status chip
   * and lists its start, end, duration and attempts. `narrative` tells the run as a story for
   * someone who wants to know what happened: a drawn marker (a check, a cross, a ring, a dashed
   * ring for what has not run), the label and its time, one line of description, and no chips or
   * metadata lists. The status word is still read aloud.
   */
  variant?: RunStepTimelineVariant | undefined;
  /** Folds the middle of a long `narrative` timeline behind one "N more" row. Ignored by `detailed`. */
  fold?: RunStepTimelineFold | undefined;
  /**
   * Optional per-step body content rendered after the step metadata.
   */
  children?: Snippet<[RunStep]> | undefined;
  /** Additional CSS classes applied to the root element. */
  class?: string | undefined;
};

/** Schema generator surface for RunStepTimeline — excludes snippet props. */
export interface RunStepTimelineSchemaProps {
  /**
   * Ordered list of timeline entries to render — either steps or branch groups.
   */
  steps: RunStepTimelineSchemaEntry[];
  /** Accessible label for the timeline list. */
  label?: string | undefined;
  /**
   * Rendered step path key to visually mark as selected.
   * Accepts `null` so consumers can clear linked selection without omitting
   * the prop. Use the value passed to `onStepSelect`, or a row's
   * `data-cinder-path` attribute, for nested or branch-lane steps.
   */
  selectedStepId?: string | null | undefined;
  /** How a step reads: `detailed` (default) or `narrative`. */
  variant?: RunStepTimelineVariant | undefined;
  /** Additional CSS classes applied to the root element. */
  class?: string | undefined;
}
