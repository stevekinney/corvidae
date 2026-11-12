/**
 * The words of the question dock (COR-2278, row P3), kept apart from the component so `ChatProps`
 * can name the type without importing a Svelte file.
 */

/**
 * The words of the question dock. Each is a plain string, so a host can say it its own way or in
 * its own language; `progress` is a function of where the question falls among those asked.
 */
export type ChatQuestionDockLabels = {
  /** The warning that the run waits on the person. Default `Needs you`. */
  needsYou: string;
  /** The legend of the group of choices, read by assistive technology and not drawn. Default `Question`. */
  legend: string;
  /** Where the question falls among several asked together. Default `Question 2 of 3`. */
  progress: (position: number, total: number) => string;
  /** The choice that opens a field for an answer of the person's own. Default `Something else`. */
  somethingElse: string;
  /** The cue shown after scrolling away from the first choice. */
  moreChoicesAbove: string;
  /** The cue shown when more choices remain below the visible choices. */
  moreChoicesBelow: string;
  /** The accessible name of that field. Default `Your own answer`. */
  ownAnswer: string;
  /** The placeholder of that field. Default `Type your answer`. */
  ownAnswerPlaceholder: string;
  /** The secondary button that gives the composer back so the person can reply in a message. Default `Reply in chat instead`. */
  replyInChat: string;
  /** The primary button that sends the chosen answer. Default `Answer`. */
  answer: string;
  /** What a failed send says. Default `The answer could not be sent. Try again.`. */
  failed: string;
  yes: string;
  no: string;
};

/** The value of the choice that opens the own-answer field. */
export const OTHER_CHOICE = 'other';

/** The words the dock uses when the host sets none. */
export const DEFAULT_QUESTION_DOCK_LABELS: ChatQuestionDockLabels = {
  needsYou: 'Needs you',
  legend: 'Question',
  progress: (position, total) => `Question ${position} of ${total}`,
  somethingElse: 'Something else',
  moreChoicesAbove: 'More choices above',
  moreChoicesBelow: 'More choices below',
  ownAnswer: 'Your own answer',
  ownAnswerPlaceholder: 'Type your answer',
  replyInChat: 'Reply in chat instead',
  answer: 'Answer',
  failed: 'The answer could not be sent. Try again.',
  yes: 'Yes',
  no: 'No',
};
