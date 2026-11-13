import type { AttentionItemState, ConnectionState } from '../types';

const KIND_LABELS: Record<string, readonly [singular: string, plural: string]> = {
  approval: ['approval', 'approvals'],
  'failed-check': ['failed check', 'failed checks'],
  'expired-claim': ['expired claim', 'expired claims'],
  handoff: ['handoff', 'handoffs'],
};

function secondsOf(milliseconds: number): number {
  return Math.max(1, Math.round(milliseconds / 1000));
}

/** Items still waiting for the person, oldest first. */
export function waitingOf(items: readonly AttentionItemState[]): AttentionItemState[] {
  return items
    .filter((item) => item.acknowledgedAt === null)
    .toSorted((left, right) => left.createdAt - right.createdAt);
}

export function labelOf(kind: string, count = 1): string {
  const labels = KIND_LABELS[kind] ?? [kind, kind];
  return count === 1 ? labels[0] : labels[1];
}

/** The band's one line, such as `Attention: 3 waiting (1 approval, 2 failed checks)`. */
export function summaryOf(waiting: readonly AttentionItemState[]): string {
  if (waiting.length === 0) return 'Attention: nothing waiting';
  const counts = new Map<string, number>();
  for (const item of waiting) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const parts = [...counts].map(([kind, count]) => `${count} ${labelOf(kind, count)}`);
  return `Attention: ${waiting.length} waiting (${parts.join(', ')})`;
}

/** A line for the status bar while something is wrong, or `undefined` while all is well. */
export function describeConnection(connection: ConnectionState): string | undefined {
  switch (connection.kind) {
    case 'connecting':
    case 'connected':
      return undefined;
    case 'not-running':
      return `the attention-queue service is not running; checking again in ${secondsOf(connection.retryInMs)}s`;
    case 'unreachable':
      return `the attention-queue service did not answer; retrying in ${secondsOf(connection.retryInMs)}s`;
    case 'unauthorized':
      return 'the service refused the token in its runtime file; restart the service';
    case 'incompatible':
      return `not connecting: ${connection.detail}`;
  }
}
