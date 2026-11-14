/** The words `/reviews` uses outside its states. */
export const REVIEWS_COPY = {
  heading: 'Reviews',
  description: 'Approvals, questions and workflow reviews waiting on you.',
  /** The accessible name of the segments that say which reviews are listed; narrow, they read "Status: Waiting 2". */
  tabsLabel: 'Reviews by state',
  /** The segments of the list: the words ahead of their counts. */
  tabs: { waiting: 'Waiting', done: 'Done' },
  /** The accessible name of each list. */
  listLabel: { waiting: 'Waiting on you', done: 'Decided' },
  detailLabel: 'Review',
  /** Said at the head of the list: the keys that move through it. */
  keysHint: 'J and K move between reviews.',
  /** The bands the Done list is grouped under, before the day's date. */
  day: { today: 'Today', yesterday: 'Yesterday' },
  /** The small line over an open question's and an open workflow review's heading (an approval's is `toolApproval`). */
  questionEyebrow: 'Question from an agent',
  workflowEyebrow: 'Review requested by a workflow',
  /** Said under an approval's heading, ahead of the tool it wants to run. */
  wantsToRun: 'It wants to run',
  /** How risky the tool is, by the risk the approval declares; a low risk says nothing. */
  risk: { high: 'Dangerous, Can’t be undone', medium: 'Changes things' },
  /** The placeholder of the note field on an approval. */
  notePlaceholder: 'Add a note',
  /** Said in place of a review that left the queue while it was open: the agent moved on. */
  noLongerWaiting: {
    message: 'No longer waiting. The agent already moved on, so nothing is needed from you.',
    next: 'Next review',
  },
  /** The words a decision is announced with, politely, once it has landed. */
  announced: {
    approved: 'Approved',
    denied: 'Denied',
    answered: 'Answered',
    sentBack: 'Sent back',
    gone: 'No longer waiting',
  },
  /** One announcement: what happened, then the review it happened to ("Approved: Refund order 4471"). */
  announce: (word: string, title: string): string => (title === '' ? word : `${word}: ${title}`),
  /** A decided review's word when the viewer decided it ("Approved by you"). */
  decidedByYou: (word: string): string => `${word} by you`,
  /** What a workflow review's decision bar says. */
  workflow: {
    approve: 'Approve',
    sendBack: 'Send back',
    notePlaceholder: 'Say what to change if you send it back',
    noteDescription:
      'Saved with your decision. If you send it back, the workflow reads it as what to change.',
    footer: 'The workflow continues as soon as you answer.',
    draftLabel: 'Draft',
    copyDraft: 'Copy the draft',
    draftCopied: 'Draft copied',
  },
  /** The status of the list while it is read. */
  loading: 'Loading reviews',
  /** What a person sees under the heading of a list that holds more than a page. */
  loadMore: 'Load more',
  workflowReview: 'Workflow review',
  /** The label for a review that asks to approve a tool call. */
  toolApproval: 'Tool approval',
  /** The label for a review that asks a question. */
  humanWait: 'Question',
  openChat: 'Open chat',
  unknownAgent: 'An agent',
  untitledChat: 'Untitled chat',
  questionFallback: 'It is waiting for your answer.',
  waiting: (count: number): string => `${String(count)} waiting on you`,
  approve: 'Approve',
  deny: 'Deny',
  reject: 'Reject',
  reasonLabel: 'Reason (required to reject)',
  reasonDescription: 'Sent with the decision. A rejection cannot be sent without one.',
  answerLabel: 'Your answer',
  /** Said once in the footer of an open question: what the agent does with the answer. */
  answerHint: 'The agent continues as soon as you answer.',
  /** The footer button that commits a structured answer (a form), which picking a value does not send. */
  sendAnswer: 'Send answer',
  /** The optional note saved with any decision; on a denial the agent reads it. */
  noteLabel: 'Note',
  /** Said under the note field: where the note goes. */
  noteDescription: 'Saved with your decision. If you deny, the agent reads it as the reason.',
  toolLabel: 'Tool',
  argumentsLabel: 'Arguments',
  /** The labels on the parts of what an approval would run. */
  operation: {
    command: 'Command',
    diff: 'Changes',
    filesTouched: 'Files touched',
    showWholeDiff: 'Show the whole diff',
  },
  reasonFact: 'Reason',
  messageFact: 'Message',
  riskFact: 'Risk',
  requestedFact: 'Requested',
  agentFact: 'Agent',
  noReviewSelected: 'No review selected',
  chooseReview: 'Choose a review from the list.',
  allCaughtUp: 'Nothing waiting on you',
  nothingWaiting: 'When an agent asks for approval or has a question, it shows up here.',
  nothingDecided: 'Nothing decided yet',
  nothingDecidedDescription: 'Reviews you approve, deny or answer are listed here.',
  /** The source line under a question: who asked, where, and since when. */
  source: {
    askedBy: 'Asked by',
    in: 'in',
    waitingSince: 'waiting since',
    askedAt: 'asked',
    thisRun: 'this run',
    unknownWorkflow: 'a workflow',
  },
  /** The ways a review left the queue, in a word. */
  decided: {
    waiting: 'Waiting',
    approved: 'Approved',
    denied: 'Denied',
    rejected: 'Rejected',
    needsChanges: 'Changes requested',
    answered: 'Answered',
    closed: 'Closed',
  },
  /** Between what became of a review and who did it. */
  by: 'by',
  /** After a review's kind in its list row: "Tool approval from Tool runner". */
  fromAgent: (agent: string): string => `from ${agent}`,
  /** Who decided a review the caller decided, in place of their principal's identifier. */
  you: 'you',
  reasonIs: 'Reason',
  artifactLabel: 'What the workflow asks you to review',
  answerRecorded: 'The answer was sent to the agent.',
  allowForChat: 'Allow for the rest of this chat',
  notRemembered: {
    title: 'Approved, but not remembered',
    message: 'The tool will ask again in this chat.',
  },
  /** Said in the chat when the approval went through but the grant will not stop the next ask. */
  notLoosened: {
    title: 'Approved, but it will ask again',
    message: (toolName: string): string =>
      `The permission was saved, but this agent will still ask before using ${toolName} again.`,
  },
  /** Said under a question that is picked from choices: the number keys. */
  pickHint: 'Press 1 to 9 to pick a choice.',
  /** What the open approval would run, and what it was given. */
  inputLabel: 'Input',
  noInput: 'This call was given no input.',
  /** The shortcuts the `?` map lists for this page. */
  shortcutGroup: 'Reviews',
  approveShortcut: 'Approve the open review',
  denyShortcut: 'Deny the open review',
  pickShortcut: (position: number): string => `Pick choice ${String(position)}`,
  decisionFailed: 'The decision was not recorded',
  /**
   * The Bureau's answer when a decision took effect and only its write into the conversation
   * failed (`APPROVAL_OUTCOME_NOT_WRITTEN`). It is not a lost race, so it does not say the decision
   * was not recorded.
   */
  outcomeNotWritten: {
    title: 'The decision took effect',
    message:
      'The tool ran or was refused as you decided, but its outcome could not be written into the conversation. The chat may show the approval as pending until it is reloaded. Do not decide it again.',
  },
  /**
   * The Bureau's answer when the approval was gated again after the row showed it
   * (`REVIEW_ROUND_CHANGED`): it keeps its id, so the decision would have answered a request the
   * person never read, and nothing was decided.
   */
  roundChanged: {
    title: 'This review changed while you read it',
    message: 'it was not decided. Read it again before deciding.',
  },
  answerFailed: 'The answer was not sent',
  superseded:
    'The approval was gated again, so the tool did not run. A replacement approval is waiting.',
} as const;
