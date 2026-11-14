import { planFold } from '../../utilities/fold-middle.ts';
import type { StatusDotStatus } from '../status-dot/status-dot.types.ts';
import type {
  RunStep,
  RunStepBranchGroup,
  RunStepBranchLane,
  RunStepBranchLaneOutcome,
  RunStepStatus,
  RunStepTimelineEntry,
  RunStepTimelineFold,
} from './run-step-timeline.types.ts';

function assertNever(value: never): never {
  throw new Error(`Unexpected exhaustive value: ${String(value)}`);
}

/** An ancestor's line where it runs past a nested row. */
export type RailThrough = {
  /** The ancestor's depth, which places the line. */
  depth: number;
  /**
   * Whether the line stops at this row's marker: the ancestor has no later sibling and this is
   * the last of its nested rows. Otherwise it runs on into the next row.
   */
  ends: boolean;
};

/** How one row of the rail joins the rows after it. */
export type RailConnection = {
  /**
   * Whether a line leaves this row's marker: toward its next sibling (the next row at the same
   * depth before any shallower row), or along its nested rows when it has them.
   */
  after: 'hidden' | 'visible';
  /** The shallower depths whose line runs past this row. */
  through: RailThrough[];
};

/**
 * The rail's connections, from each row's depth in display order. A parent's line runs past its
 * nested rows to its next sibling, and with no later sibling it runs along its nested rows and
 * stops at the last one's marker. A last child with no nested rows has no line below it. Every
 * row the line runs past carries the parent's depth in `through`.
 */
export function railConnections(depths: readonly number[]): RailConnection[] {
  const sibling: boolean[] = Array.from({ length: depths.length }, () => false);
  // Walking up from the end: whether a row at each depth follows with no shallower row between.
  const followed: boolean[] = [];
  for (let index = depths.length - 1; index >= 0; index -= 1) {
    const depth = depths[index] ?? 0;
    sibling[index] = followed[depth] === true;
    followed[depth] = true;
    followed.length = depth + 1;
  }
  // Walking down: which ancestors' lines are still open when each row starts.
  const open: boolean[] = [];
  return depths.map((depth, index) => {
    const nextDepth = depths[index + 1] ?? -1;
    const through: RailThrough[] = [];
    for (let level = 0; level < depth; level += 1) {
      if (open[level] === true) through.push({ depth: level, ends: nextDepth < level });
    }
    const visible = sibling[index] === true || nextDepth > depth;
    open[depth] = visible;
    open.length = depth + 1;
    return { after: visible ? 'visible' : 'hidden', through };
  });
}

/**
 * Relocate resolved compensation steps immediately after the subtree of the
 * sibling they reverse. Unresolved, self-referential, and cyclic links retain
 * consumer order. Multiple compensations retain their relative input order.
 */
export function relocateCompensationSteps(steps: RunStep[]): RunStep[] {
  return relocateSiblingItems(steps, (step) => step);
}

function relocateSiblingItems<T>(items: T[], getStep: (item: T) => RunStep | undefined): T[] {
  if (!items.some((item) => getStep(item)?.compensates !== undefined)) return items;

  const stepById = new Map<string, RunStep>();
  for (const item of items) {
    const step = getStep(item);
    if (step !== undefined) {
      stepById.set(step.id, step);
    }
  }
  const canRelocate = (step: RunStep): boolean => {
    const visited = new Set<string>([step.id]);
    let targetId = step.compensates;
    while (targetId !== undefined) {
      const target = stepById.get(targetId);
      if (target === undefined || visited.has(targetId)) return false;
      visited.add(targetId);
      targetId = target.compensates;
    }
    return true;
  };
  const relocatable = new Set<RunStep>();
  const compensationsByTarget = new Map<string, T[]>();
  for (const item of items) {
    const step = getStep(item);
    if (step === undefined || step.compensates === undefined || !canRelocate(step)) continue;
    relocatable.add(step);
    const compensations = compensationsByTarget.get(step.compensates) ?? [];
    compensations.push(item);
    compensationsByTarget.set(step.compensates, compensations);
  }
  const result: T[] = [];
  const appendWithCompensations = (item: T): void => {
    result.push(item);
    const step = getStep(item);
    if (step === undefined) return;
    for (const compensation of compensationsByTarget.get(step.id) ?? []) {
      appendWithCompensations(compensation);
    }
  };
  for (const item of items) {
    const step = getStep(item);
    if (step === undefined || !relocatable.has(step)) appendWithCompensations(item);
  }
  return result;
}

