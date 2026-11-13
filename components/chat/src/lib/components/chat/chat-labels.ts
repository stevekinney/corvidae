/** Host-overridable words used by the composer and approval drawer. */
export type ChatLabels = {
  sources: string;
  sourcesCount: (count: number) => string;
  openSource: (host?: string) => string;
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
  moreAttachments: (count: number) => string;
  retryAttachment: string;
  retryAttachmentAccessible: (name: string) => string;
  removeAttachment: string;
  removeAttachmentAccessible: (name: string) => string;
  uploadingFile: string;
  readingFile: string;
  uploadFailed: string;
  attachmentBlockingReason: (count: number) => string;
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
  sourcesCount: (count) => `Sources (${count})`,
  openSource: (host) => (host === undefined ? 'Open source' : `Open ${host}`),
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
  moreAttachments: (count) => `${count} more below`,
  retryAttachment: 'Retry',
  retryAttachmentAccessible: (name) => `Retry ${name}`,
  removeAttachment: 'Remove',
  removeAttachmentAccessible: (name) => `Remove ${name}`,
  uploadingFile: 'Uploading file',
  readingFile: 'Reading file',
  uploadFailed: 'Upload failed. Try again, or remove it.',
  attachmentBlockingReason: (count) =>
    count === 1 ? 'Retry or remove 1 file to send' : `Retry or remove ${count} files to send`,
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
