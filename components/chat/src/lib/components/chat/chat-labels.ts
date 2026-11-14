/** Host-overridable words used by the composer and approval drawer. */
export type ChatLabels = {
  sources: string;
  /** The Sources control's text and accessible name: the count and the word, "3 sources" or "1 source". */
  sourcesCount: (count: number) => string;
  internalDocument: string;
  unsafeLink: string;
  composerUnavailable: string;
  chatArchived: string;
  chatReadOnly: string;
  offline: string;
  draftRestored: string;
  notice: string;
  composer: string;
  dropFiles: string;
  formatting: string;
  attachFiles: string;
  attachFile: string;
  stop: string;
  stopGenerating: string;
  sendMessage: string;
  send: string;
  queue: string;
  queueMessage: string;
  answer: string;
  sendingMessage: string;
  image: string;
  codeFile: string;
  document: string;
  answerFailed: string;
  yes: string;
  no: string;
  youAnswered: string;
  /** The badge above an open question in the transcript, matching the dock's. */
  needsYou: string;
  change: string;
  yourOwnAnswer: string;
  chooseAnswerPlaceholder: string;
  answerBelow: string;
  sendOffline: string;
  waitForAttachments: string;
  typeAnswer: string;
  addMessageOrAttachment: string;
  queueShortcut: (shortcut: string) => string;
  sendShortcut: (shortcut: string) => string;
  answerShortcut: string;
  enterHint: string;
  modifierEnterHint: string;
  showMore: string;
  showLess: string;
  sending: string;
  expand: string;
  collapse: string;
  inProgress: string;
  inputRequestedBy: (toolName: string) => string;
  today: string;
  yesterday: string;
  invalidDate: string;
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
  attachedFiles: string;
  /**
   * The line under the attachment strip while failed files block Send. A file that did not upload
   * for want of a connection, a file over the limit (`limit` is the limit in words, such as
   * "25 MB", or `undefined` when the host did not say), a file the composer cannot take, and a file
   * that failed for another reason. `accepted` is what the composer takes, in words such as "an
   * image, a PDF or a text file", so the line can say what to attach instead.
   */
  attachmentFailureNetwork: (name: string) => string;
  attachmentFailureTooLarge: (name: string, limit: string | undefined) => string;
  attachmentFailureUnsupported: (name: string, accepted: string) => string;
  attachmentFailureUnknown: (name: string) => string;
  /**
   * The same four reasons for `count` files that failed for it, each one short sentence. Several
   * files with one shared reason read as that one sentence; files that failed for different
   * reasons read as one sentence for each reason, in the same notice. Only a single refused file
   * is told what to attach instead (`attachmentFailureUnsupported`).
   */
  attachmentFailureNetworkMany: (count: number) => string;
  attachmentFailureTooLargeMany: (count: number, limit: string | undefined) => string;
  attachmentFailureUnsupportedMany: (count: number) => string;
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
  retryAttachment: string;
  retryAttachmentAccessible: (name: string) => string;
  removeAttachment: string;
  removeAttachmentAccessible: (name: string) => string;
  uploadingFile: string;
  readingFile: string;
  uploadFailed: string;
  approvalWaiting: string;
  approvalWaitingText: string;
  /**
   * The sentence that follows the approval reminder, and the Queue button's description, while the
   * composer holds a draft: it says what a send does now.
   */
  approvalQueueNote: string;
  reviewApproval: string;
  copy: string;
  copyMessage: string;
  copied: string;
  quoteMessage: string;
  regenerate: string;
  regenerateResponse: string;
  followUpTitle: string;
  followUpSendNow: string;
  followUpSummary: (count: number) => string;
  /** The count with its reason, used where the drawer header has room. Default `1 queued, sends after this run`. */
  followUpSummaryExplained: (count: number) => string;
  /** The Send-now control's tooltip and accessible description. */
  followUpSendNowDescription: string;
  followUpEdit: (index: number) => string;
  followUpRemove: (index: number) => string;
  followUpRestore: string;
  followUpDismiss: string;
  followUpNotSent: string;
  followUpDiscardText: (count: number, reason: 'stopped' | 'failed') => string;
};

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
    `${name} can't be attached. Attach ${accepted}.`,
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
  approvalWaitingText: 'Waiting for your approval.',
  approvalQueueNote: 'Messages you send now wait until you decide.',
  reviewApproval: 'Review approval',
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

export function resolveChatLabels(labels: Partial<ChatLabels> | undefined): ChatLabels {
  return labels === undefined ? DEFAULT_CHAT_LABELS : { ...DEFAULT_CHAT_LABELS, ...labels };
}