/** Relocate top-level compensations while preserving branch rows as rail entries. */
export function relocateCompensationEntries(
  entries: RunStepTimelineEntry[],
): RunStepTimelineEntry[] {
  return relocateSiblingItems(entries, (entry) => (isBranchGroup(entry) ? undefined : entry));
}

function isBranchGroup(entry: RunStepTimelineEntry): entry is RunStepBranchGroup {
  return 'kind' in entry && entry.kind === 'branch';
}

/** Badge variants used for the per-step status chip. */
export type RunStepBadgeVariant = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

/** Map a generic {@link RunStepStatus} onto a StatusDot status token. */
export function statusDotStatus(status: RunStepStatus): StatusDotStatus {
  switch (status) {
    case 'succeeded':
      return 'success';
    case 'failed':
    case 'timed-out':
      return 'danger';
    case 'running':
      return 'online';
    case 'retrying':
      return 'warning';
    case 'waiting_approval':
      return 'accent';
    case 'cancelled':
      return 'offline';
    case 'skipped':
    case 'recorded':
      return 'neutral';
    case 'pending':
    case 'waiting':
      return 'pending';
    default:
      return assertNever(status);
  }
}

/** Human-readable label for the StatusDot accessible name. */
export function statusLabel(status: RunStepStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'running':
      return 'Running';
    case 'succeeded':
      return 'Succeeded';
    case 'failed':
      return 'Failed';
    case 'timed-out':
      return 'Timed out';
    case 'cancelled':
      return 'Canceled';
    case 'skipped':
      return 'Skipped';
    case 'retrying':
      return 'Retrying';
    case 'waiting_approval':
      return 'Waiting approval';
    case 'waiting':
      return 'Waiting';
    case 'recorded':
      return 'Recorded';
    default:
      return assertNever(status);
  }
}

/** Map a {@link RunStepStatus} to a Badge variant for the status chip. */
export function badgeVariant(status: RunStepStatus): RunStepBadgeVariant {
  switch (status) {
    case 'succeeded':
      return 'success';
    case 'failed':
    case 'timed-out':
      return 'danger';
    case 'running':
      return 'info';
    case 'retrying':
      return 'warning';
    case 'waiting_approval':
      return 'accent';
    case 'cancelled':
      return 'neutral';
    case 'skipped':
    case 'recorded':
      return 'neutral';
    case 'pending':
    case 'waiting':
      return 'neutral';
    default:
      return assertNever(status);
  }
}

/** Whether this status is a terminal state (no further changes expected). */
export function isTerminal(status: RunStepStatus): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'timed-out' ||
    status === 'cancelled' ||
    status === 'skipped' ||
    status === 'recorded'
  );
}

/** Whether this status represents an in-flight ("current") step. */
export function isCurrent(status: RunStepStatus): boolean {
  return (
    status === 'running' ||
    status === 'retrying' ||
    status === 'waiting_approval' ||
    status === 'waiting'
  );
}

/** Whether this step should render a progress bar. */
export function hasProgress(step: RunStep): boolean {
  return step.progress !== undefined && isCurrent(step.status);
}

