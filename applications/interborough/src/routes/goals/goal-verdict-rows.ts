/**
 * What an attempt's verdict panel says (COR-2124), with no DOM in it: the facts of a verdict the
 * Bureau gave, and the words for one it did not. The panel reads `bureau.goals.verdict`, which
 * answers `NotFound` both for an attempt with no verdict yet and, as for a missing goal, for a viewer
 * who may not read the goal's content, so the two are told apart by who is looking.
 */
import type { StatusDotWordLabel } from '@lostgradient/cinder';

import { GOALS_COPY } from '../../app/copy/goals.ts';
import type { GoalVerdict } from '../../lib/bureau-goals.ts';
import { checkText } from './goal-rows.ts';

const copy = GOALS_COPY.detail.verdict;

/** One term and its words, as the panel's description list draws them, and a muted line under them. */
export type VerdictFact = {
  readonly term: string;
  readonly definition: string;
  readonly note?: string;
};

/**
 * The status word a verdict opens with: the word the attempt's row says when the check passed or
 * did not pass (Done, Check not met), and a word of its own for each other kind of verdict, so the
 * panel and a row that learns to say it use the same one.
 */
export function verdictWord(outcome: GoalVerdict['outcome']): StatusDotWordLabel {
  return copy.word[outcome];
}

/**
 * The facts of a verdict that read as words, in the order they matter: what the check could not do
 * (when it gave a reason or an error), then the check itself, in words with its exact name,
 * version and where it comes from beneath. The outcome is the panel's status word, the feedback its
 * paragraph and the evidence its own section, so none is a fact here.
 */
export function verdictFacts(
  verdict: Pick<GoalVerdict, 'reason' | 'error' | 'validator' | 'judgedBy' | 'configuration'>,
): VerdictFact[] {
  const detail = verdict.error?.message ?? verdict.reason;
  const judge = verdict.judgedBy;
  const configuration = judge === null ? verdict.configuration : judge.configuration;
  return [
    ...(detail === null || detail === undefined || detail === ''
      ? []
      : [{ term: copy.detailTerm, definition: detail }]),
    {
      term: GOALS_COPY.detail.checkFact,
      definition: checkText((judge ?? verdict).validator.name, configuration),
      note:
        judge === null
          ? copy.validatorOnly(verdict.validator)
          : copy.judgedBy(judge.validator, judge.source, checkText(judge.source.name)),
    },
  ];
}

/** What the panel says when there is no verdict to show, and in which tone. */
export type VerdictFailure = {
  /** `private`: the viewer may not read it. `not-judged`: nothing to read yet. `unreadable`: the read failed. */
  readonly reason: 'private' | 'not-judged' | 'unreadable';
  readonly tone: 'neutral' | 'warning';
  readonly title: string;
  readonly message: string;
};

/**
 * The words for a verdict that could not be read. A `NotFound` is "private" for a viewer that is not
 * the goal's owner (the Bureau answers a goal's content as missing to one who holds no content
 * scope), and "not judged yet" for the owner, whose own goal has nothing to read yet. A host that
 * names no principal is the local owner, so a `NotFound` there is "not judged yet" too.
 */
export function verdictFailure(
  code: string | undefined,
  context: { readonly owner: string; readonly viewer: string | null | undefined },
): VerdictFailure {
  if (code === 'NotFound') {
    const viewer = context.viewer;
    return viewer !== undefined && viewer !== null && viewer !== context.owner
      ? { reason: 'private', tone: 'neutral', title: copy.privateTitle, message: copy.private }
      : {
          reason: 'not-judged',
          tone: 'neutral',
          title: copy.notJudgedTitle,
          message: copy.notJudged,
        };
  }
  return { reason: 'unreadable', tone: 'warning', title: copy.failedTitle, message: copy.failed };
}
