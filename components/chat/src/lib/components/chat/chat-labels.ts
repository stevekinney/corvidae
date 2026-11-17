/** Host-overridable words used by the composer and approval drawer. */
export type ChatLabels = {
  /** Host-overridable text. The default reads `Sources`. */
  sources: string;
  /** The Sources control's text and accessible name: the count and the word, "3 sources" or "1 source". */
  sourcesCount: (count: number) => string;
  /** Host-overridable text. The default reads `Internal document, no public link`. */
  internalDocument: string;
  /** Host-overridable text. The default reads `Link hidden: the address isn't a safe web link`. */
  unsafeLink: string;
  /** Host-overridable text. The default reads `Composer unavailable`. */
  composerUnavailable: string;
  /** Host-overridable text. The default reads `Chat archived`. */
  chatArchived: string;
  /** Host-overridable text. The default reads `Chat read only`. */
  chatReadOnly: string;
  /** Host-overridable text. The default reads `Offline`. */
  offline: string;
  /** Host-overridable text. The default reads `Draft restored`. */
  draftRestored: string;
  /** Host-overridable text. The default reads `Notice`. */
  notice: string;
  /** Host-overridable text. The default reads `Chat message composer`. */
  composer: string;
  /** Host-overridable text. The default reads `Drop files to attach`. */
  dropFiles: string;
  /** Host-overridable text. The default reads `Formatting`. */
  formatting: string;
  /** Host-overridable text. The default reads `Attach files`. */
  attachFiles: string;
  /** Host-overridable text. The default reads `Attach file`. */
  attachFile: string;
  /** Host-overridable text. The default reads `Stop`. */
  stop: string;
  /** Host-overridable text. The default reads `Stop generating`. */
  stopGenerating: string;
  /** Host-overridable text. The default reads `Send message`. */
  sendMessage: string;
  /** Host-overridable text. The default reads `Send`. */
  send: string;
  /** Host-overridable text. The default reads `Queue`. */
  queue: string;
  /** Host-overridable text. The default reads `Queue message`. */
  queueMessage: string;
  /** Host-overridable text. The default reads `Answer`. */
  answer: string;
  /** Host-overridable text. The default reads `Sending message`. */
  sendingMessage: string;
  /** Host-overridable text. The default reads `Image`. */
  image: string;
  /** Host-overridable text. The default reads `Code file`. */
  codeFile: string;
  /** Host-overridable text. The default reads `Document`. */
  document: string;
  /** Host-overridable text. The default reads `The answer could not be sent. Try again.`. */
  answerFailed: string;
  /** Host-overridable text. The default reads `Yes`. */
  yes: string;
  /** Host-overridable text. The default reads `No`. */
  no: string;
  /** Host-overridable text. The default reads `You answered`. */
  youAnswered: string;
  /** The badge above an open question in the transcript, matching the dock's. */
  needsYou: string;
  /** Host-overridable text. The default reads `Change`. */
  change: string;
  /** Host-overridable text. The default reads `Your own answer`. */
  yourOwnAnswer: string;
  /** Host-overridable text. The default reads `Type your answer`. */
  chooseAnswerPlaceholder: string;
  /** Host-overridable text. The default reads `Answer below`. */
  answerBelow: string;
  /** Host-overridable text. The default reads `Send comes back when you reconnect`. */
  sendOffline: string;
  /** Host-overridable text. The default reads `Wait for attachments`. */
  waitForAttachments: string;
  /** Host-overridable text. The default reads `Type an answer`. */
  typeAnswer: string;
  /** Host-overridable text. The default reads `Add a message or attachment`. */
  addMessageOrAttachment: string;
  /** Host-overridable text, built from its argument. */
  queueShortcut: (shortcut: string) => string;
  /** Host-overridable text, built from its argument. */
  sendShortcut: (shortcut: string) => string;
  /** Host-overridable text. The default reads `Answer (Enter)`. */
  answerShortcut: string;
  /** Host-overridable text. The default reads `Enter to send. Shift and Enter for a new line.`. */
  enterHint: string;
  /** Host-overridable text. The default reads `Command or Control and Enter to send. Enter for a new line.`. */
  modifierEnterHint: string;
  /** Host-overridable text. The default reads `Show more`. */
  showMore: string;
  /** Host-overridable text. The default reads `Show less`. */
  showLess: string;
  /** Host-overridable text. The default reads `Sending…`. */
  sending: string;
  /** Host-overridable text. The default reads `Expand`. */
  expand: string;
  /** Host-overridable text. The default reads `Collapse`. */
  collapse: string;
  /** Host-overridable text. The default reads `In progress`. */
  inProgress: string;
  /** Host-overridable text, built from its argument. */
  inputRequestedBy: (toolName: string) => string;
  /** Host-overridable text. The default reads `Today`. */
  today: string;
  /** Host-overridable text. The default reads `Yesterday`. */
  yesterday: string;
  /** Host-overridable text. The default reads `Invalid date`. */
  invalidDate: string;
  /** Host-overridable text, built from its argument. */
  messagesFrom: (date: string) => string;
  /** The visible name of the keyboard-focusable message viewport. */
  messages: string;
  /** Accessible name for the latest-message jump control. */
  jumpToLatest: string;
  /** Accessible name for the latest-message jump control with unread messages. */
  jumpToNewMessages: (count: number) => string;
  /** Visible and accessible label for the centered unread-message indicator. */
  newMessages: (count: number) => string;
  /** Accessible name for the unread divider. */
  newMessagesBelow: string;
  /** Visible label inside the unread divider. */
  newMessagesLabel: string;
  /** Host-overridable text. The default reads `Attached files`. */
  attachedFiles: string;
  /**
   * The line under the attachment strip while failed files block Send. A file that did not upload
   * for want of a connection, a file over the limit (`limit` is the limit in words, such as
   * "25 MB", or `undefined` when the host did not say), a file the composer cannot take, and a file
   * that failed for another reason. `accepted` is what the composer takes, in words such as "an
   * image, a PDF or a text file", so the line can say what to attach instead.
   */
  attachmentFailureNetwork: (name: string) => string;
  /** Host-overridable text, built from its argument. */
  attachmentFailureTooLarge: (name: string, limit: string | undefined) => string;
  /** `accepted` is the kinds the composer takes in words, or an empty string when none is known. */
  attachmentFailureUnsupported: (name: string, accepted: string) => string;
  /** Host-overridable text, built from its argument. */
  attachmentFailureUnknown: (name: string) => string;
  /**
   * The same four reasons for `count` files that failed for it, each one short sentence. Several
   * files with one shared reason read as that one sentence; files that failed for different
   * reasons read as one sentence for each reason, in the same notice. Only a single refused file
   * is told what to attach instead (`attachmentFailureUnsupported`).
   */
  attachmentFailureNetworkMany: (count: number) => string;
  /** Host-overridable text, built from its argument. */
  attachmentFailureTooLargeMany: (count: number, limit: string | undefined) => string;
  /** Host-overridable text, built from its argument. */
  attachmentFailureUnsupportedMany: (count: number) => string;
  /** Host-overridable text, built from its argument. */
  attachmentFailureUnknownMany: (count: number) => string;
  /** The action when every failed file can be tried again. Default `Retry all`. */
  retryAllAttachments: string;
  /** The action that tries again the `count` failed files that can be, while others cannot. Default `Retry 2`. */
  retryAttachments: (count: number) => string;
  /** The accessible name of that action. Default `Retry 2 failed files`. */
  retryAttachmentsAccessible: (count: number) => string;
  /** The action beside it that removes the failed files that cannot be tried again. Default `Remove failed`. */
  removeFailedAttachments: string;
  /** The accessible name of that action, for the `count` files it removes. */
  removeFailedAttachmentsAccessible: (count: number) => string;
  /** The action when no failed file can be tried again. Default `Remove all failed`. */
  removeAllFailedAttachments: string;
  /** Accessible name of a failed chip that shows why its file failed, when several failed. */
  showAttachmentFailureAccessible: (name: string) => string;
  /** Host-overridable text. The default reads `Retry`. */
  retryAttachment: string;
  /** Host-overridable text, built from its argument. */
  retryAttachmentAccessible: (name: string) => string;
  /** Host-overridable text. The default reads `Remove`. */
  removeAttachment: string;
  /** Host-overridable text, built from its argument. */
  removeAttachmentAccessible: (name: string) => string;
  /** Host-overridable text. The default reads `Uploading file`. */
  uploadingFile: string;
  /** Host-overridable text. The default reads `Reading file`. */
  readingFile: string;
  /** Host-overridable text. The default reads `Upload failed. Try again, or remove it.`. */
  uploadFailed: string;
  /** Host-overridable text. The default reads `Approval waiting`. */
  approvalWaiting: string;
  /** Host-overridable text. The default reads `Approval needed.`. */
  approvalWaitingText: string;
  /**
   * The sentence that follows the approval reminder, and the Queue button's description, while the
   * composer holds a draft: it says what a send does now.
   */
  approvalQueueNote: string;
  /** Host-overridable text. The default reads `Review approval`. */
  reviewApproval: string;
  /** Host-overridable heading for approvals waiting together. */
  approvalsWaiting: (count: number) => string;
  /**
   * What the approval reminder's button reads in a narrow column, where the whole row is one line
   * on a phone. Its accessible name stays `reviewApproval`, which must contain these words.
   */
  reviewApprovalShort: string;
  /** The reader, as an approval's receipt names a decision the reader made: "Approved by you". Default `you`. */
  you: string;
  /**
   * Where an approval decided in Reviews was decided, as its receipt says it: "Approved by Priya
   * Raman in Reviews". Default `Reviews`.
   */
  decidedInReviews: string;
  copy: string;
  /** Host-overridable text. The default reads `Copy message`. */
  copyMessage: string;
  /** Host-overridable text. The default reads `Copied`. */
  copied: string;
  /** Host-overridable text. The default reads `Quote message`. */
  quoteMessage: string;
  /** Host-overridable text. The default reads `Regenerate`. */
  regenerate: string;
  /** Host-overridable text. The default reads `Regenerate response`. */
  regenerateResponse: string;
  /** Host-overridable text. The default reads `Up next`. */
  followUpTitle: string;
  /** Host-overridable text. The default reads `Send now instead`. */
  followUpSendNow: string;
  /** Host-overridable text, built from its argument. */
  followUpSummary: (count: number) => string;
  /** The count with its reason, used where the drawer header has room. Default `1 queued, sends after this run`. */
  followUpSummaryExplained: (count: number) => string;
  /** The Send-now control's tooltip and accessible description. */
  followUpSendNowDescription: string;
  /** Host-overridable text, built from its argument. */
  followUpEdit: (index: number) => string;
  /** Host-overridable text, built from its argument. */
  followUpRemove: (index: number) => string;
  /** Host-overridable text. The default reads `Restore`. */
  followUpRestore: string;
  /** Host-overridable text. The default reads `Dismiss`. */
  followUpDismiss: string;
  /** Host-overridable text. The default reads `Follow-ups not sent`. */
  followUpNotSent: string;
  /** Host-overridable text, built from its argument. */
  followUpDiscardText: (count: number, reason: 'stopped' | 'failed') => string;
};