/** Metadata items for a step, as term/definition pairs. */
export function metadataItems(step: RunStep): { term: string; definition: string }[] {
  const items: { term: string; definition: string }[] = [];
  if (step.startTime !== undefined) {
    items.push({ term: 'Started', definition: step.startTime });
  }
  if (step.endTime !== undefined) {
    items.push({ term: 'Ended', definition: step.endTime });
  }
  if (step.duration !== undefined) {
    items.push({ term: 'Duration', definition: step.duration });
  }
  if (step.attemptCount !== undefined && step.attemptCount > 1) {
    items.push({ term: 'Attempts', definition: String(step.attemptCount) });
  }
  return items;
}

/** Pluralized "N action(s)" label. */
export function actionsCountLabel(actionsCount: number): string {
  return actionsCount === 1 ? '1 action' : `${actionsCount} actions`;
}

/** Pluralized "N nested step(s) hidden" label for the depth-cap row. */
export function hiddenNestedStepLabel(hiddenStepCount: number): string {
  return hiddenStepCount === 1 ? '1 nested step hidden' : `${hiddenStepCount} nested steps hidden`;
}

/** Human-readable label for a branch-lane outcome, used in badges and announcements. */
export function laneOutcomeLabel(outcome: RunStepBranchLaneOutcome): string {
  switch (outcome) {
    case 'won':
      return 'Won';
    case 'lost':
      return 'Lost';
    case 'settled':
      return 'Settled';
    default:
      return assertNever(outcome);
  }
}

/** Badge variant for a branch-lane outcome. */
export function laneOutcomeBadgeVariant(outcome: RunStepBranchLaneOutcome): RunStepBadgeVariant {
  switch (outcome) {
    case 'won':
      return 'success';
    case 'lost':
      return 'neutral';
    case 'settled':
      return 'info';
    default:
      return assertNever(outcome);
  }
}

/**
 * One-line accessible summary of a branch group's lane outcomes, e.g.
 * "1 won, 2 lost" or "3 lanes racing" while outcomes are still pending.
 */
export function branchOutcomeSummary(lanes: RunStepBranchLane[]): string {
  const counts = { won: 0, lost: 0, settled: 0, pending: 0 };
  for (const lane of lanes) {
    if (lane.outcome === undefined) counts.pending += 1;
    else counts[lane.outcome] += 1;
  }
  const parts: string[] = [];
  if (counts.won > 0) parts.push(`${counts.won} won`);
  if (counts.lost > 0) parts.push(`${counts.lost} lost`);
  if (counts.settled > 0) parts.push(`${counts.settled} settled`);
  if (counts.pending > 0) {
    parts.push(counts.pending === 1 ? '1 lane racing' : `${counts.pending} lanes racing`);
  }
  return parts.length > 0 ? parts.join(', ') : 'No lanes';
}

/**
 * Whether any step in any lane of a branch group is currently in-flight.
 * Iterative (explicit stack) so a deeply-nested lane can't overflow the call
 * stack — this runs before the render path's depth cap.
 */
export function branchGroupHasCurrentStep(group: RunStepBranchGroup): boolean {
  const stack: RunStep[] = group.lanes.flatMap((lane) => lane.steps);
  while (stack.length > 0) {
    const step = stack.pop();
    if (step === undefined) continue;
    if (isCurrent(step.status)) return true;
    if (step.children) {
      for (const child of step.children) stack.push(child);
    }
  }
  return false;
}

/**
 * Resolve whether a branch group starts collapsed. An explicit `collapsed`
 * wins; otherwise the group collapses once its lane count reaches the
 * threshold (default 3).
 */
export function branchStartsCollapsed(
  laneCount: number,
  collapseThreshold: number | undefined,
  collapsed: boolean | undefined,
): boolean {
  if (collapsed !== undefined) return collapsed;
  // Normalize the public `collapseThreshold` to a finite positive integer so a
  // stray 0, negative, NaN, or fractional value can't produce surprising
  // always-/never-collapsed behavior; fall back to the default of 3.
  const threshold =
    collapseThreshold !== undefined && Number.isInteger(collapseThreshold) && collapseThreshold > 0
      ? collapseThreshold
      : 3;
  return laneCount >= threshold;
}

