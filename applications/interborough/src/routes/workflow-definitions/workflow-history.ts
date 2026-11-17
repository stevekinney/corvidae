/**
 * The History tab's rows (board PageWorkflow, "History tab", rows 62o and 62p): every saved version
 * of a workflow, newest first, each named by its number and whether the file holds it now, with its
 * compatibility verdict as a neutral word, what changed from the version before, what that meant
 * for the runs, and when it was saved. Plain functions over `bureau.workflows.history`, in the words
 * `copy/workflows.ts` holds, so the rows are tested without a page. The facts of a line are joined
 * with commas, never a middle dot.
 */
import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
import { clockTime, viewerTimeZone } from '../../lib/format/clock.ts';
import type { WorkflowHistoryEntry } from '../../lib/workflow-files.ts';

/** One version as its row reads. */
export type HistoryRow = {
  /** The version's number, `1.3.0`, which keys the row. */
  readonly version: string;
  /** "Version 1.3.0, current version". */
  readonly title: string;
  /** The neutral verdict word, or `null` for the first version, which nothing came before. */
  readonly verdict: 'Compatible' | 'Breaking' | null;
  /** What changed and what it meant for the runs: "Edited in the builder: reworded step 2, Runs in flight keep going". */
  readonly line: string;
  /** When it was saved: "Sun, Nov 1, 4:30 PM". */
  readonly savedAt: string;
  /** The instant it was saved, for the `<time>` element. */
  readonly savedAtIso: string;
};

/** A change as a verb and what it acts on, so two changes with one verb read as one clause. */
type Clause = { readonly verb: string; readonly object: string };

function stepTitle(entry: WorkflowHistoryEntry, step: number): string | null {
  const title = entry.steps[step - 1]?.['title'];
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : null;
}

/** One change in words, or `null` for a kind this page does not know. */
function clauseOf(
  entry: WorkflowHistoryEntry,
  change: WorkflowHistoryEntry['changes'][number],
): Clause | null {
  const copy = WORKFLOW_COPY.history.changes;
  const step = change.step ?? 0;
  switch (change.kind) {
    case 'title':
      return { verb: copy.renamed, object: copy.theWorkflow };
    case 'description':
      return { verb: copy.changed, object: copy.theDescription };
    case 'trigger':
      return { verb: copy.changed, object: copy.whatStartsIt };
    case 'input-schema':
      return { verb: copy.changed, object: copy.theInput };
    case 'output-schema':
      return { verb: copy.changed, object: copy.theOutput };
    case 'output-name':
      return { verb: copy.renamed, object: copy.theOutput };
    case 'step-added':
      return { verb: copy.added, object: copy.step(step, stepTitle(entry, step)) };
    case 'step-removed':
      return { verb: copy.removed, object: copy.step(step, null) };
    case 'step-replaced':
      return { verb: copy.replaced, object: copy.step(step, null) };
    case 'step-renamed':
      return { verb: copy.renamed, object: copy.step(step, null) };
    case 'step-reworded':
      return { verb: copy.reworded, object: copy.step(step, null) };
    case 'step-agent':
      return { verb: copy.changed, object: copy.stepAgent(step) };
    case 'step-input':
      return { verb: copy.changed, object: copy.stepInput(step) };
    case 'step-signal':
      return { verb: copy.changed, object: copy.stepSignal(step) };
    case 'step-review':
      return { verb: copy.changed, object: copy.stepReview(step) };
    case 'step-duration':
      return { verb: copy.changed, object: copy.stepDuration(step) };
    default:
      return null;
  }
}

/** "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/**
 * What changed from the version before, as one clause: "reworded step 2", "changed step 2’s input
 * and the workflow input". Changes that share a verb share it, in the order the Bureau lists them.
 */
export function changeWords(entry: WorkflowHistoryEntry): string {
  const copy = WORKFLOW_COPY.history.changes;
  if (entry.previousVersion === null) return copy.created;
  const clauses: { verb: string; objects: string[] }[] = [];
  for (const change of entry.changes) {
    const clause = clauseOf(entry, change);
    if (clause === null) continue;
    const same = clauses.find((existing) => existing.verb === clause.verb);
    if (same === undefined) clauses.push({ verb: clause.verb, objects: [clause.object] });
    else if (!same.objects.includes(clause.object)) same.objects.push(clause.object);
  }
  if (clauses.length === 0) return copy.unchanged;
  return listed(clauses.map((clause) => `${clause.verb} ${listed(clause.objects)}`));
}

/** The sentence starts with a capital, whatever its first word. */
function capitalized(text: string): string {
  return text === '' ? text : `${text.charAt(0).toLocaleUpperCase()}${text.slice(1)}`;
}

/**
 * What the version meant for the runs: the runs started on it ("Run on this version: 1 (Fri, Oct
 * 30)"), that the runs in flight keep going under the current one, or, for a breaking one, that
 * the runs already going finished on the version before. `null` when there is nothing to say, or
 * the caller may not count the runs.
 */
export function runsWords(entry: WorkflowHistoryEntry, zone: string): string | null {
  const copy = WORKFLOW_COPY.history;
  const runs = entry.runs;
  if (runs !== null && runs.count > 0 && runs.lastRunAt !== null) {
    return copy.runsOnVersion(runs.count, shortDay(Date.parse(runs.lastRunAt), zone));
  }
  if (entry.compatibility === 'breaking' && entry.previousVersion !== null) {
    return copy.finishedOn(entry.previousVersion);
  }
  if (entry.current && entry.compatibility !== 'breaking') return copy.inFlightKeepGoing;
  return null;
}

/** "Fri, Oct 30". */
function shortDay(at: number, zone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: zone,
  }).format(at);
}

/** The History tab's rows, newest first, as the Bureau lists the versions. */
export function historyRows(
  entries: readonly WorkflowHistoryEntry[],
  zone: string = viewerTimeZone(),
): HistoryRow[] {
  const copy = WORKFLOW_COPY.history;
  return entries.map((entry) => {
    // A save from the builder says so before what it changed (row 62o); any other leads with the change.
    const builder =
      entry.origin === 'write' && (entry.surface === 'web' || entry.surface === 'palette');
    const changed = changeWords(entry);
    const what = builder ? copy.editedInBuilder(changed) : capitalized(changed);
    const runs = runsWords(entry, zone);
    const savedAt = Date.parse(entry.savedAt);
    return {
      version: entry.version,
      title: copy.versionTitle(entry.version, entry.current),
      verdict:
        entry.compatibility === 'compatible'
          ? copy.compatible
          : entry.compatibility === 'breaking'
            ? copy.breaking
            : null,
      line: runs === null ? what : `${what}, ${runs}`,
      // The day is always named, as the board draws it: "Sun, Nov 1, 4:30 PM", never "Yesterday".
      savedAt: `${shortDay(savedAt, zone)}, ${clockTime(savedAt, zone)}`,
      savedAtIso: entry.savedAt,
    };
  });
}
