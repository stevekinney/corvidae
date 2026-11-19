/**
 * The identifier of one message the run page sends into a run in flight. The Bureau takes the
 * message's identifier as the input's, so sending the same message twice is one input; each message
 * the person writes is a new one (COR-2424, row 06b).
 */
export function newMessageIdentifier(): string {
  return `run-page-message-${crypto.randomUUID()}`;
}

/** Whether a run is one a person can still send a message into: a chat's run that is working. */
export function canSendMessage(task: {
  readonly kind: string;
  readonly status: string;
  readonly openWaits: readonly unknown[];
}): boolean {
  return task.kind === 'chat' && task.status === 'working' && task.openWaits.length === 0;
}
