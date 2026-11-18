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
  /** The accessible name and tooltip of the button to the previous question, shown with several. Default `Previous question`. */
  previous: string;
  /** The accessible name and tooltip of the button to the next question, shown with several. Default `Next question`. */
  next: string;
  /** The choice that opens a field for an answer of the person's own. Default `Something else`. */
  somethingElse: string;
  /** The accessible name of that field. Default `Your own answer`. */
  ownAnswer: string;
  /** The placeholder of that field. Default `Type your answer`. */
  ownAnswerPlaceholder: string;
  /** The quiet button that gives the composer back so the person can reply in a message; its glyph and these words, or only the glyph when the row cannot hold them. Default `Reply in chat`. */
  replyInChat: string;
  /** The primary button that sends the chosen answer. Default `Answer`. */
  answer: string;
  /** The one muted line under an answered question the run has moved on from, which can no longer be changed. Default `This answer was sent.`. */
  sent: string;
  /** What a failed send says. Default `The answer could not be sent. Try again.`. */
  failed: string;
  /** Host-overridable text. The default reads `Yes`. */
  yes: string;
  /** Host-overridable text. The default reads `No`. */
  no: string;
};

/** The value of the choice that opens the own-answer field. */
export const OTHER_CHOICE = 'other';

/** The words the dock uses when the host sets none. */
export const DEFAULT_QUESTION_DOCK_LABELS: ChatQuestionDockLabels = {
  needsYou: 'Needs you',
  legend: 'Question',
  progress: (position, total) => `Question ${position} of ${total}`,
  previous: 'Previous question',
  next: 'Next question',
  somethingElse: 'Something else',
  ownAnswer: 'Your own answer',
  ownAnswerPlaceholder: 'Type your answer',
  replyInChat: 'Reply in chat',
  answer: 'Answer',
  sent: 'This answer was sent.',
  failed: 'The answer could not be sent. Try again.',
  yes: 'Yes',
  no: 'No',
};
