/**
 * How the Checks page reads its results, with no DOM in it (COR-2114, the agreed design): each
 * result as a row (the check in words, the outcome's status word, the kind, the agent, the score and
 * the version), the filter the address holds, what each facet offers, and where a row leads. Plain
 * functions, so the page, its tests and the browser specs read one source.
 */
import {
  CHECK_KIND_OUTCOMES,
  CHECK_OUTCOME_WORDS,
  CHECK_SEGMENT_KINDS,
  CHECK_SEGMENTS,
  CHECK_TIME_MILLISECONDS,
  CHECK_TIMES,
  CHECKS_COPY,
  type CheckSegment,
  type CheckTime,
} from '../../app/copy/checks.ts';
import {
  CHECK_OUTCOMES,
  type CheckFilter,
  type CheckKind,
  type CheckOutcome,
  type CheckRow,
} from '../../lib/bureau-checks.ts';
import { checkText } from '../../lib/check-text.ts';
import { goalPath } from '../../lib/identifier-paths.ts';
import { workflowDetailPath } from '../../lib/router.svelte.ts';

/** The filter the address holds. A value the address names that the page does not know is no filter. */
export type ChecksFilter = {
  /** The Kind segment; `all` is no kind. */
  readonly segment: CheckSegment;
  /** A check, exactly as a row names it: `name@version`. */
  readonly check?: string;
  readonly outcome?: CheckOutcome;
  readonly agent?: string;
  readonly time?: CheckTime;
};

/** The kind a segment asks for, or `undefined` for All. */
export function segmentKind(segment: CheckSegment): CheckKind | undefined {
  return segment === 'all' ? undefined : CHECK_SEGMENT_KINDS[segment];
}

/** Whether `outcome` is one a result of the segment's kind can carry; every outcome fits All. */
export function outcomeFitsSegment(outcome: CheckOutcome, segment: CheckSegment): boolean {
  const kind = segmentKind(segment);
  return kind === undefined || CHECK_KIND_OUTCOMES[kind].includes(outcome);
}

/** Reads the filter out of a query string; a value it does not know is no filter. */
export function parseChecksFilter(search: URLSearchParams): ChecksFilter {
  const segment = CHECK_SEGMENTS.find((candidate) => candidate === search.get('kind')) ?? 'all';
  const outcome = CHECK_OUTCOMES.find((candidate) => candidate === search.get('outcome'));
  const time = CHECK_TIMES.find((candidate) => candidate === search.get('time'));
  const check = search.get('check')?.trim();
  const agent = search.get('agent')?.trim();
  return {
    segment,
    ...(check === undefined || check === '' ? {} : { check }),
    // An outcome the kind cannot have is no filter: it could only match nothing.
    ...(outcome === undefined || !outcomeFitsSegment(outcome, segment) ? {} : { outcome }),
    ...(agent === undefined || agent === '' ? {} : { agent }),
    ...(time === undefined ? {} : { time }),
  };
}

/** The query string a filter is kept in the address as. */
export function serializeChecksFilter(filter: ChecksFilter): string {
  const params = new URLSearchParams();
  if (filter.segment !== 'all') params.set('kind', filter.segment);
  if (filter.check !== undefined) params.set('check', filter.check);
  if (filter.outcome !== undefined) params.set('outcome', filter.outcome);
  if (filter.agent !== undefined) params.set('agent', filter.agent);
  if (filter.time !== undefined) params.set('time', filter.time);
  return params.toString();
}

/** Whether the address narrows the list at all. */
export function checksAreFiltered(filter: ChecksFilter): boolean {
  return serializeChecksFilter(filter) !== '';
}

/**
 * What the operation is asked for under a filter. The time preset reaches back from `now`, which
 * is read when a page is asked for, so every page of one read shares its cut.
 */
export function checksQuery(filter: ChecksFilter, now: number): CheckFilter {
  const kind = segmentKind(filter.segment);
  return {
    ...(kind === undefined ? {} : { kind }),
    ...(filter.check === undefined ? {} : { checkId: filter.check }),
    ...(filter.outcome === undefined ? {} : { outcome: filter.outcome }),
    ...(filter.agent === undefined ? {} : { agentName: filter.agent }),
    ...(filter.time === undefined ? {} : { since: now - CHECK_TIME_MILLISECONDS[filter.time] }),
  };
}