/** Whether the string contains an ASCII control character (0x00-0x1F or 0x7F). */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Normalize a step link href to a safe value, or `undefined` when the href is
 * empty, control-character-laden, backslash-bearing, protocol-relative, or a
 * non-http(s) scheme.
 */
export function safeStepLinkHref(href: string): string | undefined {
  const trimmedHref = href.trim();
  if (trimmedHref === '') return undefined;
  // Reject control characters (0x00-0x1F, 0x7F) without a control-char regex.
  if (hasControlCharacter(trimmedHref)) return undefined;
  if (trimmedHref.includes('\\')) return undefined;
  const leadingSeparators = trimmedHref.match(/^[\\/]+/)?.[0] ?? '';
  if (leadingSeparators.length > 1) return undefined;

  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(trimmedHref)) {
    try {
      const parsedUrl = new URL(trimmedHref);
      return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:'
        ? trimmedHref
        : undefined;
    } catch {
      return undefined;
    }
  }

  return trimmedHref;
}

/** One run of a description: plain text, or code that was between backticks. */
export type DescriptionSegment = { text: string; code: boolean };

/**
 * Splits a description at its backtick pairs so the parts between them can render as inline code.
 * An unmatched backtick and an empty pair stay as plain text.
 */
export function describeSegments(description: string): DescriptionSegment[] {
  const segments: DescriptionSegment[] = [];
  let last = 0;
  for (const match of description.matchAll(/`([^`]+)`/g)) {
    const start = match.index;
    if (start > last) segments.push({ text: description.slice(last, start), code: false });
    segments.push({ text: match[1] ?? '', code: true });
    last = start + match[0].length;
  }
  if (last < description.length) segments.push({ text: description.slice(last), code: false });
  return segments;
}

/** The statuses a narrative fold never hides: something went wrong, is waiting on a person or a signal, or is under way. */
const FOLD_PINNED_STATUSES: ReadonlySet<RunStepStatus> = new Set([
  'failed',
  'timed-out',
  'waiting_approval',
  'waiting',
  'running',
  'retrying',
]);

/** A narrative timeline with its middle folded, and the action each fold row carries. */
export type FoldedNarrativeEntries = {
  /** The entries to draw: the steps, with each folded run replaced by one row. */
  readonly entries: RunStepTimelineEntry[];
  /** The action text of each fold row, by the row's step id. */
  readonly rows: ReadonlyMap<string, string>;
};

/**
 * Replaces the middle of a long narrative timeline with fold rows: the first and last few entries
 * stay, steps that failed or wait never fold, and each run of at least two entries that remains is
 * one row, "3 more calls", whose action reads "Show all 9".
 */
export function foldNarrativeEntries(
  entries: readonly RunStepTimelineEntry[],
  fold: RunStepTimelineFold | undefined,
): FoldedNarrativeEntries {
  const label = fold?.label ?? ((hidden: number) => `${hidden} more steps`);
  const actionLabel = fold?.actionLabel ?? ((total: number) => `Show all ${total}`);
  const rows = new Map<string, string>();
  const folded: RunStepTimelineEntry[] = [];
  const plan = planFold(entries, {
    first: fold?.first ?? 3,
    last: fold?.last ?? 3,
    // A branch group is never folded: it draws its own lanes.
    isPinned: (entry) => 'kind' in entry || FOLD_PINNED_STATUSES.has(entry.status),
  });
  for (const part of plan) {
    if (part.kind === 'item') {
      folded.push(part.item);
      continue;
    }
    const id = `__cinder-fold-${part.key}`;
    rows.set(id, actionLabel(entries.length));
    folded.push({ id, label: label(part.items.length), status: 'recorded' });
  }
  return { entries: folded, rows };
}