/** The words the composer and approval drawer use when a host overrides none. */
export const DEFAULT_CHAT_LABELS: ChatLabels = {
  sources: 'Sources',
  sourcesCount: (count) => (count === 1 ? '1 source' : `${count} sources`),
  internalDocument: 'Internal document, no public link',
  unsafeLink: "Link hidden: the address isn't a safe web link",
  composerUnavailable: 'Composer unavailable',
  chatArchived: 'Chat archived',
  chatReadOnly: 'Chat read only',
  offline: 'Offline',
  draftRestored: 'Draft restored',
  notice: 'Notice',
  composer: 'Chat message composer',
  dropFiles: 'Drop files to attach',
  formatting: 'Formatting',
  attachFiles: 'Attach files',
  attachFile: 'Attach file',
  stop: 'Stop',
  stopGenerating: 'Stop generating',
  sendMessage: 'Send message',
  send: 'Send',
  queue: 'Queue',
  queueMessage: 'Queue message',
  answer: 'Answer',
  sendingMessage: 'Sending message',
  image: 'Image',
  codeFile: 'Code file',
  document: 'Document',
  answerFailed: 'The answer could not be sent. Try again.',
  yes: 'Yes',
  no: 'No',
  youAnswered: 'You answered',
  needsYou: 'Needs you',
  change: 'Change',
  yourOwnAnswer: 'Your own answer',
  chooseAnswerPlaceholder: 'Type your answer',
  answerBelow: 'Answer below',
  sendOffline: 'Send comes back when you reconnect',
  waitForAttachments: 'Wait for attachments',
  typeAnswer: 'Type an answer',
  addMessageOrAttachment: 'Add a message or attachment',
  queueShortcut: (shortcut) => `Queue (${shortcut})`,
  sendShortcut: (shortcut) => `Send (${shortcut})`,
  answerShortcut: 'Answer (Enter)',
  enterHint: 'Enter to send. Shift and Enter for a new line.',
  modifierEnterHint: 'Command or Control and Enter to send. Enter for a new line.',
  showMore: 'Show more',
  showLess: 'Show less',
  sending: 'Sending…',
  expand: 'Expand',
  collapse: 'Collapse',
  inProgress: 'In progress',
  inputRequestedBy: (toolName) => `Input requested by ${toolName}`,
  today: 'Today',
  yesterday: 'Yesterday',
  invalidDate: 'Invalid date',
  messagesFrom: (date) => `Messages from ${date}`,
  messages: 'Messages',
  jumpToLatest: 'Jump to latest',
  jumpToNewMessages: (count) => `Jump to ${count} new message${count !== 1 ? 's' : ''}`,
  newMessages: (count) => `${count} new message${count !== 1 ? 's' : ''}`,
  newMessagesBelow: 'New messages below',
  newMessagesLabel: 'New',
  attachedFiles: 'Attached files',
  attachmentFailureNetwork: (name) => `${name} didn't upload. Check your connection.`,
  attachmentFailureTooLarge: (name, limit) =>
    limit === undefined ? `${name} is over the limit.` : `${name} is over the ${limit} limit.`,
  attachmentFailureUnsupported: (name, accepted) =>
    accepted === ''
      ? `${name} can't be attached.`
      : `${name} can't be attached. Attach ${accepted}.`,
  attachmentFailureUnknown: (name) => `${name} didn't upload.`,
  attachmentFailureNetworkMany: (count) =>
    `${count} ${count === 1 ? 'file' : 'files'} didn't upload. Check your connection.`,
  attachmentFailureTooLargeMany: (count, limit) =>
    `${count} ${count === 1 ? 'file is' : 'files are'} over the ${limit === undefined ? '' : `${limit} `}limit.`,
  attachmentFailureUnsupportedMany: (count) =>
    `${count} ${count === 1 ? 'file' : 'files'} can't be attached.`,
  attachmentFailureUnknownMany: (count) =>
    `${count} ${count === 1 ? 'file' : 'files'} didn't upload.`,
  retryAllAttachments: 'Retry all',
  retryAttachments: (count) => `Retry ${count}`,
  retryAttachmentsAccessible: (count) => `Retry ${count} failed ${count === 1 ? 'file' : 'files'}`,
  removeFailedAttachments: 'Remove failed',
  removeFailedAttachmentsAccessible: (count) =>
    `Remove failed: ${count} ${count === 1 ? 'file' : 'files'} that can’t be retried`,
  removeAllFailedAttachments: 'Remove all failed',
  showAttachmentFailureAccessible: (name) => `Why ${name} failed`,
  retryAttachment: 'Retry',
  retryAttachmentAccessible: (name) => `Retry ${name}`,
  removeAttachment: 'Remove',
  removeAttachmentAccessible: (name) => `Remove ${name}`,
  uploadingFile: 'Uploading file',
  readingFile: 'Reading file',
  uploadFailed: 'Upload failed. Try again, or remove it.',
  approvalWaiting: 'Approval waiting',
  approvalWaitingText: 'Approval needed.',
  approvalQueueNote: 'Messages you send now wait until you decide.',
  reviewApproval: 'Review approval',
  approvalsWaiting: (count) => `${count} approvals waiting`,
  reviewApprovalShort: 'Review',
  you: 'you',
  decidedInReviews: 'Reviews',
  copy: 'Copy',
  copyMessage: 'Copy message',
  copied: 'Copied',
  quoteMessage: 'Quote message',
  regenerate: 'Regenerate',
  regenerateResponse: 'Regenerate response',
  followUpTitle: 'Up next',
  followUpSendNow: 'Send now instead',
  followUpSummary: (count) => `${count} queued`,
  followUpSummaryExplained: (count) => `${count} queued, sends after this run`,
  followUpSendNowDescription: 'Otherwise it sends when this run finishes.',
  followUpEdit: (index) => `Edit queued follow-up ${index}`,
  followUpRemove: (index) => `Remove queued follow-up ${index}`,
  followUpRestore: 'Restore',
  followUpDismiss: 'Dismiss',
  followUpNotSent: 'Follow-ups not sent',
  followUpDiscardText: (count, reason) => {
    const cause = reason === 'stopped' ? 'The run was stopped' : 'The run failed';
    return count === 1
      ? `${cause}, so your queued follow-up was not sent.`
      : `${cause}, so your ${count} queued follow-ups were not sent.`;
  },
};

/** Merges a host's partial labels over {@link DEFAULT_CHAT_LABELS}. */
export function resolveChatLabels(labels: Partial<ChatLabels> | undefined): ChatLabels {
  return labels === undefined ? DEFAULT_CHAT_LABELS : { ...DEFAULT_CHAT_LABELS, ...labels };
}