/** The outcomes the Outcome chip offers: every one under All, only the kind's under a Kind. */
export function outcomesOffered(segment: CheckSegment): readonly CheckOutcome[] {
  const kind = segmentKind(segment);
  return kind === undefined ? CHECK_OUTCOMES : CHECK_KIND_OUTCOMES[kind];
}

/**
 * A check's id split into its name and its version. A goal's validator and a scorer are named
 * `name@version`, and the version is what follows the last "@"; every other check's id is its name
 * whole, whatever it holds.
 */
export function splitCheckId(
  kind: CheckKind,
  checkId: string,
): { readonly name: string; readonly version: string | undefined } {
  if (kind !== 'goal.attempt.validated' && kind !== 'scorer.recorded') {
    return { name: checkId, version: undefined };
  }
  const at = checkId.lastIndexOf('@');
  if (at === -1) return { name: checkId, version: undefined };
  const version = checkId.slice(at + 1);
  return { name: checkId.slice(0, at), version: version === '' ? undefined : version };
}

/** The check in words, as the goal pages say it: the title of a row. */
export function checkTitle(row: Pick<CheckRow, 'kind' | 'checkId'>): string {
  return checkText(splitCheckId(row.kind, row.checkId).name);
}

/** The status word of a row: its outcome in the words of Cinder's table, never the raw value. */
export function checkWord(
  row: Pick<CheckRow, 'outcome'>,
): (typeof CHECK_OUTCOME_WORDS)[CheckOutcome] {
  return CHECK_OUTCOME_WORDS[row.outcome];
}

/** A score from 0 to 1 to two decimals: "0.82", "1.00". */
export function scoreText(score: number): string {
  return score.toFixed(2);
}

/**
 * Line two of a row, in order: the kind word, the agent's name (left out when the row has none),
 * for a scorer its score, and the version when the id has one. Cut at its end, so the version goes
 * first, then the score, then the agent.
 *
 * @param agentLabel - The name an agent goes by, from its identifier.
 */
export function checkLineTwo(
  row: Pick<CheckRow, 'kind' | 'checkId' | 'agentName' | 'score'>,
  agentLabel: (agentName: string) => string,
): string {
  const { version } = splitCheckId(row.kind, row.checkId);
  return [
    CHECKS_COPY.kindWords[row.kind],
    ...(row.agentName === null ? [] : [agentLabel(row.agentName)]),
    ...(row.kind === 'scorer.recorded' && row.score !== null
      ? [CHECKS_COPY.score(scoreText(row.score))]
      : []),
    ...(version === undefined ? [] : [CHECKS_COPY.version(version)]),
  ].join(', ');
}

/** Where a row leads: its goal when it has one, else its run. */
export function checkPath(row: Pick<CheckRow, 'goalRunId' | 'runId'>): string {
  return row.goalRunId === null ? workflowDetailPath(row.runId) : goalPath(row.goalRunId);
}

/** A row's own key, which no other row shares. */
export function checkKey(row: CheckRow): string {
  return [
    row.kind,
    row.goalRunId ?? row.runId,
    row.attemptId ?? '',
    row.checkId,
    row.timestamp,
  ].join('\u0000');
}

/** One choice of the Check chip. */
export type CheckOption = { readonly value: string; readonly label: string };

/**
 * What the Check chip offers: the checks of the rows loaded and the one the address applies, each
 * once, as its words and its version.
 */
export function checkOptions(
  rows: readonly Pick<CheckRow, 'kind' | 'checkId'>[],
  applied: string | undefined,
): readonly CheckOption[] {
  const found = new Map<string, CheckOption>();
  const add = (kind: CheckKind, checkId: string): void => {
    if (found.has(checkId)) return;
    const { name, version } = splitCheckId(kind, checkId);
    found.set(checkId, {
      value: checkId,
      label: CHECKS_COPY.checkOption(checkText(name), version),
    });
  };
  for (const row of rows) add(row.kind, row.checkId);
  // The applied check may not be on the loaded page: its words are read from its id alone.
  if (applied !== undefined) add(guessKind(applied), applied);
  return [...found.values()].toSorted((first, second) => first.label.localeCompare(second.label));
}

/** The kind an applied check id most likely came from, when no loaded row names it: a versioned id is a verdict's. */
function guessKind(checkId: string): CheckKind {
  return checkId.includes('@') ? 'goal.attempt.validated' : 'run.guardrail';
}
